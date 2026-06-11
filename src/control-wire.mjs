// synod/src/control-wire.mjs — Control wiring (A3: nonce-free, agent-fence dispatch).
//
// Wires control-fence parsing + agent-fence dispatch at turn completion,
// composited with relay.  Replaces the old nonce-based control-marker +
// control-dispatch pipeline with the new nonce-free protocol.
//
// Exports:
//   wireControl({ sm, registry, stderr, dispatch })
//     → { onTurnComplete(label, result) }

import { extractFenceCommands } from "./control-fence.mjs";

/**
 * Wire control dispatch into the session manager, composing relay + control
 * into a single onTurnComplete callback.
 *
 * @param {object} deps
 * @param {object} deps.sm — session manager (_sessions for depth map queries)
 * @param {object} deps.registry — relay registry (.onTurnComplete)
 * @param {{ write(s: string): void }} deps.stderr
 * @param {function} deps.dispatch — agent-fence dispatch (from createReplDispatch)
 * @returns {{ onTurnComplete: (label: string, result: { text: string }) => Promise<void>, drainControl: () => Promise<void> }}
 */
export function wireControl({ sm, registry, stderr, dispatch }) {
  // Per-label depth tracking: when a session's turn produces a /open,
  // the child gets depth + 1.  Wire layer maintains this map; dispatch
  // receives depth as an input parameter.
  const _depthMap = new Map();
  const _inflight = new Set();         // P1-11: 在飞 fence dispatch,供退出前排水

  /**
   * Called after each turn completes.  Runs relay first (synchronous),
   * then processes any control fences in the turn text (fire-and-forget).
   *
   * @param {string} label — session label that produced this turn
   * @param {{ text: string }} result
   */
  async function onTurnComplete(label, result) {
    const text = result?.text ?? "";

    // 1. Relay — synchronous enqueue of forwarded messages
    registry.onTurnComplete(label, text);

    // 2. Control fence extraction + dispatch
    const { lines, warnings } = extractFenceCommands(text);

    // Log warnings from fence parsing (R1 gate failures, etc.)
    for (const w of warnings) {
      stderr.write(`[control warn] ${w.reason}\n`);
    }

    if (!lines.length) return;

    // Fire-and-forget: dispatch runs asynchronously, errors do not
    // propagate to the turn-completion caller.
    const task = (async () => {
      const depth = _depthMap.get(label) ?? 0;

      for (const line of lines) {
        let r;
        try {
          r = await dispatch(line, { source: "agent-fence", depth });
        } catch {
          // Dispatch itself should not throw (all rejections are returned
          // as {ok:false}), but guard against unexpected errors.
          continue;
        }

        if (r && r.ok && r.label) {
          // Child session created — record its depth
          _depthMap.set(r.label, depth + 1);
        } else if (r && !r.ok && r.reason) {
          stderr.write(`[control warn] ${r.reason}\n`);
        }
      }
    })();
    _inflight.add(task);
    task.catch(() => {}).finally(() => _inflight.delete(task));
  }

  // 退出前调用:等所有在飞 dispatch 落地(其新开会话因此对 closeAll 可见)。
  // B4:循环排到真正静默——一个在飞 dispatch 在 await 期间可能再触发新一轮 in-flight
  // (新 turn 完成 → onTurnComplete → 新 task),单次快照会漏掉这些后到的 task。
  async function drainControl() {
    while (_inflight.size) await Promise.allSettled([..._inflight]);
  }

  return {
    onTurnComplete,
    drainControl,
    /** P2-25:会话 /close 时清其 depth 记录。 */
    dropLabel(label) { _depthMap.delete(label); },
  };
}

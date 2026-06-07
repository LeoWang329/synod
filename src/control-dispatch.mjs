// synod/src/control-dispatch.mjs — Control command dispatcher + guardrails.
//
// Consumes parsed command objects from control-marker (B1) and dispatches
// them through the existing session-manager open/enqueue paths (R0), with
// per-command guardrail checks.
//
// ## Factory
//
//   createControlDispatch({ manager, guardrails, log, depth }) → dispatch
//
//   - manager: session-manager instance (or { open, enqueue, _sessions })
//   - guardrails: { maxSessions, maxDepth, allowedAgents, allowedModels, allowWrite }
//   - log: (entry) => void  — injectable report channel; entry = { level, reason, command }
//   - depth: current nesting depth (default 0)
//
// ## Return value
//
//   dispatch(commands) → Promise<{ dispatched, rejected }>
//
//   dispatched: [{ command, label? }]
//   rejected:   [{ command, reason }]
//
// ## Guardrails (checked per-command, before dispatch)
//
//   1. maxSessions  — reject open when manager._sessions.size >= maxSessions
//   2. maxDepth     — reject open when depth >= maxDepth
//   3. allowedAgents / allowedModels — reject open when cmd.agent/model not in whitelist
//   4. allowWrite   — reject open when cmd.write === true but allowWrite is false

/**
 * @param {object} opts
 * @param {{ open: Function, enqueue: Function, _sessions: Map }} opts.manager
 * @param {object} [opts.guardrails]
 * @param {number} [opts.guardrails.maxSessions] — max sessions; default Infinity
 * @param {number} [opts.guardrails.maxDepth] — max nesting depth; default Infinity
 * @param {string[]} [opts.guardrails.allowedAgents] — agent whitelist; null = allow all
 * @param {string[]} [opts.guardrails.allowedModels] — model whitelist; null = allow all
 * @param {boolean} [opts.guardrails.allowWrite] — permit write sessions; default false
 * @param {(entry: { level: string, reason: string, command: object }) => void} [opts.log]
 * @param {number} [opts.depth] — current depth; default 0
 * @returns {(commands: object[]) => Promise<{ dispatched: object[], rejected: object[] }>}
 */
export function createControlDispatch({ manager, guardrails = {}, log = () => {}, depth = 0 }) {
  const {
    maxSessions = Infinity,
    maxDepth = Infinity,
    allowedAgents = null,
    allowedModels = null,
    allowWrite = false,
  } = guardrails;

  /**
   * Dispatch an array of parsed control commands.
   *
   * @param {object[]} commands
   * @param {object} [opts]
   * @param {number} [opts.depth] — per-call depth override (for nested dispatch).
   *   If omitted, the constructor's static `depth` is used (default 0).
   *   The per-call value enables the wiring layer to pass the initiating
   *   session's current nesting depth so that maxDepth can clamp recursively.
   * @returns {Promise<{ dispatched: object[], rejected: object[] }>}
   */
  async function dispatch(commands, { depth: callDepth } = {}) {
    const effectiveDepth = callDepth !== undefined ? callDepth : depth;
    const dispatched = [];
    const rejected = [];

    for (const cmd of commands) {
      const rejection = _guard(cmd, effectiveDepth);
      if (rejection) {
        rejected.push({ command: cmd, reason: rejection });
        log({ level: "warn", reason: rejection, command: cmd });
        continue;
      }

      if (cmd.cmd === "open") {
        const label = await manager.open({
          agent: cmd.agent,
          model: cmd.model,
          write: cmd.write,
          announce: false,
        });

        if (label) {
          const enq = manager.enqueue({ target: label, msg: cmd.task });
          if (enq !== false && typeof enq?.catch === "function") {
            enq.catch((err) => {
              log({
                level: "error",
                reason: `enqueue failed for ${label}: ${err.message}`,
                command: cmd,
              });
            });
          }
          dispatched.push({ command: cmd, label });
        } else {
          const reason = `session open failed for agent '${cmd.agent}'`;
          rejected.push({ command: cmd, reason });
          log({ level: "error", reason, command: cmd });
        }
      } else if (cmd.cmd === "send") {
        const result = manager.enqueue({ target: cmd.to, msg: cmd.msg });
        if (result === false) {
          const reason = `target not found: ${cmd.to}`;
          rejected.push({ command: cmd, reason });
          log({ level: "error", reason, command: cmd });
        } else {
          dispatched.push({ command: cmd });
        }
      } else {
        const reason = `unknown command: ${cmd.cmd}`;
        rejected.push({ command: cmd, reason });
        log({ level: "error", reason, command: cmd });
      }
    }

    return { dispatched, rejected };
  }

  // ── Guardrail checks (returns reason string or null) ──────────────

  function _guard(cmd, effectiveDepth) {
    if (cmd.cmd !== "open") return null;

    if (manager._sessions.size >= maxSessions) {
      return `max sessions (${maxSessions}) reached`;
    }

    if (effectiveDepth >= maxDepth) {
      return `max depth (${maxDepth}) reached (current: ${effectiveDepth})`;
    }

    if (allowedAgents && !allowedAgents.includes(cmd.agent)) {
      return `agent '${cmd.agent}' not in whitelist`;
    }

    if (cmd.model && allowedModels && !allowedModels.includes(cmd.model)) {
      return `model '${cmd.model}' not in whitelist`;
    }

    if (cmd.write === true && !allowWrite) {
      return "write requested but allowWrite is false";
    }

    return null;
  }

  return dispatch;
}

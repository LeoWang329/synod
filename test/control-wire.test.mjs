// synod/test/control-wire.test.mjs — Tests for wireControl (A3: nonce-free, agent-fence dispatch).
//
// Covers:
// 1. onTurnComplete: relay runs first, then control (fire-and-forget)
// 2. extractFenceCommands produces lines → dispatch with source:"agent-fence"
// 3. depth map: child gets depth+1, grandchild blocked by maxDepth
// 4. warnings route to stderr
// 5. fire-and-forget: async reject does not crash
// 6. relay+control composited: both effects visible, no cross-contamination
// 7. empty turn (no lines, no relay matches) → silent

import { describe, it } from "node:test";
import assert from "node:assert";
import { wireControl } from "../src/control-wire.mjs";

// ── helpers ──────────────────────────────────────────────────────────────

function captureStream() {
  return { buf: "", write(s) { this.buf += s; } };
}

function fakeSm(opts = {}) {
  const _sessions = new Map(opts._sessions || []);
  const calls = { open: [], enqueue: [], use: [], list: 0 };
  let _currentLabel = opts.currentLabel || null;
  return {
    _sessions,
    get currentLabel() { return _currentLabel; },
    setCurrentLabel(l) { _currentLabel = l; },
    open: async (o) => {
      calls.open.push({ ...o });
      if (opts.openResult === undefined) return `${o.agent}#${opts.labelSuffix ?? 1}`;
      return opts.openResult;
    },
    enqueue: (o) => {
      calls.enqueue.push({ ...o });
      return opts.enqueueResult !== undefined ? opts.enqueueResult : true;
    },
    use: (target) => {
      calls.use.push(target);
      return opts.useResult !== undefined ? opts.useResult : true;
    },
    list: () => { calls.list++; },
    calls,
    _currentLabel,
  };
}

function fakeRegistry(opts = {}) {
  let relayTurnCompleteFn = null;
  const calls = { add: [], remove: [], list: 0 };
  return {
    add: (from, to) => { calls.add.push({ from, to }); },
    remove: (from, to) => { calls.remove.push({ from, to }); },
    list: () => { calls.list++; return opts.listResult || []; },
    onTurnComplete: (label, text) => {
      if (relayTurnCompleteFn) return relayTurnCompleteFn(label, text);
    },
    _setTurnComplete(fn) { relayTurnCompleteFn = fn; },
    calls,
  };
}

/** Fake dispatch that records calls and returns configured results. */
function fakeDispatch(resultMap = {}) {
  const calls = [];
  const fn = async (line, opts = {}) => {
    calls.push({ line, ...opts });
    const key = `${line}|${opts.depth ?? 0}`;
    if (resultMap[key]) return resultMap[key];
    return { ok: true };
  };
  fn.calls = calls;
  fn._resultMap = resultMap; // for tests to inspect mapped results
  return fn;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("wireControl onTurnComplete", () => {
  it("turn without fences → dispatch not called", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    await onTurnComplete("omp#1", { text: "hello world" });
    assert.strictEqual(dispatch.calls.length, 0);
    assert.strictEqual(stderr.buf, "");
  });

  it("turn with a fence line → dispatch called with source:agent-fence", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    const text = "```synod\n/open --agent omp\n```";
    await onTurnComplete("omp#1", { text });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(dispatch.calls.length, 1);
    assert.strictEqual(dispatch.calls[0].line, "/open --agent omp");
    assert.strictEqual(dispatch.calls[0].source, "agent-fence");
  });

  it("multiple fence lines → dispatch called for each, in order", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    const text = "```synod\n/open --agent omp\n@omp#2 hello\n```";
    await onTurnComplete("omp#1", { text });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(dispatch.calls.length, 2);
    assert.strictEqual(dispatch.calls[0].line, "/open --agent omp");
  });

  it("fence warnings route to stderr", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    // Body first line is prose → R1 gate fails → warning
    const text = "```synod\nnot a command\n```";
    await onTurnComplete("omp#1", { text });
    assert.ok(stderr.buf.includes("[control warn]"), `stderr should have warn, got: ${stderr.buf}`);
    assert.strictEqual(dispatch.calls.length, 0); // R1 blocked
  });
});

describe("wireControl depth map", () => {
  it("child of depth 0 gets depth 1 — proven by second round", async () => {
    // Round 1: omp#1 (depth 0) opens codex#1 → wire records depthMap["codex#1"] = 1
    // Round 2: codex#1 produces a fence → dispatch receives depth=1 (not 0)
    const sm = fakeSm({
      _sessions: [["omp#1", {}], ["codex#1", {}]],
    });
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch({
      "/open --agent codex|0": { ok: true, label: "codex#1" },
      "/open --agent omp|1":   { ok: true, label: "omp#2" },
    });
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });

    // Round 1: omp#1 → codex#1 (depth 0 → label stored, child depth 1)
    await onTurnComplete("omp#1", { text: "```synod\n/open --agent codex\n```" });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(dispatch.calls.length, 1);
    assert.strictEqual(dispatch.calls[0].depth, 0, "round 1 depth should be 0");

    dispatch.calls.length = 0;
    // Round 2: codex#1 → dispatch should receive depth=1 (not 0)
    await onTurnComplete("codex#1", { text: "```synod\n/open --agent omp\n```" });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(dispatch.calls.length, 1);
    assert.strictEqual(dispatch.calls[0].depth, 1, "codex#1 child should be depth 1");
  });

  it("grandchild blocked by maxDepth", async () => {
    // Setup: omp#1 (default session) is at depth 0.
    // Turn 1: omp#1 produces a fence → opens codex#1 (depth 1).
    // Turn 2: codex#1 produces a fence → opens omp#2 (depth 2).
    // Turn 3: omp#2 produces a fence → tries to open again → blocked.
    const sm = fakeSm({
      _sessions: [["omp#1", {}], ["codex#1", {}], ["omp#2", {}]],
    });
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch({
      "/open --agent codex|0": { ok: true, label: "codex#1" },
      "/open --agent omp|1":   { ok: true, label: "omp#2" },
      "/open --agent omp|2":   { ok: false, reason: "max depth reached" },
    });
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });

    // Turn 1: omp#1 (depth 0) → opens codex#1 (depth 1 stored)
    await onTurnComplete("omp#1", { text: "```synod\n/open --agent codex\n```" });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(dispatch.calls.length, 1);
    assert.strictEqual(dispatch.calls[0].depth, 0);
    assert.strictEqual(dispatch.calls[0].line, "/open --agent codex");

    dispatch.calls.length = 0;
    // Turn 2: codex#1 (depth 1) → opens omp#2 (depth 2 stored)
    await onTurnComplete("codex#1", { text: "```synod\n/open --agent omp\n```" });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(dispatch.calls.length, 1);
    assert.strictEqual(dispatch.calls[0].depth, 1);

    dispatch.calls.length = 0;
    // Turn 3: omp#2 (depth 2) → tries to open again → blocked
    await onTurnComplete("omp#2", { text: "```synod\n/open --agent omp\n```" });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(dispatch.calls.length, 1);
    assert.strictEqual(dispatch.calls[0].depth, 2);
    // dispatch returned {ok:false}, wire should log warning
    assert.ok(stderr.buf.includes("[control warn]"), `stderr: ${stderr.buf}`);
  });

  it("dropLabel 清 _depthMap → 该 label 再产 fence 时 depth 归 0(P2-25)", async () => {
    const sm = fakeSm({ _sessions: [["omp#1", {}], ["codex#1", {}]] });
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch({
      "/open --agent codex|0": { ok: true, label: "codex#1" },
      "/open --agent omp|1": { ok: true, label: "omp#2" },
      "/open --agent omp|0": { ok: true, label: "omp#3" },
    });
    const { onTurnComplete, dropLabel } = wireControl({ sm, registry, stderr, dispatch });

    await onTurnComplete("omp#1", { text: "```synod\n/open --agent codex\n```" });
    await new Promise((r) => setImmediate(r));
    dispatch.calls.length = 0;

    await onTurnComplete("codex#1", { text: "```synod\n/open --agent omp\n```" });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dispatch.calls[0].depth, 1, "清理前 codex#1 = depth1");

    dropLabel("codex#1");
    dispatch.calls.length = 0;
    await onTurnComplete("codex#1", { text: "```synod\n/open --agent omp\n```" });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dispatch.calls[0].depth, 0, "dropLabel 后 codex#1 回到 depth0(P2-25)");
  });
});

describe("wireControl relay+control compositing", () => {
  it("relay runs before control", async () => {
    const sm = fakeSm({
      _sessions: [["omp#1", {}], ["codex#1", {}]],
      currentLabel: "omp#1",
    });
    const registry = fakeRegistry();
    const stderr = captureStream();

    const order = [];
    const relayCalls = [];
    registry._setTurnComplete((label, text) => {
      order.push("relay");
      relayCalls.push({ label, text });
      sm.setCurrentLabel("codex#1");
    });

    // Wrap dispatch to record order
    const baseDispatch = fakeDispatch();
    const dispatch = async (line, opts) => {
      order.push("control");
      return baseDispatch(line, opts);
    };

    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    const text = "```synod\n@codex#1 hello\n```";
    await onTurnComplete("omp#1", { text });
    await new Promise(r => setImmediate(r)); // wait for fire-and-forget

    assert.deepStrictEqual(order, ["relay", "control"], "relay must run before control");
  });

  it("both relay and control effects visible", async () => {
    const sm = fakeSm({
      _sessions: [["omp#1", {}], ["codex#1", {}]],
    });
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const relayCalls = [];
    registry._setTurnComplete((label, text) => {
      relayCalls.push({ label, text });
    });

    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    const text = "```synod\n/open --agent codex\n```";
    await onTurnComplete("omp#1", { text });

    assert.strictEqual(relayCalls.length, 1, "relay should be called");
    assert.strictEqual(dispatch.calls.length, 1, "dispatch should be called");
  });
});

describe("wireControl fire-and-forget", () => {
  it("async reject in dispatch does not crash onTurnComplete", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const throwingDispatch = async () => { throw new Error("boom"); };
    throwingDispatch.calls = [];

    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch: throwingDispatch });
    const text = "```synod\n/open --agent omp\n```";
    // Must not throw
    await onTurnComplete("omp#1", { text });
    // No crash = pass
  });

  it("sync throw in dispatch does not crash onTurnComplete", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const throwingDispatch = () => { throw new Error("sync boom"); };
    throwingDispatch.calls = [];

    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch: throwingDispatch });
    const text = "```synod\n/open --agent omp\n```";
    // Must not throw
    await onTurnComplete("omp#1", { text });
  });
});

describe("wireControl empty/rejected paths", () => {
  it("empty lines from fence → silent", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    // just an opener+closer with no body lines
    const text = "```synod\n```";
    await onTurnComplete("omp#1", { text });
    assert.strictEqual(dispatch.calls.length, 0);
    assert.strictEqual(stderr.buf, "");
  });

  it("dispatch returns {ok:false} → reason logged to stderr", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch({
      "/open --write|0": { ok: false, reason: "write denied" },
    });
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    const text = "```synod\n/open --write\n```";
    await onTurnComplete("omp#1", { text });
    assert.ok(stderr.buf.includes("[control warn]"), `stderr should have warn: ${stderr.buf}`);
    assert.ok(stderr.buf.includes("write denied"), `stderr should include reason: ${stderr.buf}`);
  });

  it("result.text = null does not throw", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    await assert.doesNotReject(() => onTurnComplete("omp#1", { text: null }));
    assert.strictEqual(dispatch.calls.length, 0);
    assert.strictEqual(stderr.buf, "");
  });

  it("result.text = undefined does not throw", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    await assert.doesNotReject(() => onTurnComplete("omp#1", { text: undefined }));
    assert.strictEqual(dispatch.calls.length, 0);
    assert.strictEqual(stderr.buf, "");
  });

  it("result = {} (no text key) does not throw", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stderr = captureStream();
    const dispatch = fakeDispatch();
    const { onTurnComplete } = wireControl({ sm, registry, stderr, dispatch });
    await assert.doesNotReject(() => onTurnComplete("omp#1", {}));
    assert.strictEqual(dispatch.calls.length, 0);
    assert.strictEqual(stderr.buf, "");
  });
});

it("P1-11 drainControl() 等待在飞 fence dispatch 完成", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const dispatch = async () => { await gate; return { ok: true, label: "omp#2" }; };
  const sm = { _sessions: new Map() };
  const registry = { onTurnComplete() {} };
  const { onTurnComplete, drainControl } = wireControl({
    sm, registry, stderr: { write() {} }, dispatch,
  });
  await onTurnComplete("omp#1", { text: "```synod\n/open --agent omp\n```\n" });   // fire-and-forget 起飞
  let drained = false;
  const dp = drainControl().then(() => { drained = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drained, false, "dispatch 未完时 drainControl 不应 resolve");
  release();
  await dp;
  assert.equal(drained, true);
});

it("B4 drainControl 循环排到静默:在飞 dispatch 期间新增的 in-flight 也被等到", async () => {
  // 单快照 bug:drainControl 取一次 [..._inflight] 快照后,某个在飞 dispatch 在 await
  // 期间又触发新一轮 onTurnComplete(新 in-flight task),旧版会在第一批 settle 后提前
  // resolve、漏等新 task。循环版必须排到 _inflight 真正为空。
  let onTurnComplete, drainControl;
  let releaseSecond;
  const secondGate = new Promise((r) => { releaseSecond = r; });
  let secondStarted = false;
  let secondDone = false;

  let calls = 0;
  const dispatch = async () => {
    calls += 1;
    if (calls === 1) {
      // 让出一拍(drainControl 此时已对 [task1] 快照),再触发新一轮 → 产生 task2。
      await new Promise((r) => setTimeout(r, 5));
      onTurnComplete("omp#2", { text: "```synod\n/open --agent omp\n```\n" });
      return { ok: true };
    }
    secondStarted = true;
    await secondGate;          // task2 卡住,直到 releaseSecond()
    secondDone = true;
    return { ok: true };
  };

  const sm = { _sessions: new Map() };
  const registry = { onTurnComplete() {} };
  ({ onTurnComplete, drainControl } = wireControl({
    sm, registry, stderr: { write() {} }, dispatch,
  }));

  await onTurnComplete("omp#1", { text: "```synod\n/open --agent omp\n```\n" });
  // 此刻只有 task1 在飞(task2 尚未产生)。
  let drained = false;
  const dp = drainControl().then(() => { drained = true; });

  await new Promise((r) => setTimeout(r, 30));  // 等 task1 完成 + task2 起飞但仍卡 gate
  assert.equal(secondStarted, true, "task2 应已起飞");
  assert.equal(secondDone, false);
  assert.equal(drained, false, "task2 未完时 drainControl 不应 resolve(单快照 bug 会在此提前 resolve)");

  releaseSecond();
  await dp;
  assert.equal(drained, true);
  assert.equal(secondDone, true);
});

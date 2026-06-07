import { describe, it } from "node:test";
import assert from "node:assert";
import { createControlDispatch } from "../src/control-dispatch.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

/** Capture log calls for test assertions. */
function captureLog() {
  const calls = [];
  return {
    calls,
    log: (entry) => calls.push(entry),
  };
}

/**
 * Build a fake session-manager subset with configurable behavior.
 *
 * @param {object} [opts]
 * @param {Map} [opts.sessions] — initial session Map (for _sessions.size)
 * @param {string|null} [opts.openReturns] — label returned by open (null = failure)
 * @param {boolean|Promise|Function} [opts.enqueueReturns] — return value for enqueue
 * @returns {{ open: Function, enqueue: Function, _sessions: Map }}
 */
function makeFakeManager(opts = {}) {
  const sessions = opts.sessions ?? new Map();
  let _nextId = sessions.size;
  const openCalls = [];
  const enqueueCalls = [];

  return {
    _sessions: sessions,
    openCalls,
    enqueueCalls,
    open: async (callOpts) => {
      openCalls.push(callOpts);
      if (opts.openReturns !== undefined) return opts.openReturns;
      _nextId++;
      const label = `${callOpts.agent}#${_nextId}`;
      sessions.set(label, { agent: callOpts.agent });
      return label;
    },
    enqueue: (callOpts) => {
      enqueueCalls.push(callOpts);
      if (typeof opts.enqueueReturns === "function") return opts.enqueueReturns(callOpts);
      if (opts.enqueueReturns !== undefined) return opts.enqueueReturns;
      return true;
    },
  };
}

/** Create a dispatch with captured log + fake manager. */
function setup({ guardrails = {}, depth = 0, managerOpts = {} } = {}) {
  const { calls: logCalls, log } = captureLog();
  const manager = makeFakeManager(managerOpts);
  const dispatch = createControlDispatch({ manager, guardrails, log, depth });

  return {
    dispatch,
    manager,
    logCalls,
    openCalls: manager.openCalls,
    enqueueCalls: manager.enqueueCalls,
  };
}

// ── Basic dispatch ────────────────────────────────────────────────────

describe("createControlDispatch — basic dispatch", () => {

  it("open command calls manager.open then enqueues task to new label", async () => {
    const { dispatch, openCalls, enqueueCalls } = setup();

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "say hello" },
    ]);

    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched[0].command.cmd, "open");
    assert.ok(result.dispatched[0].label, "should have a label");

    // Assert manager.open was called correctly
    assert.strictEqual(openCalls.length, 1);
    assert.strictEqual(openCalls[0].agent, "omp");
    assert.strictEqual(openCalls[0].model, undefined);
    assert.strictEqual(openCalls[0].announce, false);

    // Assert manager.enqueue was called with the new label and task
    assert.strictEqual(enqueueCalls.length, 1);
    assert.strictEqual(enqueueCalls[0].target, result.dispatched[0].label);
    assert.strictEqual(enqueueCalls[0].msg, "say hello");
  });

  it("open command passes model and write through to manager.open", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowWrite: true },
    });

    await dispatch([
      { cmd: "open", agent: "codex", model: "gpt-4", task: "review code", write: true },
    ]);

    assert.strictEqual(openCalls.length, 1);
    assert.strictEqual(openCalls[0].agent, "codex");
    assert.strictEqual(openCalls[0].model, "gpt-4");
    assert.strictEqual(openCalls[0].write, true);
  });

  it("send command calls manager.enqueue with target and msg", async () => {
    const { dispatch, enqueueCalls, manager } = setup({
      managerOpts: { sessions: new Map([["omp#1", {}]]) },
    });

    const result = await dispatch([
      { cmd: "send", to: "omp#1", msg: "what next?" },
    ]);

    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(enqueueCalls.length, 1);
    assert.strictEqual(enqueueCalls[0].target, "omp#1");
    assert.strictEqual(enqueueCalls[0].msg, "what next?");
  });

  it("send to nonexistent target logs error but does not throw", async () => {
    const { dispatch, logCalls } = setup({
      managerOpts: { enqueueReturns: false },
    });

    const result = await dispatch([
      { cmd: "send", to: "nonexistent#1", msg: "ping" },
    ]);

    assert.strictEqual(result.dispatched.length, 0);
    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(result.rejected[0].reason, "target not found: nonexistent#1");

    // Logged the error — reason and command must match rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "error");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });

  it("send to nonexistent target continues processing subsequent commands", async () => {
    // First enqueue fails, second succeeds
    let callCount = 0;
    const manager = {
      _sessions: new Map(),
      openCalls: [],
      open: async (opts) => {
        manager.openCalls.push(opts);
        return `${opts.agent}#1`;
      },
      enqueueCalls: [],
      enqueue: (opts) => {
        manager.enqueueCalls.push(opts);
        callCount++;
        return callCount === 1 ? false : true; // first fails, second succeeds
      },
    };
    const { calls: logCalls, log } = captureLog();
    const dispatch = createControlDispatch({ manager, log });

    const result = await dispatch([
      { cmd: "send", to: "gone#1", msg: "first" },
      { cmd: "send", to: "omp#1", msg: "second" },
    ]);

    // First rejected
    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(result.rejected[0].reason, "target not found: gone#1");
    // Second dispatched
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(result.dispatched[0].command.msg, "second");
    // Both enqueue calls went out
    assert.strictEqual(manager.enqueueCalls.length, 2);
    // Only one error logged — reason/command match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "error");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });

  it("open enqueue is fire-and-forget — pending turn does not block subsequent commands", async () => {
    // First open's enqueue returns a controlled pending promise.
    // The dispatch loop must not await it — subsequent commands proceed.
    let resolveEnqueue;
    const pendingPromise = new Promise((resolve) => { resolveEnqueue = resolve; });

    const enqueueCalls = [];
    const sessions = new Map();
    const manager = {
      _sessions: sessions,
      openCalls: [],
      open: async (opts) => {
        manager.openCalls.push(opts);
        const label = `${opts.agent}#1`;
        sessions.set(label, { agent: opts.agent });
        return label;
      },
      enqueue: (opts) => {
        enqueueCalls.push(opts);
        if (opts.msg === "blocking?") return pendingPromise;
        return true;
      },
    };
    const { calls: logCalls, log } = captureLog();
    const dispatch = createControlDispatch({ manager, log });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "blocking?" },
      { cmd: "send", to: "codex#1", msg: "should not be blocked" },
    ]);

    // Both commands dispatched — dispatch didn't block on the pending turn
    assert.strictEqual(result.dispatched.length, 2);
    assert.strictEqual(result.dispatched[0].command.cmd, "open");
    assert.strictEqual(result.dispatched[1].command.cmd, "send");

    // Both enqueue calls went out, even though first is pending
    assert.strictEqual(enqueueCalls.length, 2);
    assert.strictEqual(enqueueCalls[0].msg, "blocking?");
    assert.strictEqual(enqueueCalls[1].msg, "should not be blocked");

    // No errors logged — the pending promise hasn't rejected
    assert.strictEqual(logCalls.length, 0);

    // Clean up: resolve the pending promise so test doesn't hang
    resolveEnqueue();
  });

  it("open enqueue rejection does not crash dispatch — error logged, subsequent commands continue", async () => {
    const enqueueCalls = [];
    const sessions = new Map();
    let rejectEnqueue;
    const rejectedPromise = new Promise((_, reject) => { rejectEnqueue = reject; });

    const manager = {
      _sessions: sessions,
      openCalls: [],
      open: async (opts) => {
        manager.openCalls.push(opts);
        const label = `${opts.agent}#1`;
        sessions.set(label, { agent: opts.agent });
        return label;
      },
      enqueue: (opts) => {
        enqueueCalls.push(opts);
        if (opts.msg === "will reject") return rejectedPromise;
        return true;
      },
    };
    const { calls: logCalls, log } = captureLog();
    const dispatch = createControlDispatch({ manager, log });

    // Must not throw/reject
    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "will reject" },
      { cmd: "send", to: "codex#1", msg: "should still work" },
    ]);

    // Both commands dispatched regardless
    assert.strictEqual(result.dispatched.length, 2);
    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(enqueueCalls.length, 2);

    // Trigger the rejection
    rejectEnqueue(new Error("boom"));
    // Let the microtask queue flush the .catch handler
    await new Promise((r) => setTimeout(r, 0));

    // Error logged for the rejection (via .catch handler)
    const errorLogs = logCalls.filter((c) => c.level === "error");
    assert.strictEqual(errorLogs.length, 1);
    assert.ok(errorLogs[0].reason.includes("enqueue failed"));
    assert.ok(errorLogs[0].reason.includes("boom"));
  });

  it("open failure (manager.open returns null) is rejected and logged", async () => {
    const { dispatch, logCalls, enqueueCalls } = setup({
      managerOpts: { openReturns: null },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "do thing" },
    ]);

    assert.strictEqual(result.dispatched.length, 0);
    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("session open failed"));

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "error");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);

    // No enqueue was attempted on failed open
    assert.strictEqual(enqueueCalls.length, 0);
  });

  it("empty commands array returns empty dispatched and rejected", async () => {
    const { dispatch } = setup();

    const result = await dispatch([]);

    assert.strictEqual(result.dispatched.length, 0);
    assert.strictEqual(result.rejected.length, 0);
  });
});

// ── Guardrail: maxSessions ────────────────────────────────────────────

describe("guardrail: maxSessions", () => {

  it("rejects open when session count equals maxSessions", async () => {
    const sessions = new Map([
      ["omp#1", {}],
      ["codex#1", {}],
    ]);
    const { dispatch, logCalls, openCalls } = setup({
      guardrails: { maxSessions: 2 },
      managerOpts: { sessions },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "new task" },
    ]);

    assert.strictEqual(result.dispatched.length, 0);
    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("max sessions (2) reached"));
    assert.strictEqual(openCalls.length, 0, "open must not be called");

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });

  it("rejects open when session count exceeds maxSessions", async () => {
    const sessions = new Map([
      ["omp#1", {}],
      ["omp#2", {}],
      ["codex#1", {}],
    ]);
    const { dispatch, openCalls } = setup({
      guardrails: { maxSessions: 2 },
      managerOpts: { sessions },
    });

    const result = await dispatch([
      { cmd: "open", agent: "codex", task: "overflow" },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(openCalls.length, 0);
  });

  it("allows open when under maxSessions", async () => {
    const sessions = new Map([["omp#1", {}]]); // 1 < 3
    const { dispatch, openCalls } = setup({
      guardrails: { maxSessions: 3 },
      managerOpts: { sessions },
    });

    const result = await dispatch([
      { cmd: "open", agent: "codex", task: "ok" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(openCalls.length, 1);
  });

  it("maxSessions guardrail does not affect send commands", async () => {
    const sessions = new Map([["omp#1", {}]]);
    const { dispatch, enqueueCalls } = setup({
      guardrails: { maxSessions: 0 },
      managerOpts: { sessions },
    });

    const result = await dispatch([
      { cmd: "send", to: "omp#1", msg: "hi" },
    ]);

    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(enqueueCalls.length, 1);
  });

  it("two opens with maxSessions:1 — first dispatched, second rejected at cap", async () => {
    const sessions = new Map(); // empty
    const { dispatch, openCalls, logCalls, manager } = setup({
      guardrails: { maxSessions: 1 },
      managerOpts: { sessions },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "first" },
      { cmd: "open", agent: "codex", task: "second" },
    ]);

    // First open dispatched (it creates session, count goes 0→1)
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(result.dispatched[0].command.task, "first");
    // Second open rejected (count is now 1, hits cap)
    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(result.rejected[0].command.task, "second");
    assert.ok(result.rejected[0].reason.includes("max sessions"));

    // Only first open was called
    assert.strictEqual(openCalls.length, 1);
    assert.strictEqual(openCalls[0].agent, "omp");
    // Session count reflects only the first
    assert.strictEqual(manager._sessions.size, 1);

    // Log points to the second (rejected) command
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });
});

// ── Guardrail: maxDepth ───────────────────────────────────────────────

describe("guardrail: maxDepth", () => {

  it("rejects open when depth equals maxDepth", async () => {
    const { dispatch, logCalls, openCalls } = setup({
      guardrails: { maxDepth: 2 },
      depth: 2,
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "deep" },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("max depth (2) reached"));
    assert.ok(result.rejected[0].reason.includes("current: 2"));
    assert.strictEqual(openCalls.length, 0);

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });

  it("rejects open when depth exceeds maxDepth", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { maxDepth: 1 },
      depth: 3,
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "too deep" },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(openCalls.length, 0);
  });

  it("allows open when depth is under maxDepth", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { maxDepth: 3 },
      depth: 0,
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "shallow" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(openCalls.length, 1);
  });

  it("maxDepth guardrail does not affect send commands", async () => {
    const { dispatch, enqueueCalls } = setup({
      guardrails: { maxDepth: 0 },
      depth: 10,
      managerOpts: { sessions: new Map([["omp#1", {}]]) },
    });

    const result = await dispatch([
      { cmd: "send", to: "omp#1", msg: "hi" },
    ]);

    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(enqueueCalls.length, 1);
  });
});

// ── Guardrail: allowedAgents ──────────────────────────────────────────

describe("guardrail: allowedAgents", () => {

  it("rejects open when agent not in whitelist", async () => {
    const { dispatch, logCalls, openCalls } = setup({
      guardrails: { allowedAgents: ["codex"] },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "hi" },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("agent 'omp' not in whitelist"));
    assert.strictEqual(openCalls.length, 0);

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });

  it("allows open when agent is in whitelist", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowedAgents: ["omp", "codex"] },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "ok" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(openCalls.length, 1);
  });

  it("allows any agent when allowedAgents is null", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowedAgents: null },
    });

    const result = await dispatch([
      { cmd: "open", agent: "any-agent", task: "hi" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
  });

  it("allowedAgents guardrail does not affect send commands", async () => {
    const { dispatch, enqueueCalls } = setup({
      guardrails: { allowedAgents: ["codex"] },
      managerOpts: { sessions: new Map([["omp#1", {}]]) },
    });

    const result = await dispatch([
      { cmd: "send", to: "omp#1", msg: "hi" },
    ]);

    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(enqueueCalls.length, 1);
  });
});

// ── Guardrail: allowedModels ──────────────────────────────────────────

describe("guardrail: allowedModels", () => {

  it("rejects open when model not in whitelist", async () => {
    const { dispatch, logCalls, openCalls } = setup({
      guardrails: { allowedModels: ["gpt-4"] },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", model: "claude-3", task: "hi" },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("model 'claude-3' not in whitelist"));
    assert.strictEqual(openCalls.length, 0);

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });

  it("allows open when model is in whitelist", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowedModels: ["gpt-4", "claude-3"] },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", model: "gpt-4", task: "ok" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(openCalls.length, 1);
  });

  it("allows open when model is not specified (no check)", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowedModels: ["gpt-4"] },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "no model specified" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(openCalls[0].model, undefined);
  });

  it("allows any model when allowedModels is null", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowedModels: null },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", model: "any-model", task: "hi" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
  });
});

// ── Guardrail: allowWrite (default read-only) ─────────────────────────

describe("guardrail: allowWrite", () => {

  it("rejects open when cmd.write is true and allowWrite is false (default)", async () => {
    const { dispatch, logCalls, openCalls } = setup({
      guardrails: { allowWrite: false },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "write file", write: true },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("write requested but allowWrite is false"));
    assert.strictEqual(openCalls.length, 0);

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });

  it("allows open when cmd.write is true and allowWrite is true", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowWrite: true },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "write file", write: true },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
    assert.strictEqual(openCalls.length, 1);
    assert.strictEqual(openCalls[0].write, true);
  });

  it("allows open when cmd.write is false regardless of allowWrite", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { allowWrite: false },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "readonly", write: false },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
  });

  it("allows open when cmd.write is undefined regardless of allowWrite", async () => {
    const { dispatch } = setup({
      guardrails: { allowWrite: false },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "default write" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 1);
  });

  it("default guardrails have allowWrite set to false", async () => {
    // When no guardrails are passed, allowWrite defaults to false.
    const { dispatch, logCalls } = setup({});

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "write", write: true },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("allowWrite is false"));

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });
});

// ── Mixed commands ────────────────────────────────────────────────────

describe("mixed command dispatch", () => {

  it("valid commands dispatch, rejected ones do not block remaining commands", async () => {
    const sessions = new Map([
      ["omp#1", {}],
      ["codex#1", {}],
    ]);
    const { dispatch, openCalls, enqueueCalls, logCalls } = setup({
      guardrails: { maxSessions: 3, allowedAgents: ["omp", "codex"] },
      managerOpts: {
        sessions,
        enqueueReturns: (callOpts) => callOpts.target !== "gone#1",
      },
    });

    const result = await dispatch([
      { cmd: "send", to: "omp#1", msg: "valid send" },
      { cmd: "open", agent: "forbidden", task: "should be rejected" }, // agent not in whitelist
      { cmd: "send", to: "gone#1", msg: "bad target" },                // enqueue returns false
      { cmd: "open", agent: "omp", task: "valid open" },
    ]);

    // 2 dispatched (valid send + valid open), 2 rejected
    assert.strictEqual(result.dispatched.length, 2);
    assert.strictEqual(result.rejected.length, 2);

    // Check dispatched entries
    const dispatchedCmds = result.dispatched.map((d) => d.command.cmd);
    assert.deepStrictEqual(dispatchedCmds, ["send", "open"]);

    // Check rejected reasons
    const rejectedReasons = result.rejected.map((r) => r.reason);
    assert.ok(rejectedReasons.some((r) => r.includes("not in whitelist")));
    assert.ok(rejectedReasons.some((r) => r.includes("target not found")));

    // All rejections were logged, in the same order
    assert.strictEqual(logCalls.length, 2);
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
    assert.strictEqual(logCalls[1].reason, result.rejected[1].reason);
    assert.strictEqual(logCalls[1].command, result.rejected[1].command);

    // The valid open actually called manager.open
    assert.strictEqual(openCalls.length, 1);
    assert.strictEqual(openCalls[0].agent, "omp");
    // Both sends + the valid open's task enqueue all went through
    assert.strictEqual(enqueueCalls.length, 3);
  });

  it("all commands rejected yields empty dispatched", async () => {
    const { dispatch } = setup({
      guardrails: { maxSessions: 0 },
    });

    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "a" },
      { cmd: "open", agent: "codex", task: "b" },
    ]);

    assert.strictEqual(result.dispatched.length, 0);
    assert.strictEqual(result.rejected.length, 2);
  });

  it("all commands valid yields empty rejected", async () => {
    const { dispatch } = setup();

    const result = await dispatch([
      { cmd: "send", to: "omp#1", msg: "a" },
      { cmd: "send", to: "codex#1", msg: "b" },
    ]);

    assert.strictEqual(result.rejected.length, 0);
    assert.strictEqual(result.dispatched.length, 2);
  });

  it("multiple guardrails on same command — first match wins", async () => {
    const sessions = new Map([
      ["omp#1", {}],
      ["omp#2", {}],
      ["omp#3", {}],
    ]);
    const { dispatch, logCalls } = setup({
      guardrails: { maxSessions: 3, allowedAgents: ["codex"] },
      managerOpts: { sessions },
      depth: 5,
    });

    // This command triggers maxSessions first, then would trigger depth,
    // then agent whitelist. Only the first should be reported.
    const result = await dispatch([
      { cmd: "open", agent: "omp", task: "multi-fail" },
    ]);

    assert.strictEqual(result.rejected.length, 1);
    assert.ok(result.rejected[0].reason.includes("max sessions"));

    // Log must match the rejected entry
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].level, "warn");
    assert.strictEqual(logCalls[0].reason, result.rejected[0].reason);
    assert.strictEqual(logCalls[0].command, result.rejected[0].command);
  });
});

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
 * Build a fake session-manager subset.
 * @param {object} [opts]
 * @param {Map} [opts.sessions] — initial session Map (for _sessions.size)
 * @param {string|null} [opts.openReturns] — label returned by open (null = failure)
 * @param {*} [opts.enqueueReturns] — return value for enqueue
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

  return { dispatch, manager, logCalls, openCalls: manager.openCalls, enqueueCalls: manager.enqueueCalls };
}

/** Build an array of open command objects. */
function openStorm(count, { agent = "omp", baseTask = "task", extras = [] } = {}) {
  const commands = [];
  for (let i = 0; i < count; i++) {
    const cmd = { cmd: "open", agent, task: `${baseTask} ${i}` };
    // Apply per-index extras (e.g., { 1: { write: true }, 4: { write: true } })
    const extra = extras[i];
    if (extra) Object.assign(cmd, extra);
    commands.push(cmd);
  }
  return commands;
}

// ═══════════════════════════════════════════════════════════════════════
// Safety: storm clamping at maxSessions
// ═══════════════════════════════════════════════════════════════════════

describe("safety — maxSessions storm", () => {
  it("clamps open storm at maxSessions limit (3 of 10)", async () => {
    const { dispatch, manager } = setup({
      guardrails: { maxSessions: 3 },
    });

    const commands = openStorm(10);
    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(
      dispatched.length,
      3,
      `expected 3 dispatched, got ${dispatched.length}`,
    );
    assert.strictEqual(
      rejected.length,
      7,
      `expected 7 rejected, got ${rejected.length}`,
    );

    // All rejected must have the max-sessions reason
    for (const r of rejected) {
      assert.match(
        r.reason,
        /max sessions/,
        `rejected reason must mention max sessions: ${r.reason}`,
      );
    }

    // Manager should have exactly 3 sessions opened
    assert.strictEqual(manager._sessions.size, 3);
  });

  it("clamps open storm at low limit (1 of 5)", async () => {
    const { dispatch, manager } = setup({
      guardrails: { maxSessions: 1 },
    });

    const commands = openStorm(5);
    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(rejected.length, 4);
    assert.strictEqual(manager._sessions.size, 1);
  });

  it("allows all opens when limit is high enough", async () => {
    const { dispatch, manager } = setup({
      guardrails: { maxSessions: 99 },
    });

    const commands = openStorm(5);
    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(dispatched.length, 5);
    assert.strictEqual(rejected.length, 0);
    assert.strictEqual(manager._sessions.size, 5);
  });

  it("never opens more than maxSessions even in extreme storm (50)", async () => {
    const { dispatch, manager } = setup({
      guardrails: { maxSessions: 4 },
    });

    const commands = openStorm(50);
    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(dispatched.length, 4);
    assert.strictEqual(rejected.length, 46);
    assert.strictEqual(manager._sessions.size, 4);
  });

  it("does not crash or throw during storm dispatch", async () => {
    const { dispatch } = setup({
      guardrails: { maxSessions: 2 },
    });

    // Must not throw — even synchronously
    const commands = openStorm(100);
    const result = await dispatch(commands);
    assert.ok(result, "dispatch must return a result object");
    assert.ok(Array.isArray(result.dispatched), "dispatched must be an array");
    assert.ok(Array.isArray(result.rejected), "rejected must be an array");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Safety: default read-only (allowWrite: false) rejects write:true opens
// ═══════════════════════════════════════════════════════════════════════

describe("safety — default read-only (allowWrite: false)", () => {
  it("rejects open commands with write:true when allowWrite is false", async () => {
    const { dispatch } = setup({
      guardrails: { allowWrite: false, maxSessions: 99 },
    });

    const commands = [
      { cmd: "open", agent: "omp", task: "read task 1" },
      { cmd: "open", agent: "omp", task: "write task", write: true },
      { cmd: "open", agent: "codex", task: "read task 2" },
      { cmd: "open", agent: "omp", task: "another write", write: true },
    ];

    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(
      dispatched.length,
      2,
      `expected 2 dispatched (reads), got ${dispatched.length}`,
    );
    assert.strictEqual(
      rejected.length,
      2,
      `expected 2 rejected (writes), got ${rejected.length}`,
    );

    for (const r of rejected) {
      assert.match(
        r.reason,
        /write/,
        `rejected reason must mention write: ${r.reason}`,
      );
    }
  });

  it("allows write:true opens when allowWrite is true", async () => {
    const { dispatch } = setup({
      guardrails: { allowWrite: true, maxSessions: 99 },
    });

    const commands = [
      { cmd: "open", agent: "omp", task: "write task", write: true },
    ];

    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(rejected.length, 0);
  });

  it("write:false and write:undefined pass through allowWrite:false", async () => {
    const { dispatch } = setup({
      guardrails: { allowWrite: false, maxSessions: 99 },
    });

    const commands = [
      { cmd: "open", agent: "omp", task: "explicit false", write: false },
      { cmd: "open", agent: "omp", task: "no write field" },
    ];

    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(dispatched.length, 2);
    assert.strictEqual(rejected.length, 0);
  });

  it("storm with mixed write:true — only writable ones rejected", async () => {
    const { dispatch } = setup({
      guardrails: { allowWrite: false, maxSessions: 99 },
    });

    // 5 read, 5 write
    const commands = openStorm(10, {
      extras: { 1: { write: true }, 3: { write: true }, 5: { write: true }, 7: { write: true }, 9: { write: true } },
    });

    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(dispatched.length, 5);
    assert.strictEqual(rejected.length, 5);

    for (const r of rejected) {
      assert.match(r.reason, /write/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Safety: maxDepth clamping
// ═══════════════════════════════════════════════════════════════════════

describe("safety — maxDepth clamping", () => {
  it("rejects open when depth >= maxDepth", async () => {
    const { dispatch } = setup({
      guardrails: { maxDepth: 2 },
      depth: 2,
    });

    const { dispatched, rejected } = await dispatch([
      { cmd: "open", agent: "omp", task: "nested too deep" },
    ]);

    assert.strictEqual(dispatched.length, 0);
    assert.strictEqual(rejected.length, 1);
    assert.match(rejected[0].reason, /max depth/);
  });

  it("allows open when depth < maxDepth", async () => {
    const { dispatch } = setup({
      guardrails: { maxDepth: 3 },
      depth: 2,
    });

    const { dispatched, rejected } = await dispatch([
      { cmd: "open", agent: "omp", task: "allowed depth" },
    ]);

    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(rejected.length, 0);
  });

  it("rejects open at maxDepth with no infinite loop", async () => {
    const { dispatch } = setup({
      guardrails: { maxDepth: 1 },
      depth: 1,
    });

    const commands = openStorm(5);
    const { dispatched, rejected } = await dispatch(commands);

    assert.strictEqual(dispatched.length, 0);
    assert.strictEqual(rejected.length, 5);
    for (const r of rejected) {
      assert.match(r.reason, /max depth/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Safety: combined guardrails — maxSessions + write rejection together
// ═══════════════════════════════════════════════════════════════════════

describe("safety — combined guardrails", () => {
  it("enforces both maxSessions and allowWrite in one storm", async () => {
    const { dispatch } = setup({
      guardrails: { maxSessions: 2, allowWrite: false },
    });

    // 6 commands: read, write, read, write, read, read
    const commands = [
      { cmd: "open", agent: "omp", task: "r1" },
      { cmd: "open", agent: "omp", task: "w1", write: true },
      { cmd: "open", agent: "omp", task: "r2" },
      { cmd: "open", agent: "omp", task: "w2", write: true },
      { cmd: "open", agent: "omp", task: "r3" },
      { cmd: "open", agent: "omp", task: "r4" },
    ];

    const { dispatched, rejected } = await dispatch(commands);

    // r1+r2 fill the 2 slots. w1 rejected for write (checked before slots fill).
    // w2 hits maxSessions first (size=2 already), so write check never reached.
    // r3, r4 also hit maxSessions.
    assert.strictEqual(dispatched.length, 2, `dispatched: ${JSON.stringify(dispatched.map(d => d.command.task))}`);

    const writeRejects = rejected.filter(r => /write/.test(r.reason));
    const sessionRejects = rejected.filter(r => /max sessions/.test(r.reason));

    assert.strictEqual(writeRejects.length, 1);
    assert.strictEqual(sessionRejects.length, 3);
    assert.strictEqual(rejected.length, 4);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Safety: per-call depth override
// ═══════════════════════════════════════════════════════════════════════

describe("safety — per-call depth override", () => {
  it("per-call depth overrides constructor depth for guard check", async () => {
    // Constructor depth=0, maxDepth=1 — would normally allow.
    // Per-call depth=1 should reject.
    const { dispatch } = setup({
      guardrails: { maxDepth: 1 },
      depth: 0,
    });

    const { dispatched, rejected } = await dispatch(
      [{ cmd: "open", agent: "omp", task: "nested" }],
      { depth: 1 },
    );

    assert.strictEqual(dispatched.length, 0);
    assert.strictEqual(rejected.length, 1);
    assert.match(rejected[0].reason, /max depth/);
  });

  it("per-call depth=0 allows when constructor depth would block", async () => {
    // Constructor depth=2, maxDepth=2 — would normally block.
    // Per-call depth=0 should allow.
    const { dispatch } = setup({
      guardrails: { maxDepth: 2 },
      depth: 2,
    });

    const { dispatched, rejected } = await dispatch(
      [{ cmd: "open", agent: "omp", task: "allowed" }],
      { depth: 0 },
    );

    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(rejected.length, 0);
  });

  it("omitting per-call depth uses constructor default", async () => {
    const { dispatch } = setup({
      guardrails: { maxDepth: 0 },
      depth: 0,
    });

    // No second arg — uses constructor depth=0, maxDepth=0 → rejected
    const { dispatched, rejected } = await dispatch([
      { cmd: "open", agent: "omp", task: "blocked" },
    ]);

    assert.strictEqual(dispatched.length, 0);
    assert.strictEqual(rejected.length, 1);
    assert.match(rejected[0].reason, /max depth/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Safety: omitted allowWrite defaults to false
// ═══════════════════════════════════════════════════════════════════════

describe("safety — omitted allowWrite defaults to false", () => {
  it("rejects write:true when allowWrite is omitted from guardrails", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: { maxSessions: 99 },
      // allowWrite NOT set — should default to false
    });

    const { dispatched, rejected } = await dispatch([
      { cmd: "open", agent: "omp", task: "read ok" },
      { cmd: "open", agent: "omp", task: "write blocked", write: true },
    ]);

    assert.strictEqual(dispatched.length, 1, "only read should dispatch");
    assert.strictEqual(rejected.length, 1, "write should be rejected");
    assert.match(rejected[0].reason, /write/);
    assert.strictEqual(openCalls.length, 1, "only one open call");
  });

  it("read-only default is in effect when guardrails is empty", async () => {
    const { dispatch, openCalls } = setup({
      guardrails: {},
    });

    const { dispatched, rejected } = await dispatch([
      { cmd: "open", agent: "omp", task: "write attempt", write: true },
    ]);

    assert.strictEqual(dispatched.length, 0);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(openCalls.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Safety: maxDepth integration via real wireControl
// ═══════════════════════════════════════════════════════════════════════

describe("safety — maxDepth integration (wireControl)", () => {
  it("maxDepth=1 stops grandchild (parent depth 0 → child depth 1 → grandchild blocked)", async () => {
    // Deferred imports to avoid circular issues at module load time.
    const { wireControl } = await import("../src/control-wire.mjs");
    const { createRelayRegistry } = await import("../src/relay.mjs");
    const { createSessionManager } = await import("../src/session-manager.mjs");
    const { fakeOpenBackend } = await import("./helpers/fake-backend.mjs");

    function captureStream() {
      return { buf: "", write(s) { this.buf += s; } };
    }

    function controlTurn(nonce, commands) {
      const body = commands.map((c) => JSON.stringify(c)).join("\n");
      return "```synod " + nonce + "\n" + body + "\n```";
    }

    const NONCE = "depth-integration-test";
    const FAKE_REPORT = { omp: { available: true }, codex: { available: true } };

    const stderr = captureStream();
    const stdout = captureStream();

    let _cb = null;
    const registry = createRelayRegistry(() => {});

    const sm = createSessionManager({
      openBackend: (opts) => fakeOpenBackend({ agent: opts.agent, deltas: ["ok"], text: "ok" }),
      stdout, stderr,
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => { if (_cb) _cb(label, result); },
    });

    const { onTurnComplete } = wireControl({
      sm, registry, stderr, nonce: NONCE,
      guardrails: { maxDepth: 1, maxSessions: 99 },
    });
    _cb = onTurnComplete;

    // Open root session manually (depth 0, not tracked by control dispatch)
    await sm.open({ agent: "omp" });
    assert.strictEqual(sm._sessions.size, 1, "root session open");

    // Root turn: emits fence to open child (depth 0, allowed by maxDepth=1)
    onTurnComplete("omp#1", {
      text: controlTurn(NONCE, [{ cmd: "open", agent: "omp", task: "child work" }]),
    });
    // Yield to let dispatch promise resolve (fire-and-forget in channel)
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(sm._sessions.size, 2, "child should be opened (depth 0->1)");
    const childLabel = [...sm._sessions.keys()].find((l) => l !== "omp#1");
    assert.ok(childLabel, "child label should exist");
    assert.strictEqual(childLabel, "omp#2", "child should be omp#2");

    // Child turn: emits fence to open grandchild (depth 1, blocked by maxDepth=1)
    onTurnComplete(childLabel, {
      text: controlTurn(NONCE, [{ cmd: "open", agent: "omp", task: "grandchild work" }]),
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(
      sm._sessions.size,
      2,
      "grandchild must NOT be opened (depth 1 >= maxDepth 1)",
    );
    assert.ok(
      stderr.buf.includes("max depth"),
      `stderr must contain max depth rejection: "${stderr.buf}"`,
    );

    sm.closeAll();
  });
});

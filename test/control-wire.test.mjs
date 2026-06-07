import { describe, it } from "node:test";
import assert from "node:assert";
import { createControlChannel, wireControl } from "../src/control-wire.mjs";
import { createControlDispatch } from "../src/control-dispatch.mjs";
import { createSessionManager } from "../src/session-manager.mjs";
import { createRelayRegistry } from "../src/relay.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

function captureStream() {
  return { buf: "", write(s) { this.buf += s; } };
}

const FAKE_REPORT = { omp: { available: true }, codex: { available: true } };

function makeOpenBackend(sessionOpts = {}) {
  return (opts) => fakeOpenBackend({ ...sessionOpts, ...opts });
}

function controlTurn(nonce, commands) {
  const body = commands.map((c) => JSON.stringify(c)).join("\n");
  return `\`\`\`synod ${nonce}\n${body}\n\`\`\``;
}

function proseTurn(nonce, commands, prose = "Task result.") {
  return `${prose}\n\n${controlTurn(nonce, commands)}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Unit: createControlChannel — basic contract + error resilience
// ═══════════════════════════════════════════════════════════════════════

describe("createControlChannel", () => {

  // ── Nonce ──────────────────────────────────────────────────────────

  it("generates a unique nonce per instance", () => {
    const a = createControlChannel({ dispatch: async () => {} });
    const b = createControlChannel({ dispatch: async () => {} });
    assert.ok(a.nonce);
    assert.ok(b.nonce);
    assert.notStrictEqual(a.nonce, b.nonce);
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a.nonce));
  });

  it("uses provided nonce", () => {
    const ch = createControlChannel({ dispatch: async () => {}, nonce: "my-nonce" });
    assert.strictEqual(ch.nonce, "my-nonce");
  });

  // ── Basic extract + dispatch ───────────────────────────────────────

  it("extracts and dispatches commands with correct nonce", async () => {
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const ch = createControlChannel({ dispatch, nonce: "nc" });

    ch.onTurnComplete("x", controlTurn("nc", [{ cmd: "send", to: "y", msg: "hi" }]));
    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(dispatched.length, 1);
    assert.deepStrictEqual(dispatched[0], { cmd: "send", to: "y", msg: "hi" });
  });

  it("does not dispatch with wrong nonce", async () => {
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const ch = createControlChannel({ dispatch, nonce: "real" });

    ch.onTurnComplete("x", controlTurn("wrong", [{ cmd: "send", to: "y", msg: "hi" }]));
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(dispatched.length, 0);
  });

  it("does not dispatch on empty/null turn text", () => {
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const ch = createControlChannel({ dispatch, nonce: "nc" });

    assert.doesNotThrow(() => ch.onTurnComplete("x", ""));
    assert.doesNotThrow(() => ch.onTurnComplete("x", null));
    assert.doesNotThrow(() => ch.onTurnComplete("x", undefined));
    assert.strictEqual(dispatched.length, 0);
  });

  it("does not dispatch from unclosed fence", async () => {
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const ch = createControlChannel({ dispatch, nonce: "nc" });

    ch.onTurnComplete("x", '```synod nc\n{"cmd":"send","to":"y","msg":"hi"}\nno closer');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(dispatched.length, 0);
  });

  it("reports parse warnings via onWarnings", async () => {
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const warns = [];
    const ch = createControlChannel({
      dispatch, nonce: "nc",
      onWarnings: (label, w) => warns.push({ label, w }),
    });

    const text = [
      '```synod nc',
      '{"cmd":"send","to":"y","msg":"ok"}',
      '{bad json}',
      '```',
    ].join("\n");
    ch.onTurnComplete("s1", text);
    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0].label, "s1");
    assert.ok(warns[0].w[0].reason.includes("invalid JSON") || warns[0].w[0].reason.includes("JSON"));
  });

  // ── Error resilience ───────────────────────────────────────────────

  it("onTurnComplete does not throw when dispatch throws synchronously", () => {
    const dispatch = () => { throw new Error("sync boom"); };
    const ch = createControlChannel({ dispatch, nonce: "nc" });

    assert.doesNotThrow(() =>
      ch.onTurnComplete("x", controlTurn("nc", [{ cmd: "open", agent: "omp", task: "x" }]))
    );
  });

  it("onTurnComplete swallows rejecting promise (no unhandledRejection)", async () => {
    const dispatch = async () => { throw new Error("async boom"); };
    const ch = createControlChannel({ dispatch, nonce: "nc" });

    assert.doesNotThrow(() =>
      ch.onTurnComplete("x", controlTurn("nc", [{ cmd: "open", agent: "omp", task: "x" }]))
    );
    await new Promise((r) => setTimeout(r, 10));
    // No unhandledRejection → test passes
  });

  it("onTurnComplete returns immediately when dispatch never resolves", () => {
    const dispatch = () => new Promise(() => {}); // never settles
    const ch = createControlChannel({ dispatch, nonce: "nc" });

    const start = Date.now();
    ch.onTurnComplete("x", controlTurn("nc", [{ cmd: "open", agent: "omp", task: "x" }]));
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5, `onTurnComplete must return immediately, took ${elapsed}ms`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Turn granularity — true integration via createSessionManager
// ═══════════════════════════════════════════════════════════════════════

describe("turn granularity (true integration)", () => {

  it("bare delta / event / status:idle do NOT trigger control dispatch", async () => {
    const nonce = "nc-gran";
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const channel = createControlChannel({ dispatch, nonce });

    const openBackend = makeOpenBackend({ deltas: ["hello"], text: "hello" });
    const sm = createSessionManager({
      openBackend, stdout: captureStream(), stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => channel.onTurnComplete(label, result.text),
    });

    await sm.open({ agent: "omp" });
    const session = sm._sessions.get("omp#1").session;

    // Bare deltas — should not trigger dispatch
    session.emit("delta", "```synod ");
    session.emit("delta", `${nonce}`);
    session.emit("delta", '\n{"cmd":"open","agent":"codex","task":"x"}\n```');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(dispatched.length, 0, "bare deltas must not trigger dispatch");

    // message_update event — should not trigger
    session.emit("event", { type: "message_update", message: { type: "text_delta", delta: "more" } });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(dispatched.length, 0, "events must not trigger dispatch");

    // Bare status:idle — should not trigger
    session.emit("status", { status: "idle", isStreaming: false });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(dispatched.length, 0, "bare status:idle must not trigger dispatch");
  });

  it("real sm.enqueue turn with control fence dispatches exactly once", async () => {
    const nonce = "nc-real-turn";
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const channel = createControlChannel({ dispatch, nonce });

    const fence = controlTurn(nonce, [{ cmd: "send", to: "codex#1", msg: "ping" }]);
    const openBackend = makeOpenBackend({ deltas: [fence], text: fence });
    const sm = createSessionManager({
      openBackend, stdout: captureStream(), stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => channel.onTurnComplete(label, result.text),
    });

    await sm.open({ agent: "omp" });

    // Real turn via sm.enqueue → sendQueue → session.send() → result()
    await sm.enqueue({ target: "omp#1", msg: "trigger" });

    assert.strictEqual(dispatched.length, 1,
      "real turn completion should trigger dispatch exactly once");
    assert.deepStrictEqual(dispatched[0], { cmd: "send", to: "codex#1", msg: "ping" });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Relay + Control combo — true integration via real sm + registry + channel
// ═══════════════════════════════════════════════════════════════════════

describe("relay + control combo (true integration)", () => {

  it("A→B relay + control fence in A's turn: B receives text, control dispatches", async () => {
    const nonce = "nc-combo-int";

    // ── Registry with placeholder enqueue ────────────────────────────
    let smRef = null;
    const relayFwd = [];
    const registry = createRelayRegistry((to, msg) => {
      relayFwd.push({ to, msg });
      if (smRef) smRef.enqueue({ target: to, msg });
    });

    // ── Control channel ──────────────────────────────────────────────
    const dispatched = [];
    const dispatch = async (cmds) => { dispatched.push(...cmds); return { dispatched: [], rejected: [] }; };
    const channel = createControlChannel({ dispatch, nonce });

    // ── Compose: relay first, then control (cli.mjs pattern) ────────
    function composedOnTurnComplete(label, result) {
      registry.onTurnComplete(label, result.text);
      channel.onTurnComplete(label, result.text);
    }

    // ── Build sm with two fake backends ──────────────────────────────
    const openBackendA = makeOpenBackend({
      deltas: [proseTurn(nonce, [{ cmd: "send", to: "codex#1", msg: "control-msg" }])],
    });
    const openBackendB = makeOpenBackend({ deltas: ["ok"], text: "ok" });
    const openBackend = (opts) => opts.agent === "omp" ? openBackendA(opts) : openBackendB(opts);

    const sm = createSessionManager({
      openBackend, stdout: captureStream(), stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: composedOnTurnComplete,
    });
    smRef = sm;

    await sm.open({ agent: "omp" });   // A = omp#1
    await sm.open({ agent: "codex", announce: false }); // B = codex#1
    registry.add("omp#1", "codex#1");

    // ── Trigger A's real turn ───────────────────────────────────────
    await sm.enqueue({ target: "omp#1", msg: "trigger A" });
    await sm.drainAll();

    // ── Assert relay forwarded to B ─────────────────────────────────
    assert.strictEqual(relayFwd.length, 1, "relay should forward exactly once");
    assert.ok(relayFwd[0].msg.includes("Task result."),
      "B should receive A's complete turn text");
    assert.ok(relayFwd[0].msg.includes("[relay from omp#1]"),
      "B's message should have source attribution");

    // ── Assert control dispatched ───────────────────────────────────
    assert.strictEqual(dispatched.length, 1,
      "control should dispatch exactly once");
    assert.deepStrictEqual(dispatched[0], {
      cmd: "send", to: "codex#1", msg: "control-msg",
    });

    // ── Cross-interference assertions ───────────────────────────────
    assert.strictEqual(relayFwd.length, 1,
      "control dispatch must not trigger additional relay forwards");
    assert.ok(relayFwd[0].msg.includes("```synod"),
      "relay should forward raw control fence text (relay doesn't filter it)");
  });

  it("composed callback: relay called before control", async () => {
    const callOrder = [];
    const registry = { onTurnComplete: () => callOrder.push("relay") };
    const dispatch = async () => { callOrder.push("control"); return { dispatched: [], rejected: [] }; };
    const channel = createControlChannel({ dispatch, nonce: "nc" });

    function composed(label, result) {
      registry.onTurnComplete(label, result.text);
      channel.onTurnComplete(label, result.text);
    }

    composed("x", { text: controlTurn("nc", [{ cmd: "send", to: "y", msg: "hi" }]) });
    await new Promise((r) => setTimeout(r, 0));

    assert.deepStrictEqual(callOrder, ["relay", "control"],
      "relay must fire before control dispatch");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Output routing — triggered through real sm.enqueue
// ═══════════════════════════════════════════════════════════════════════

describe("output routing (true trigger via sm.enqueue)", () => {

  it("parent turn with control open → child output goes to stdout, parent not auto-fed", async () => {
    const nonce = "nc-route";
    const logs = [];

    const openBackend = (opts) => fakeOpenBackend({
      ...opts,
      deltas: opts.agent === "codex"
        ? ["child result"]
        : [controlTurn(nonce, [{ cmd: "open", agent: "codex", task: "child task" }])],
      text: opts.agent === "codex"
        ? "child result"
        : controlTurn(nonce, [{ cmd: "open", agent: "codex", task: "child task" }]),
    });

    // ── Two-phase: placeholder → real dispatch ─────────────────────
    let _chRef = null;
    const out = captureStream();
    const err = captureStream();

    const sm = createSessionManager({
      openBackend,
      stdout: out, stderr: err,
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => {
        if (_chRef) _chRef.onTurnComplete(label, result.text);
      },
    });

    const dispatch = createControlDispatch({
      manager: sm,
      guardrails: { maxSessions: 10, maxDepth: 3, allowWrite: false },
      log: (e) => logs.push(e),
    });
    _chRef = createControlChannel({ dispatch, nonce });

    // Open parent
    await sm.open({ agent: "omp" }); // omp#1

    // Trigger parent's real turn — it outputs a control fence with open command
    await sm.enqueue({ target: "omp#1", msg: "trigger parent" });

    // Dispatch is fire-and-forget from onTurnComplete.  Wait for it to finish
    // opening the child session before draining.
    await new Promise((r) => setTimeout(r, 30));
    // Drain — child gets opened, enqueued, and completes
    await sm.drainAll();
    sm.flushAll();

    // ── Assert: child session was created ───────────────────────────
    assert.ok(sm._sessions.has("codex#1"), "child session should be open");

    // ── Assert: child output went to stdout (human) ─────────────────
    assert.ok(out.buf.includes("child result"),
      `child output should appear on stdout, got: "${out.buf}"`);

    // ── Assert: parent not auto-fed child output ────────────────────
    const parentSession = sm._sessions.get("omp#1").session;
    const feedback = parentSession._sentMessages.filter((m) =>
      m.message && m.message.includes("child result"));
    assert.strictEqual(feedback.length, 0,
      `parent should not receive child output automatically, got ${feedback.length} feedback messages`);

    sm.closeAll();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// wireControl helper — CLI integration + default guardrail lock
// ═══════════════════════════════════════════════════════════════════════

describe("wireControl helper", () => {

  it("returns composed onTurnComplete + nonce; relay fires before control", async () => {
    const stderr = captureStream();
    const relayFwd = [];

    let _sm = null;
    const registry = createRelayRegistry((to, msg) => {
      relayFwd.push({ to, msg });
      if (_sm) _sm.enqueue({ target: to, msg });
    });

    let _cb = null;
    const sm = createSessionManager({
      openBackend: makeOpenBackend({ deltas: ["ok"], text: "ok" }),
      stdout: captureStream(), stderr,
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => { if (_cb) _cb(label, result); },
    });
    _sm = sm;

    const { onTurnComplete, nonce } = wireControl({ sm, registry, stderr });
    _cb = onTurnComplete;

    // Verify nonce is returned and looks like a UUID
    assert.ok(nonce, "wireControl should return nonce");
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(nonce));

    // Open sessions and add relay
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: false });
    registry.add("omp#1", "codex#1");

    // Build a turn text with a control fence using the real nonce
    const turnText = controlTurn(nonce, [{ cmd: "send", to: "codex#1", msg: "ping" }]);

    // Call the composed callback (simulating what sm does at turn completion)
    onTurnComplete("omp#1", { text: turnText });
    await new Promise((r) => setTimeout(r, 0));

    // Relay forwarded
    assert.strictEqual(relayFwd.length, 1, "relay should forward");
    assert.ok(relayFwd[0].msg.includes("[relay from omp#1]"));

    sm.closeAll();
  });

  it("default guardrails reject write:true open command", async () => {
    const stderr = captureStream();

    let _sm = null;
    const registry = createRelayRegistry(() => {});

    let _cb = null;
    const sm = createSessionManager({
      openBackend: makeOpenBackend({ deltas: ["ok"], text: "ok" }),
      stdout: captureStream(), stderr,
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => { if (_cb) _cb(label, result); },
    });
    _sm = sm;

    // Use wireControl with a known nonce for testability
    const nonce = "test-write-reject";
    const { onTurnComplete } = wireControl({ sm, registry, stderr, nonce });
    _cb = onTurnComplete;

    await sm.open({ agent: "omp" });

    // Build a control fence with write:true — should be rejected by default allowWrite:false
    const turnText = controlTurn(nonce, [
      { cmd: "open", agent: "codex", task: "write stuff", write: true },
    ]);

    onTurnComplete("omp#1", { text: turnText });
    await new Promise((r) => setTimeout(r, 10));

    // Assert: stderr contains the rejection
    assert.ok(stderr.buf.includes("[control warn]"),
      `stderr should contain rejection, got: "${stderr.buf}"`);
    assert.ok(stderr.buf.includes("allowWrite"),
      `stderr should mention allowWrite, got: "${stderr.buf}"`);

    // Assert: no new session was opened
    assert.strictEqual(sm._sessions.size, 1, "write session should not be opened");

    sm.closeAll();
  });

  it("wireControl returns a callable onTurnComplete that does not throw", () => {
    const sm = {
      open: async () => "test#1",
      enqueue: () => Promise.resolve(),
      _sessions: new Map(),
    };
    const registry = createRelayRegistry(() => {});
    const stderr = captureStream();

    const { onTurnComplete, nonce } = wireControl({ sm, registry, stderr });

    assert.ok(nonce);

    assert.doesNotThrow(() =>
      onTurnComplete("test#1", { text: "some turn output" })
    );
    assert.doesNotThrow(() =>
      onTurnComplete("test#1", { text: null })
    );
  });
});

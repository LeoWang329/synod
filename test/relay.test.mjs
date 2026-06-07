import { describe, it } from "node:test";
import assert from "node:assert";
import { createRelayRegistry } from "../src/relay.mjs";
import { createSessionManager } from "../src/session-manager.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

function captureStream() {
  return { buf: "", write(s) { this.buf += s; } };
}

const FAKE_REPORT = { omp: { available: true }, codex: { available: true } };

function makeOpenBackend(sessionOpts = {}) {
  return (opts) => fakeOpenBackend({ ...sessionOpts, ...opts });
}

// ── Registry tests ────────────────────────────────────────────────────

describe("createRelayRegistry", () => {

  // ── add / remove / list ───────────────────────────────────────────

  it("add and list relay rules", () => {
    const fwd = [];
    const relay = createRelayRegistry((to, msg) => fwd.push({ to, msg }));

    relay.add("omp", "codex");
    assert.deepStrictEqual(relay.list(), [{ from: "omp", to: "codex" }]);

    relay.add("omp", "claude");
    const list = relay.list();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some((r) => r.from === "omp" && r.to === "claude"));
  });

  it("remove a relay rule", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("a", "b");
    relay.add("a", "c");
    relay.remove("a", "b");
    assert.deepStrictEqual(relay.list(), [{ from: "a", to: "c" }]);
  });

  it("remove non-existent rule does not throw", () => {
    const relay = createRelayRegistry(() => {});
    relay.remove("x", "y"); // no-op
  });

  it("list returns empty for empty registry", () => {
    const relay = createRelayRegistry(() => {});
    assert.deepStrictEqual(relay.list(), []);
  });

  // ── cycle detection ───────────────────────────────────────────────

  it("rejects self-reference on add", () => {
    const relay = createRelayRegistry(() => {});
    assert.throws(() => relay.add("omp", "omp"), /cannot relay to self/);
  });

  it("rejects duplicate rule", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("a", "b");
    assert.throws(() => relay.add("a", "b"), /already exists/);
  });

  it("rejects A->B + B->A (direct cycle)", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("a", "b");
    assert.throws(() => relay.add("b", "a"), /would create a cycle/);
  });

  it("rejects A->B + B->C + C->A (indirect cycle)", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("a", "b");
    relay.add("b", "c");
    assert.throws(() => relay.add("c", "a"), /would create a cycle/);
  });

  // ── forwarding: onTurnComplete ─────────────────────────────────────

  it("forwards turn text to target with source attribution", () => {
    const fwd = [];
    const relay = createRelayRegistry((to, msg) => fwd.push({ to, msg }));
    relay.add("omp", "codex");

    relay.onTurnComplete("omp", "Task result text");

    assert.strictEqual(fwd.length, 1);
    assert.strictEqual(fwd[0].to, "codex");
    assert.ok(fwd[0].msg.includes("[relay from omp]"), "should include source attribution");
    assert.ok(fwd[0].msg.includes("Task result text"), "should include turn text");
  });

  it("does not forward when source has no rules", () => {
    const fwd = [];
    const relay = createRelayRegistry((to, msg) => fwd.push({ to, msg }));

    relay.onTurnComplete("omp", "text");

    assert.strictEqual(fwd.length, 0);
  });

  it("forwards to multiple targets", () => {
    const fwd = [];
    const relay = createRelayRegistry((to, msg) => fwd.push({ to, msg }));
    relay.add("omp", "codex");
    relay.add("omp", "claude");

    relay.onTurnComplete("omp", "multi-target text");

    assert.strictEqual(fwd.length, 2);
    assert.strictEqual(fwd[0].to, "codex");
    assert.strictEqual(fwd[1].to, "claude");
    assert.ok(fwd[0].msg.includes("multi-target text"));
    assert.ok(fwd[1].msg.includes("multi-target text"));
  });

  // ── Echo prevention ────────────────────────────────────────────────

  it("directional relay does not auto-create reverse", () => {
    const fwd = [];
    const relay = createRelayRegistry((to, msg) => fwd.push({ to, msg }));
    relay.add("omp", "codex");

    // Turn completion on codex should NOT forward to omp
    relay.onTurnComplete("codex", "codex output");

    assert.strictEqual(fwd.length, 0, "reverse relay should not trigger unless explicitly added");
  });

  // ── Integration: onTurnComplete with session-manager ───────────────

  it("onTurnComplete fires on real turn completion, not on bare status idle", async () => {
    const turnCompletions = [];
    const { sm } = (() => {
      const stdout = captureStream();
      const stderr = captureStream();
      const openBackend = makeOpenBackend({ deltas: ["result ok"], text: "result ok" });
      const sm = createSessionManager({
        openBackend, stdout, stderr,
        report: FAKE_REPORT, cwd: "/test", defaults: {},
        onTurnComplete: (label, result) => turnCompletions.push({ label, text: result.text }),
      });
      return { sm };
    })();

    await sm.open({ agent: "omp" });

    // Access raw session and emit bare status idle — should NOT trigger onTurnComplete
    const session = sm._sessions.get("omp#1").session;
    session.emit("status", { status: "idle", isStreaming: false });
    assert.strictEqual(turnCompletions.length, 0,
      "bare status:idle should not trigger onTurnComplete");

    // Now do a real turn via enqueue — SHOULD trigger onTurnComplete
    await sm.enqueue({ msg: "hello" });
    assert.strictEqual(turnCompletions.length, 1);
    assert.strictEqual(turnCompletions[0].label, "omp#1");
    assert.strictEqual(turnCompletions[0].text, "result ok");
  });

  it("full relay integration: A turn completes → B receives complete merged text via real sm.enqueue, no echo", async () => {
    // ── Setup: multi-segment deltas for A ──────────────────────────
    const openBackendA = makeOpenBackend({ deltas: ["part A", " + part B"] });
    const openBackendB = makeOpenBackend({ deltas: ["ok"] });
    const openBackend = (opts) => opts.agent === "omp" ? openBackendA(opts) : openBackendB(opts);

    // ── Create registry FIRST, then sm with onTurnComplete wired ────
    // (registry needs sm.enqueue, and sm constructor needs registry.onTurnComplete —
    //  resolve with a two-phase: create registry with a placeholder, then set it)
    let forwardFn = null;
    const registry = createRelayRegistry((to, msg) => { if (forwardFn) forwardFn(to, msg); });

    const sm = createSessionManager({
      openBackend,
      stdout: captureStream(),
      stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => registry.onTurnComplete(label, result.text),
    });
    // Now wire the registry's enqueue to the real sm.enqueue
    forwardFn = (to, msg) => sm.enqueue({ target: to, msg });

    await sm.open({ agent: "omp" });   // omp#1 (A)
    await sm.open({ agent: "codex", announce: false }); // codex#1 (B)

    registry.add("omp#1", "codex#1");

    // ── Trigger A's turn ───────────────────────────────────────────
    await sm.enqueue({ target: "omp#1", msg: "trigger A" });
    // Relay enqueued on B.  Drain all so B's turn also completes.
    await sm.drainAll();

    // ── Assert B received exactly one relay message ─────────────────
    const bMsgs = sm._sessions.get("codex#1").session._sentMessages;
    assert.strictEqual(bMsgs.length, 1,
      `B should have exactly 1 message, got ${bMsgs.length}: ${JSON.stringify(bMsgs)}`);
    const relayMsg = bMsgs[0].message;
    assert.ok(relayMsg.includes("[relay from omp#1]"),
      `should have source attribution, got: ${relayMsg}`);
    // Multi-segment deltas: "part A" + " + part B" → merged "part A + part B"
    assert.ok(relayMsg.includes("part A + part B"),
      `should contain complete merged turn text, got: ${relayMsg}`);

    // ── Assert A has no relay echo ──────────────────────────────────
    const aMsgs = sm._sessions.get("omp#1").session._sentMessages;
    const relayEcho = aMsgs.filter((m) => m.message.includes("[relay from"));
    assert.strictEqual(relayEcho.length, 0,
      `A should not receive any relay-forwarded messages (echo prevention)`);
  });

  it("relay does not forward on empty or error turn", async () => {
    const forwardedMsgs = [];
    const relay = createRelayRegistry((to, msg) => forwardedMsgs.push({ to, msg }));

    const openBackend = makeOpenBackend({ failPrompt: true });
    const sm = createSessionManager({
      openBackend,
      stdout: captureStream(),
      stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => relay.onTurnComplete(label, result.text),
    });

    await sm.open({ agent: "omp" });  // omp#1
    relay.add("omp#1", "codex#1");

    // Enqueue a message that will fail (failPrompt)
    await sm.enqueue({ target: "omp#1", msg: "fail" }).catch(() => {});

    // onTurnComplete should NOT have been called for a failed turn
    // (the .then(onFulfilled, () => {}) in sendQueue only calls on success)
    assert.strictEqual(forwardedMsgs.length, 0,
      "failed turn should not trigger onTurnComplete");
  });

  it("relay does not forward B's output back to A (echo prevention via directionality)", async () => {
    // A→B relay; B completes a turn → should NOT forward back to A
    const forwardedMsgs = [];
    const relay = createRelayRegistry((to, msg) => forwardedMsgs.push({ to, msg }));

    const openBackend = makeOpenBackend({ deltas: ["data"], text: "data" });
    const sm = createSessionManager({
      openBackend,
      stdout: captureStream(),
      stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => relay.onTurnComplete(label, result.text),
    });

    await sm.open({ agent: "omp" });   // omp#1
    await sm.open({ agent: "codex", announce: false }); // codex#1

    // Only A→B, no B→A
    relay.add("omp#1", "codex#1");

    // B completes a turn
    await sm.enqueue({ target: "codex#1", msg: "B's response" });

    // No forward messages should have been generated (B has no outgoing rules)
    assert.strictEqual(forwardedMsgs.length, 0,
      "B's output should not echo back to A without explicit B→A rule");
  });

  it("drainAll loops until relay cascade completes", async () => {
    // ── Two-phase registry + sm ────────────────────────────────────
    let smRef = null;
    const registry = createRelayRegistry((to, msg) => {
      if (smRef) smRef.enqueue({ target: to, msg });
    });

    const openBackend = makeOpenBackend({ deltas: ["ok"] });
    const sm = createSessionManager({
      openBackend,
      stdout: captureStream(),
      stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label, result) => registry.onTurnComplete(label, result.text),
    });
    smRef = sm;

    await sm.open({ agent: "omp" });   // A
    await sm.open({ agent: "codex", announce: false }); // B

    registry.add("omp#1", "codex#1");

    // Enqueue on A (schedules send in microtask).  Call drainAll
    // immediately — it must loop past A's turn to catch B's relay cascade.
    sm.enqueue({ target: "omp#1", msg: "trigger" });
    await sm.drainAll();

    // B should have received exactly one relay-forwarded message
    const bMsgs = sm._sessions.get("codex#1").session._sentMessages;
    assert.strictEqual(bMsgs.length, 1,
      "B should have 1 message after drainAll quiescence");
    assert.ok(bMsgs[0].message.includes("[relay from omp#1]"),
      "B's message should have source attribution");
  });

  it("drainAll throws when cascade never quiesces (runaway detection)", async () => {
    // Counter-bounded self-loop: onTurnComplete re-enqueues on the same session,
    // but only a finite number of times (enough to exceed maxPasses, not enough to OOM).
    let smRef = null;
    let reenqueued = 0;
    const MAX_LOOP = 10;
    const sm = createSessionManager({
      openBackend: makeOpenBackend({ deltas: ["x"] }),
      stdout: captureStream(),
      stderr: captureStream(),
      report: FAKE_REPORT, cwd: "/test", defaults: {},
      onTurnComplete: (label) => {
        if (reenqueued++ < MAX_LOOP && smRef) {
          smRef.enqueue({ target: label, msg: "loop" });
        }
      },
    });
    smRef = sm;

    await sm.open({ agent: "omp" }); // 1 session → maxPasses = 2

    // Start the bounded self-loop
    sm.enqueue({ target: "omp#1", msg: "start" });

    // drainAll should throw after _sessions.size + 1 = 2 passes
    await assert.rejects(
      () => sm.drainAll(),
      /drainAll did not quiesce/,
      "drainAll should throw on runaway cascade",
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { createSessionManager } from "../src/session-manager.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

/** Capture stream: accumulates writes into .buf */
function captureStream() {
  return { buf: "", write(s) { this.buf += s; } };
}

const FAKE_REPORT = { omp: { available: true }, codex: { available: true } };

/** Make an openBackend factory that creates FakeSessions with given opts merged in. */
function makeOpenBackend(sessionOpts = {}) {
  return (opts) => fakeOpenBackend({ ...sessionOpts, ...opts });
}

/** Create a session-manager with captured stdout/stderr and a fake openBackend. */
function setup({ sessionOpts = {}, defaults = {}, onIdle } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const openBackend = makeOpenBackend(sessionOpts);
  const sm = createSessionManager({
    openBackend, stdout, stderr,
    report: FAKE_REPORT,
    cwd: "/test",
    defaults,
    onIdle,
  });
  return { sm, stdout, stderr, openBackend };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createSessionManager", () => {

  // ── open ─────────────────────────────────────────────────────────

  it("open returns label and sets currentLabel", async () => {
    const { sm } = setup();
    const label = await sm.open({ agent: "omp" });
    assert.strictEqual(label, "omp#1");
    assert.strictEqual(sm.currentLabel, "omp#1");
  });

  it("open with announce:'interactive' writes Opening + Opened to stdout", async () => {
    const { sm, stdout } = setup();
    await sm.open({ agent: "omp", announce: "interactive" });
    assert.ok(stdout.buf.includes("Opening omp#1 (omp)"));
    assert.ok(stdout.buf.includes("Opened omp#1 (omp)"));
  });

  it("open with announce:'task' writes Opening to stderr only, no Opened", async () => {
    const { sm, stdout, stderr } = setup();
    await sm.open({ agent: "omp", announce: "task" });
    assert.ok(stderr.buf.includes("Opening omp#1 (omp)"), "stderr should contain Opening");
    assert.ok(!stderr.buf.includes("Opened"), "stderr should NOT contain Opened");
    assert.ok(!stdout.buf.includes("Opening"), "stdout should NOT contain Opening");
    assert.ok(!stdout.buf.includes("Opened"), "stdout should NOT contain Opened");
  });

  it("open with announce:false writes nothing", async () => {
    const { sm, stdout, stderr } = setup();
    await sm.open({ agent: "omp", announce: false });
    assert.strictEqual(stdout.buf, "");
    assert.strictEqual(stderr.buf, "");
  });

  it("agentCounters are per-instance (not shared)", async () => {
    const a = setup();
    const b = setup();
    await a.sm.open({ agent: "omp" });
    await b.sm.open({ agent: "omp" });
    assert.strictEqual(a.sm.currentLabel, "omp#1");
    assert.strictEqual(b.sm.currentLabel, "omp#1");
  });

  // ── Event wiring: delta → lineBuf output ──────────────────────────

  it("delta events feed lineBuffer and flush to stdout on idle", async () => {
    const { sm, stdout } = setup({ sessionOpts: { deltas: ["Hello", " world"] } });
    await sm.open({ agent: "omp" });
    // enqueue triggers send, which emits deltas; idle triggers flush
    await sm.enqueue({ msg: "hello" });
    assert.ok(stdout.buf.includes("[omp#1] Hello world\n"),
      `expected "[omp#1] Hello world\\n" in stdout, got: ${JSON.stringify(stdout.buf)}`);
  });

  it("delta with newlines writes line-buffered output before idle", async () => {
    const { sm, stdout } = setup({ sessionOpts: { deltas: ["line1\n", "line2"] } });
    await sm.open({ agent: "omp" });
    await sm.enqueue({ msg: "hello" });
    // line1\n → emitted immediately as [omp#1] line1\n
    // line2 → buffered, flushed on idle
    assert.ok(stdout.buf.includes("[omp#1] line1\n"), "newline-terminated delta should emit immediately");
    assert.ok(stdout.buf.includes("[omp#1] line2\n"), "trailing delta should flush on idle");
  });

  // ── Event wiring: status idle → flush + onIdle ────────────────────

  it("calls onIdle with label when session goes idle", async () => {
    const idleLabels = [];
    const { sm } = setup({ onIdle: (label) => idleLabels.push(label) });
    await sm.open({ agent: "omp" });
    await sm.enqueue({ msg: "hello" });
    assert.deepStrictEqual(idleLabels, ["omp#1"]);
  });

  it("onIdle is called for each session independently", async () => {
    const idleLabels = [];
    const { sm } = setup({
      sessionOpts: { deltas: ["ok"] },
      onIdle: (label) => idleLabels.push(label),
    });
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: "interactive" }); // codex#1 becomes current

    await sm.enqueue({ target: "omp#1", msg: "a" });
    // After omp#1 idle: onIdle("omp#1") called
    await sm.enqueue({ msg: "b" }); // bare → codex#1 (current)
    // After codex#1 idle: onIdle("codex#1") called

    assert.deepStrictEqual(idleLabels, ["omp#1", "codex#1"]);
  });

  // ── enqueue routing ──────────────────────────────────────────────

  it("enqueue with target routes to specific session", async () => {
    const { sm } = setup({ sessionOpts: { deltas: ["ok"] } });
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: "interactive" }); // current = codex#1

    // Send to omp#1 by target
    await sm.enqueue({ target: "omp#1", msg: "to-omp" });

    // Verify omp#1 received it, codex#1 did not
    const ompInfo = sm._sessions.get("omp#1");
    const codexInfo = sm._sessions.get("codex#1");
    const ompMsgs = ompInfo.session._sentMessages.map((m) => m.message);
    const codexMsgs = codexInfo.session._sentMessages.map((m) => m.message);
    assert.ok(ompMsgs.includes("to-omp"), "omp#1 should have received 'to-omp'");
    assert.ok(!codexMsgs.includes("to-omp"), "codex#1 should NOT have received 'to-omp'");
  });

  it("enqueue without target routes to current session", async () => {
    const { sm } = setup({ sessionOpts: { deltas: ["ok"] } });
    await sm.open({ agent: "omp" });
    // omp#1 is current (set by open)
    await sm.enqueue({ msg: "bare-msg" });

    const info = sm._sessions.get("omp#1");
    const msgs = info.session._sentMessages.map((m) => m.message);
    assert.ok(msgs.includes("bare-msg"), "current session should have received bare message");
  });

  it("enqueue target:'all' broadcasts to all sessions", async () => {
    const { sm } = setup({ sessionOpts: { deltas: ["ok"] } });
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: "interactive" });

    sm.enqueue({ target: "all", msg: "broadcast" });
    // @all returns true immediately — need drainAll to wait for completion
    await sm.drainAll();

    for (const [, info] of sm._sessions) {
      const msgs = info.session._sentMessages.map((m) => m.message);
      assert.ok(msgs.includes("broadcast"),
        `${info.session.agent} session should have received broadcast`);
    }
  });

  it("enqueue returns false for non-existent target", () => {
    const { sm } = setup();
    const result = sm.enqueue({ target: "omp#99", msg: "nope" });
    assert.strictEqual(result, false);
  });

  it("enqueue returns false when no current session", () => {
    const { sm } = setup();
    const result = sm.enqueue({ msg: "nope" });
    assert.strictEqual(result, false);
  });

  // ── use ──────────────────────────────────────────────────────────

  it("use switches currentLabel and returns true on success", async () => {
    const { sm } = setup();
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: "interactive" });
    assert.strictEqual(sm.currentLabel, "codex#1");

    const ok = sm.use("omp#1");
    assert.strictEqual(ok, true);
    assert.strictEqual(sm.currentLabel, "omp#1");
  });

  it("use returns false for unknown label", async () => {
    const { sm } = setup();
    const ok = sm.use("omp#99");
    assert.strictEqual(ok, false);
  });

  // ── list ─────────────────────────────────────────────────────────

  it("list writes sessions to stdout, marks current with *", async () => {
    const { sm, stdout } = setup();
    await sm.open({ agent: "omp" });              // current = omp#1
    await sm.open({ agent: "codex", announce: "interactive" }); // current = codex#1

    sm.list();

    assert.ok(stdout.buf.includes("* codex#1"), "current session should be marked with *");
    assert.ok(stdout.buf.includes("  omp#1"), "non-current session should NOT have *");
  });

  // ── closeAll ─────────────────────────────────────────────────────

  it("closeAll closes all sessions", async () => {
    const { sm } = setup();
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: "interactive" });

    sm.closeAll();

    for (const [, info] of sm._sessions) {
      assert.strictEqual(info.session._closed, true,
        `${info.agent} session should be closed`);
    }
  });

  // ── Error wiring ─────────────────────────────────────────────────

  it("error event writes to stderr with leading newline when configured", async () => {
    const stderr = captureStream();
    const sm = createSessionManager({
      openBackend: makeOpenBackend(),
      stdout: captureStream(),
      stderr,
      report: FAKE_REPORT,
      cwd: "/test",
      defaults: {},
      errorLeadingNewline: true,
    });
    await sm.open({ agent: "omp" });
    const session = sm._sessions.get("omp#1").session;
    session.emit("error", new Error("boom"));

    assert.ok(stderr.buf.includes("\n[omp#1 error] boom\n"),
      `expected "\\n[omp#1 error] boom\\n" in stderr, got: ${JSON.stringify(stderr.buf)}`);
  });

  it("error event without errorLeadingNewline omits leading newline", async () => {
    const stderr = captureStream();
    const sm = createSessionManager({
      openBackend: makeOpenBackend(),
      stdout: captureStream(),
      stderr,
      report: FAKE_REPORT,
      cwd: "/test",
      defaults: {},
      // errorLeadingNewline defaults to false
    });
    await sm.open({ agent: "omp" });
    const session = sm._sessions.get("omp#1").session;
    session.emit("error", new Error("boom"));

    // No leading \n before [omp#1
    assert.ok(!stderr.buf.startsWith("\n"), "stderr should not start with newline");
    assert.ok(stderr.buf.includes("[omp#1 error] boom\n"),
      `expected "[omp#1 error] boom\\n" in stderr, got: ${JSON.stringify(stderr.buf)}`);
  });

  // ── enqueue send-error wiring ────────────────────────────────────

  it("single-target send error without errorLeadingNewline omits leading newline", async () => {
    const stderr = captureStream();
    const sm = createSessionManager({
      openBackend: makeOpenBackend({ failPrompt: true }),
      stdout: captureStream(),
      stderr,
      report: FAKE_REPORT,
      cwd: "/test",
      defaults: {},
      // errorLeadingNewline defaults to false
    });
    await sm.open({ agent: "omp" });
    await sm.enqueue({ target: "omp#1", msg: "fail" }).catch(() => {});

    assert.ok(stderr.buf.includes("[omp#1 send error] simulated prompt failure\n"),
      `expected "[omp#1 send error] ..." in stderr, got: ${JSON.stringify(stderr.buf)}`);
    assert.ok(!stderr.buf.startsWith("\n"), "stderr should not start with newline");
  });

  it("single-target send error with errorLeadingNewline adds leading newline", async () => {
    const stderr = captureStream();
    const sm = createSessionManager({
      openBackend: makeOpenBackend({ failPrompt: true }),
      stdout: captureStream(),
      stderr,
      report: FAKE_REPORT,
      cwd: "/test",
      defaults: {},
      errorLeadingNewline: true,
    });
    await sm.open({ agent: "omp" });
    await sm.enqueue({ target: "omp#1", msg: "fail" }).catch(() => {});

    assert.ok(stderr.buf.includes("\n[omp#1 send error] simulated prompt failure\n"),
      `expected "\\n[omp#1 send error] ..." in stderr, got: ${JSON.stringify(stderr.buf)}`);
    assert.ok(stderr.buf.startsWith("\n"), "stderr should start with newline");
  });

  it("@all send error without errorLeadingNewline omits leading newline for both sessions", async () => {
    const stderr = captureStream();
    const sm = createSessionManager({
      openBackend: makeOpenBackend({ failPrompt: true }),
      stdout: captureStream(),
      stderr,
      report: FAKE_REPORT,
      cwd: "/test",
      defaults: {},
      // errorLeadingNewline defaults to false
    });
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: false });

    sm.enqueue({ target: "all", msg: "fail" });
    await sm.drainAll();

    assert.ok(stderr.buf.includes("[omp#1 send error] simulated prompt failure\n"),
      `expected "[omp#1 send error] ..." in stderr, got: ${JSON.stringify(stderr.buf)}`);
    assert.ok(stderr.buf.includes("[codex#1 send error] simulated prompt failure\n"),
      `expected "[codex#1 send error] ..." in stderr, got: ${JSON.stringify(stderr.buf)}`);
    assert.ok(!stderr.buf.startsWith("\n"), "stderr should not start with newline");
  });

  it("@all send error with errorLeadingNewline adds leading newline for both sessions", async () => {
    const stderr = captureStream();
    const sm = createSessionManager({
      openBackend: makeOpenBackend({ failPrompt: true }),
      stdout: captureStream(),
      stderr,
      report: FAKE_REPORT,
      cwd: "/test",
      defaults: {},
      errorLeadingNewline: true,
    });
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: false });

    sm.enqueue({ target: "all", msg: "fail" });
    await sm.drainAll();

    assert.ok(stderr.buf.includes("\n[omp#1 send error] simulated prompt failure\n"),
      `expected "\\n[omp#1 send error] ..." in stderr, got: ${JSON.stringify(stderr.buf)}`);
    assert.ok(stderr.buf.includes("\n[codex#1 send error] simulated prompt failure\n"),
      `expected "\\n[codex#1 send error] ..." in stderr, got: ${JSON.stringify(stderr.buf)}`);
  });

  // ── drainAll / flushAll ──────────────────────────────────────────

  it("drainAll resolves after all send queues complete", async () => {
    const { sm } = setup({ sessionOpts: { deltas: ["ok"] } });
    await sm.open({ agent: "omp" });
    await sm.open({ agent: "codex", announce: "interactive" });

    sm.enqueue({ target: "all", msg: "batch" });
    await sm.drainAll();

    // Both sessions should have received the message
    for (const [, info] of sm._sessions) {
      assert.ok(info.session._sentMessages.length >= 1,
        `session should have at least one message`);
    }
  });

  it("mesh defaults to false, propagates to openBackend", async () => {
    const { sm } = setup();
    const label = await sm.open({ agent: "omp" });
    assert.ok(label, "should open");
    // Default mesh:false — openBackend receives mesh:false
  });

  it("mesh:true in defaults propagates to openBackend", async () => {
    let receivedMesh;
    // Inject fake openBackend that captures mesh
    const openBackend = async (opts) => {
      receivedMesh = opts.mesh;
      return new (await import("./helpers/fake-backend.mjs")).FakeSession(opts);
    };
    const sm = createSessionManager({
      openBackend, stdout: captureStream(), stderr: captureStream(),
      report: { omp: { available: true } },
      cwd: "/test",
      defaults: { mesh: true },
    });
    const label = await sm.open({ agent: "omp" });
    assert.ok(label, "should open");
    assert.strictEqual(receivedMesh, true, "openBackend should receive mesh:true");
  });

  it("mesh:false default → openBackend receives false", async () => {
    let receivedMesh;
    const openBackend = async (opts) => {
      receivedMesh = opts.mesh;
      return new (await import("./helpers/fake-backend.mjs")).FakeSession(opts);
    };
    const sm = createSessionManager({
      openBackend, stdout: captureStream(), stderr: captureStream(),
      report: { omp: { available: true } },
      cwd: "/test",
    });
    const label = await sm.open({ agent: "omp" });
    assert.ok(label, "should open");
    assert.strictEqual(receivedMesh, false, "default mesh should be false");
  });
});

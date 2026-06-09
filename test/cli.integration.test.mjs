// synod/test/cli.integration.test.mjs — Integration tests for cli.mjs main() with fake backend.
//
// Uses PassThrough stdin to simulate piped input, FakeSession for synchronous
// session creation, and captured stdout/stderr for assertions.
//
// NOTE: dispatch() is synchronous for every command except /open (which
// awaits sm.open()).  With piped stdin, a line that depends on a session
// created by a prior async /open cannot be tested sequentially — the next
// line fires before /open's promise resolves.  (Synchronous commands like
// /exit DO take effect within the same readline tick; see the "/exit sync
// guard" regression tests below.)  Test such async-dependent sequences at
// the dispatch unit level (test/repl-dispatch.test.mjs) or via Tier 2
// acceptance (waitForPrompt).

import { describe, it } from "node:test";
import assert from "node:assert";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

// Ensure doctor() in main() finds available agents
process.env.OMP_BIN = process.env.OMP_BIN || "node";
process.env.CODEX_BIN = process.env.CODEX_BIN || "node";

// ── Helpers ──────────────────────────────────────────────────────────

function captureStream() {
  return { buf: "", write(s) { this.buf += s; } };
}

/** Feed lines into a PassThrough, then end it. Returns the stream. */
function feedLines(lines) {
  const s = new PassThrough();
  for (const line of lines) s.write(line + "\n");
  s.end();
  return s;
}

/**
 * Run main() with piped input and synchronous fake backend.
 * Uses FakeSession directly (not async fakeOpenBackend) to avoid
 * extra microtask deferral in session creation.
 */
async function runMain(lines, opts = {}) {
  const sessionOpts = opts.sessionOpts || {};
  const openBackend = (o) => new FakeSession({ ...sessionOpts, ...o });
  const stdin = feedLines(lines);
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await main({
    openBackend,
    stdin,
    stdout,
    stderr,
    argv: opts.argv || [],
  });
  return { exitCode, stdout: stdout.buf, stderr: stderr.buf };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("cli main() integration", () => {
  // ── Session open routing ──────────────────────────────────────────
  it("/open --agent codex announces codex session", async () => {
    const { stdout, exitCode } = await runMain(["/open --agent codex", "/exit"]);
    // Async sm.open may defer "Opened" past the /exit line, but "Opening"
    // is written synchronously before the first await inside sm.open.
    assert.ok(stdout.includes("Opening codex#1 (codex)"), "should announce codex session");
    // Neither crashes
    assert.strictEqual(exitCode, 0);
  });

  it("/open without --agent announces omp session", async () => {
    const { stdout, exitCode } = await runMain(["/open", "/exit"]);
    assert.ok(stdout.includes("Opening omp#"), "should announce omp session");
    assert.strictEqual(exitCode, 0);
  });

  // ── Message routing ───────────────────────────────────────────────
  it("@omp#1 message routes to default session", async () => {
    const { stdout, exitCode } = await runMain(["@omp#1 hello session", "/exit"], {
      sessionOpts: { deltas: ["response text"] },
    });
    // Default session omp#1 exists before repl resumes — enqueue succeeds
    assert.ok(stdout.includes("[omp#1]"), "should have omp#1 line-buffer output");
    assert.strictEqual(exitCode, 0);
  });

  it("normal line routes to current session", async () => {
    const { stdout, exitCode } = await runMain(["hello world", "/exit"], {
      sessionOpts: { deltas: ["got it"] },
    });
    assert.ok(stdout.includes("[omp#1]"), "normal line should route to default session");
    assert.strictEqual(exitCode, 0);
  });

  // ── Error output ─────────────────────────────────────────────────
  it("unknown /command writes to stderr", async () => {
    const { stderr, exitCode } = await runMain(["/foobar", "/exit"]);
    assert.ok(stderr.includes("Unknown command: /foobar"));
    assert.strictEqual(exitCode, 0);
  });

  it("@label without message writes stderr usage", async () => {
    const { stderr, exitCode } = await runMain(["@omp#1", "/exit"]);
    assert.ok(stderr.includes("Usage: @<label>"));
    assert.strictEqual(exitCode, 0);
  });

  it("/open with bad --agent writes stderr", async () => {
    const { stderr, exitCode } = await runMain(["/open --agent gpt99", "/exit"]);
    assert.ok(stderr.includes("--agent must be one of"));
    assert.strictEqual(exitCode, 0);
  });

  it("/relay with nonexistent target writes stderr", async () => {
    const { stderr, exitCode } = await runMain(["/relay omp#1->ghost#1", "/exit"]);
    assert.ok(stderr.includes('No session "ghost#1"'));
    assert.strictEqual(exitCode, 0);
  });

  // ── Exit paths ────────────────────────────────────────────────────
  it("/exit ends the REPL and main resolves 0", async () => {
    const { exitCode } = await runMain(["/exit"]);
    assert.strictEqual(exitCode, 0);
  });

  // ── /exit sync guard (regression: async dispatch broke piped exitRequested) ─
  it("/exit prevents processing of subsequent lines — unknown command not reached", async () => {
    const { stderr, exitCode } = await runMain(["/exit", "/foobar"]);
    // exitRequested=true should guard /foobar — no "Unknown command" in stderr
    assert.strictEqual(stderr, "", `stderr should be empty, got: ${stderr}`);
    assert.strictEqual(exitCode, 0);
  });

  it("/exit prevents enqueuing messages after exit", async () => {
    const { stdout, exitCode } = await runMain(["/exit", "hello after exit"], {
      sessionOpts: { deltas: ["AFTER"] },
    });
    // The line after /exit must not be enqueued — no line-buffer output
    assert.ok(!stdout.includes("AFTER"), "AFTER delta should not appear");
    assert.ok(!stdout.includes("[omp#1]"), "no omp line-buffer output should appear");
    assert.strictEqual(exitCode, 0);
  });

  it("/exit prevents /open after exit", async () => {
    const { stdout, exitCode } = await runMain(["/exit", "/open --agent codex"]);
    // exitRequested=true must guard /open — no session announcement
    assert.ok(!stdout.includes("Opening codex"), "should not open codex after /exit");
    assert.strictEqual(exitCode, 0);
  });

  it("Ctrl-D (EOF) cleanly exits with code 0", async () => {
    const stdin = new PassThrough();
    const openBackend = (o) => new FakeSession(o);
    const stdout = captureStream();
    const stderr = captureStream();
    // End stdin after a short delay so the repl has time to open the default
    // session and resume.  readline then fires 'close' which triggers onClose.
    const timer = setTimeout(() => stdin.end(), 150);
    const exitCode = await main({
      openBackend,
      stdin,
      stdout,
      stderr,
      argv: [],
    });
    clearTimeout(timer);
    assert.strictEqual(exitCode, 0);
  });

  it("/quit also exits", async () => {
    const { exitCode } = await runMain(["/quit"]);
    assert.strictEqual(exitCode, 0);
  });

  // ── Smoke: commands that don't depend on prior async session creation ─
  it("/sessions lists sessions", async () => {
    const { stdout, exitCode } = await runMain(["/sessions", "/exit"]);
    assert.ok(stdout.includes("* omp#1"), "should list default session");
    assert.strictEqual(exitCode, 0);
  });

  it("/relays empty shows no active relays", async () => {
    const { stdout, exitCode } = await runMain(["/relays", "/exit"]);
    assert.ok(stdout.includes("No active relay rules"));
    assert.strictEqual(exitCode, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

// ── Test helpers ─────────────────────────────────────────────────────────

/** In-memory filesystem sink for logger assertions. */
function memoryFs() {
  const files = new Map();
  return {
    async writeFile(path, content) { files.set(path, content); },
    async appendFile(path, content) {
      files.set(path, (files.get(path) ?? "") + content);
    },
    get(path) { return files.get(path); },
  };
}

/**
 * Fake I/O for approve() — same pattern as approve.test.mjs.
 *
 * `io.feed(line)` queues a line; `io.question()` resolves to the next
 * queued line.  Supports AbortSignal for pre-aborted / mid-wait abort.
 */
function createFakeIo() {
  const _lines = [];
  const stdout = {
    write(s) { _lines.push(s); },
  };

  let _lineQueue = [];
  let _pendingResolve = null;

  function feed(line) {
    if (_pendingResolve) {
      const r = _pendingResolve;
      _pendingResolve = null;
      r(line);
    } else {
      _lineQueue.push(line);
    }
  }

  function question(_prompt, opts) {
    const { signal } = opts || {};
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        return;
      }

      if (_lineQueue.length > 0) {
        resolve(_lineQueue.shift());
        return;
      }

      _pendingResolve = resolve;
      if (signal) {
        signal.addEventListener("abort", () => {
          if (_pendingResolve === resolve) {
            _pendingResolve = null;
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          }
        }, { once: true });
      }
    });
  }

  return { question, feed, stdout, io: { question, stdout } };
}

/**
 * Custom openBackend that tracks every session created and lets the
 * test control per-session behaviour (texts, failAfter, etc.).
 */
function trackingOpenBackend(sessionConfigs) {
  const sessions = [];
  let openCount = 0;

  async function open(opts) {
    const cfg = sessionConfigs[openCount] || {};
    openCount++;
    const s = new FakeSession({
      agent: opts.agent,
      model: opts.model,
      cwd: opts.cwd,
      texts: cfg.texts,
      failAfter: cfg.failAfter,
      failPrompt: cfg.failPrompt,
    });
    sessions.push(s);
    return s;
  }

  return { open, sessions, get openCount() { return openCount; } };
}

/**
 * Parse JSONL log lines written by the logger.
 */
function parseJsonl(raw) {
  if (!raw) return [];
  return raw.trim().split("\n").filter(Boolean).map(JSON.parse);
}

/**
 * Spy on process.exit — records calls without actually exiting.
 *
 * Returns { calls, restore() }.  MUST call `restore()` in a finally
 * block so other tests aren't affected.
 */
function spyProcessExit() {
  const orig = process.exit;
  let calls = 0;
  process.exit = (_code) => { calls++; };
  return {
    get calls() { return calls; },
    restore() { process.exit = orig; },
  };
}

/**
 * Helper: run a test body with process.exit spied, assert zero calls.
 */
async function assertNoProcessExit(fn) {
  const spy = spyProcessExit();
  try {
    await fn();
    assert.strictEqual(spy.calls, 0, "process.exit must not be called");
  } finally {
    spy.restore();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("reviseWithHuman", () => {
  describe("happy path — scripted rounds", () => {
    it("round1 feedback → revise → round2 accept → returns final doc", async () => {
      const io = createFakeIo();
      const fs = memoryFs();
      const { open: openBackend, sessions } = trackingOpenBackend([
        { texts: ["revised doc v1"] },
      ]);

      const rt = createRuntime({
        fs,
        openBackend,
        io: io.io,
        clock: () => 1000,
      });

      const ctx = rt.createCtx({ topic: "test" });

      // round 1: feedback → round 2: accept
      io.feed("make it shorter");
      io.feed("accept");

      const initialDraft = "This is a long document.";
      const result = await rt.reviseWithHuman(ctx, initialDraft, { agent: "omp" });

      assert.strictEqual(result, "revised doc v1",
        "final doc should be the agent-revised version after accept");

      // Each round produces approve + agent step logs
      const logEntries = parseJsonl(fs.get("run.log.jsonl") || "");

      const approveSteps = logEntries.filter(
        (e) => e.event === "step:succeeded" && e.node === "approve"
      );
      assert.strictEqual(approveSteps.length, 2,
        "should have 2 approve steps (one per round)");

      const agentSteps = logEntries.filter(
        (e) => e.event === "step:succeeded" && e.type === "agent"
      );
      assert.strictEqual(agentSteps.length, 1,
        "should have 1 agent step (only round 1 calls agent)");

      // Session was opened once and reused
      assert.strictEqual(sessions.length, 1,
        "one session opened across both rounds");

      // Verify agent prompt contained the full current doc
      const sentMsgs = sessions[0]._sentMessages;
      const agentMsg = sentMsgs.find(
        (m) => m.message.includes("Revision request") && m.options.wait
      );
      assert.ok(agentMsg, "agent should have received a revision prompt");
      assert.ok(
        agentMsg.message.includes("This is a long document"),
        "prompt must contain the full current doc"
      );
      assert.ok(
        agentMsg.message.includes("make it shorter"),
        "prompt must contain the human's feedback"
      );
    });
  });

  describe("reuse = optimisation, not dependency", () => {
    it("session drops mid-loop, rebuild succeeds, prompts always contain full doc", async () => {
      const io = createFakeIo();
      const fs = memoryFs();

      // Session 1: succeed on send 1 (round 1), fail on send 2 (round 2)
      // Session 2: succeed normally (rebuild for round 2 retry)
      const { open: openBackend, sessions } = trackingOpenBackend([
        { texts: ["doc v1 after round1"], failAfter: 1 },
        { texts: ["doc v2 after round2"] },
      ]);

      const rt = createRuntime({
        fs,
        openBackend,
        io: io.io,
        clock: () => 2000,
      });

      const ctx = rt.createCtx({ topic: "test" });

      // round 1: feedback → round 2: feedback (fail+retry) → round 3: accept
      io.feed("expand section 3");
      io.feed("also fix the intro");
      io.feed("accept");

      const initialDraft = "Initial draft content.";
      const result = await rt.reviseWithHuman(ctx, initialDraft, { agent: "omp" });

      // Final result correct despite session drop
      assert.strictEqual(result, "doc v2 after round2",
        "final doc should be correct even after session rebuild");

      // Two sessions opened (first died, second rebuilt)
      assert.strictEqual(sessions.length, 2,
        "two sessions: first died, second rebuilt");

      // First session should be closed
      assert.strictEqual(sessions[0]._closed, true,
        "first (failed) session should be closed");

      // Collect ALL prompts sent to agents across ALL sessions
      const allPrompts = [];
      for (const s of sessions) {
        for (const msg of s._sentMessages) {
          if (msg.options.wait) {
            allPrompts.push(msg.message);
          }
        }
      }

      // Every agent prompt MUST contain the full current doc header
      for (const prompt of allPrompts) {
        assert.ok(
          prompt.includes("Current document:"),
          `every prompt must include "Current document:" header`
        );
      }

      // Round 1 prompt (session 1, send 1): initialDraft + feedback
      const r1 = allPrompts[0];
      assert.ok(r1.includes("Initial draft content"),
        "round 1 prompt must contain initial draft");
      assert.ok(r1.includes("expand section 3"),
        "round 1 prompt must contain round 1 feedback");

      // Round 2 pre-fail (session 1, send 2): doc v1 + "also fix the intro"
      const r2pre = allPrompts[1];
      assert.ok(r2pre.includes("doc v1 after round1"),
        "round 2 pre-fail prompt must contain doc v1");
      assert.ok(r2pre.includes("also fix the intro"),
        "round 2 pre-fail prompt must contain round 2 feedback");

      // Round 2 retry (session 2, send 1): SAME doc + SAME feedback
      const r2retry = allPrompts[2];
      assert.ok(r2retry.includes("doc v1 after round1"),
        "round 2 retry prompt must STILL contain doc v1 (session-independent)");
      assert.ok(r2retry.includes("also fix the intro"),
        "round 2 retry prompt must contain round 2 feedback");
    });

    it("retries exactly once — second agent failure propagates (no infinite retry)", async () => {
      const io = createFakeIo();
      const fs = memoryFs();

      // Both sessions fail — error must propagate, exactly 2 opens
      const { open: openBackend, sessions } = trackingOpenBackend([
        { failPrompt: true },
        { failPrompt: true },
      ]);

      const rt = createRuntime({
        fs,
        openBackend,
        io: io.io,
        clock: () => 2500,
      });

      const ctx = rt.createCtx({ topic: "retry-limit" });

      // round 1: feedback triggers agent → fails → retry → fails → throws
      io.feed("fix everything");

      const initialDraft = "Draft that can't be fixed.";
      let error;
      try {
        await rt.reviseWithHuman(ctx, initialDraft, { agent: "omp" });
      } catch (err) {
        error = err;
      }

      assert.ok(error, "must throw after both attempts fail");
      assert.strictEqual(sessions.length, 2,
        "exactly two sessions opened (one per attempt, no infinite retry)");

      // Both sessions closed
      for (const s of sessions) {
        assert.strictEqual(s._closed, true,
          "every session must be closed after failure");
      }
    });
  });

  describe("/abort graceful exit", () => {
    it("/abort returns current draft — process.exit never called, no throw", async () => {
      await assertNoProcessExit(async () => {
        const io = createFakeIo();
        const fs = memoryFs();
        const { open: openBackend } = trackingOpenBackend([
          { texts: ["revised v1"] },
        ]);

        const rt = createRuntime({
          fs,
          openBackend,
          io: io.io,
          clock: () => 3000,
        });

        const ctx = rt.createCtx({ topic: "abort-test" });

        // round 1: feedback → agent revises → round 2: /abort
        io.feed("make changes");
        io.feed("/abort");

        const initialDraft = "Draft for abort test.";
        const result = await rt.reviseWithHuman(ctx, initialDraft, { agent: "omp" });

        assert.strictEqual(result, "revised v1",
          "/abort must return the current (revised) draft");
      });
    });

    it("empty line returns current draft — process.exit never called, no throw", async () => {
      await assertNoProcessExit(async () => {
        const io = createFakeIo();
        const fs = memoryFs();
        const { open: openBackend } = trackingOpenBackend([
          { texts: [] },
        ]);

        const rt = createRuntime({
          fs,
          openBackend,
          io: io.io,
          clock: () => 4000,
        });

        const ctx = rt.createCtx({ topic: "empty-abort" });

        // Empty line on first round (no prior agent call)
        io.feed("");

        const initialDraft = "Unrevised draft.";
        const result = await rt.reviseWithHuman(ctx, initialDraft);

        assert.strictEqual(result, initialDraft,
          "empty line on first round returns the initial draft unchanged");
      });
    });

    it("pre-aborted signal returns initial draft — process.exit never called", async () => {
      await assertNoProcessExit(async () => {
        const io = createFakeIo();
        const fs = memoryFs();
        const { open: openBackend } = trackingOpenBackend([
          { texts: ["v1"] },
        ]);

        const rt = createRuntime({
          fs,
          openBackend,
          io: io.io,
          clock: () => 5000,
        });

        const ctx = rt.createCtx({ topic: "signal-abort" });

        // Pre-aborted signal → approve resolves immediately with {aborted:true}
        const ac = new AbortController();
        ac.abort();

        const initialDraft = "Signal abort draft.";
        const result = await rt.reviseWithHuman(ctx, initialDraft, {
          signal: ac.signal,
        });

        assert.strictEqual(result, initialDraft,
          "pre-aborted signal returns initial draft immediately");
      });
    });

    it("mid-wait abort while approve is pending — returns current draft, process.exit never called", async () => {
      await assertNoProcessExit(async () => {
        const io = createFakeIo();
        const fs = memoryFs();
        const { open: openBackend } = trackingOpenBackend([
          { texts: ["v1"] },
        ]);

        const rt = createRuntime({
          fs,
          openBackend,
          io: io.io,
          clock: () => 6000,
        });

        const ctx = rt.createCtx({ topic: "mid-abort" });

        const initialDraft = "Mid-wait abort draft.";
        const ac = new AbortController();

        // Start reviseWithHuman — it will call approve which calls
        // io.question.  No lines fed, so question enters pending state
        // waiting for input (or abort).
        const promise = rt.reviseWithHuman(ctx, initialDraft, {
          signal: ac.signal,
        });

        // Let a microtask tick pass so approve enters the pending wait
        await new Promise((r) => setTimeout(r, 0));

        // Abort while approve is waiting
        ac.abort();

        // Must resolve without throwing — approve catches AbortError,
        // returns { aborted: true }, reviseWithHuman returns current doc
        const result = await promise;

        assert.strictEqual(result, initialDraft,
          "mid-wait abort must return the current draft");
      });
    });
  });

  describe("opts passthrough (P2-42)", () => {
    it("reviseWithHuman 把 profile/effort/write/systemPrompt 透传内部 agent()", async () => {
      const seen = [];
      const agent = async (ctx, opts) => { seen.push(opts); return "revised"; };
      let calls = 0;
      const approve = async () => (calls++ === 0 ? { accepted: false, feedback: "改" } : { accepted: true });
      const { createReviseWithHuman } = await import("../src/flow/api/reviseWithHuman.mjs");
      const revise = createReviseWithHuman({ agent, approve, logger: { logStep: async () => {} } });
      const out = await revise({ runId: "r", cwd: "/tmp" }, "draft", {
        profile: "writer", effort: "high", write: true, systemPrompt: "你是编辑",
      });
      assert.equal(out, "revised");
      assert.equal(seen[0].profile, "writer");
      assert.equal(seen[0].effort, "high");
      assert.equal(seen[0].write, true);
      assert.equal(seen[0].systemPrompt, "你是编辑");
      assert.equal(seen[0].reuse, true);
    });
  });
});

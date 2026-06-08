import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

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

describe("backtrack", () => {
  // ── Happy path: feedback threaded into next prompt ────────────────

  it("retries with feedback until review passes", async () => {
    const fs = memoryFs();
    // Shared counter: session 1 → "bad output", session 2 → "good output"
    let produceCall = 0;
    const sessions = [];
    const fb = async (opts) => {
      produceCall++;
      const s = await fakeOpenBackend({
        ...opts,
        deltas: [produceCall === 1 ? "bad output" : "good output"],
      });
      sessions.push(s);
      return s;
    };

    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: fb,
    });
    const ctx = runtime.createCtx({});

    const result = await runtime.backtrack(ctx, {
      produce: async (_ctx, prompt) =>
        runtime.agent(ctx, { agent: "omp", prompt }),
      review: async (output) => ({
        passed: output === "good output",
        feedback: output === "good output" ? undefined : "fix the bad output",
      }),
      buildPrompt: ({ attempt, feedback }) =>
        `Attempt ${attempt}: ${feedback ? "FIX: " + feedback : "do it"}`,
      initialPrompt: "do it",
      maxTurns: 3,
    });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.output, "good output");

    // Verify the second session's prompt contains the feedback
    assert.strictEqual(sessions.length, 2, "two sessions opened (one per turn)");
    const secondPrompt = sessions[1]._sentMessages[0].message;
    assert.ok(
      secondPrompt.includes("fix the bad output"),
      `second prompt should contain feedback, got: ${secondPrompt}`,
    );
  });

  it("stops at maxTurns when review never passes, returns last output", async () => {
    const fs = memoryFs();
    let produceCall = 0;
    const sessions = [];
    const fb = async (opts) => {
      produceCall++;
      const outputs = ["bad1", "bad2", "bad3"];
      const s = await fakeOpenBackend({
        ...opts,
        deltas: [outputs[Math.min(produceCall - 1, outputs.length - 1)]],
      });
      sessions.push(s);
      return s;
    };

    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: fb,
    });
    const ctx = runtime.createCtx({});

    const result = await runtime.backtrack(ctx, {
      produce: async (_ctx, prompt) =>
        runtime.agent(ctx, { agent: "omp", prompt }),
      review: async () => ({ passed: false, feedback: "still wrong" }),
      buildPrompt: ({ attempt, feedback }) =>
        `Attempt ${attempt}: ${feedback}`,
      initialPrompt: "start",
      maxTurns: 3,
    });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.output, "bad3", "output is the last round's product");
    assert.strictEqual(sessions.length, 3);
  });

  // ── Feedback threading (the core invariant) ───────────────────────

  it("feeds review feedback into subsequent produce prompts", async () => {
    const fs = memoryFs();
    let produceCall = 0;
    const sessions = [];
    const fb = async (opts) => {
      produceCall++;
      const outputs = ["v1", "v2", "v3"];
      const s = await fakeOpenBackend({
        ...opts,
        deltas: [outputs[Math.min(produceCall - 1, outputs.length - 1)]],
      });
      sessions.push(s);
      return s;
    };

    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: fb,
    });
    const ctx = runtime.createCtx({});

    await runtime.backtrack(ctx, {
      produce: async (_ctx, prompt) =>
        runtime.agent(ctx, { agent: "omp", prompt }),
      review: async (output) => {
        if (output === "v1") return { passed: false, feedback: "error A" };
        if (output === "v2") return { passed: false, feedback: "error B" };
        return { passed: true };
      },
      buildPrompt: ({ attempt, feedback }) =>
        `prompt-${attempt}:${feedback}`,
      initialPrompt: "prompt-1:initial",
      maxTurns: 5,
    });

    assert.strictEqual(sessions.length, 3);
    assert.strictEqual(sessions[0]._sentMessages[0].message, "prompt-1:initial");
    assert.strictEqual(sessions[1]._sentMessages[0].message, "prompt-2:error A");
    assert.strictEqual(sessions[2]._sentMessages[0].message, "prompt-3:error B");
  });

  it("passes on the first attempt when review passes immediately", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, texts: ["perfect"] }),
    });
    const ctx = runtime.createCtx({});

    const result = await runtime.backtrack(ctx, {
      produce: async (_ctx, prompt) =>
        runtime.agent(ctx, { agent: "omp", prompt }),
      review: async () => ({ passed: true }),
      buildPrompt: () => "unused",
      initialPrompt: "go",
    });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.output, "perfect");
  });

  // ── Validation ────────────────────────────────────────────────────

  it("throws when produce is not a function", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.backtrack(ctx, {
          produce: "not-a-function",
          review: async () => ({ passed: true }),
          buildPrompt: () => "x",
          initialPrompt: "x",
        }),
      /produce must be a function/,
    );
  });

  it("throws when initialPrompt is empty", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.backtrack(ctx, {
          produce: async () => "x",
          review: async () => ({ passed: true }),
          buildPrompt: () => "x",
          initialPrompt: "",
        }),
      /initialPrompt is required/,
    );
  });

  it("throws when maxTurns is not a positive integer (e.g. 0)", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.backtrack(ctx, {
          produce: async () => "x",
          review: async () => ({ passed: true }),
          buildPrompt: () => "x",
          initialPrompt: "x",
          maxTurns: 0,
        }),
      /maxTurns must be a positive integer/,
    );
  });

  it("throws when maxTurns is NaN — never calls produce", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    let produced = false;
    await assert.rejects(
      () =>
        runtime.backtrack(ctx, {
          produce: async () => { produced = true; return "x"; },
          review: async () => ({ passed: true }),
          buildPrompt: () => "x",
          initialPrompt: "x",
          maxTurns: NaN,
        }),
      /maxTurns must be a positive integer/,
    );
    assert.strictEqual(produced, false, "NaN: produce never called");
  });

  it("throws when maxTurns is Infinity — never calls produce", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    let produced = false;
    await assert.rejects(
      () =>
        runtime.backtrack(ctx, {
          produce: async () => { produced = true; return "x"; },
          review: async () => ({ passed: true }),
          buildPrompt: () => "x",
          initialPrompt: "x",
          maxTurns: Infinity,
        }),
      /maxTurns must be a positive integer/,
    );
    assert.strictEqual(produced, false, "Infinity: produce never called");
  });

  it("throws when maxTurns is 1.5 — never calls produce", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    let produced = false;
    await assert.rejects(
      () =>
        runtime.backtrack(ctx, {
          produce: async () => { produced = true; return "x"; },
          review: async () => ({ passed: true }),
          buildPrompt: () => "x",
          initialPrompt: "x",
          maxTurns: 1.5,
        }),
      /maxTurns must be a positive integer/,
    );
    assert.strictEqual(produced, false, "1.5: produce never called");
  });

  it("uses feedback from review even when output is unchanged", async () => {
    // Scenario: produce always returns the same text, but review
    // gives different feedback each time.  The backtrack must still
    // thread that feedback into buildPrompt.
    const fs = memoryFs();
    const sessions = [];
    const fb = async (opts) => {
      const s = await fakeOpenBackend({
        ...opts,
        texts: ["same", "same", "same"],
      });
      sessions.push(s);
      return s;
    };

    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: fb,
    });
    const ctx = runtime.createCtx({});

    let reviewCount = 0;
    await runtime.backtrack(ctx, {
      produce: async (_ctx, prompt) =>
        runtime.agent(ctx, { agent: "omp", prompt }),
      review: async () => {
        reviewCount++;
        if (reviewCount < 3) {
          return { passed: false, feedback: `fix-${reviewCount}` };
        }
        return { passed: true };
      },
      buildPrompt: ({ attempt, feedback }) => `p-${attempt}-${feedback}`,
      initialPrompt: "p-1-start",
      maxTurns: 5,
    });

    assert.strictEqual(sessions.length, 3);
    assert.strictEqual(sessions[0]._sentMessages[0].message, "p-1-start");
    assert.strictEqual(sessions[1]._sentMessages[0].message, "p-2-fix-1");
    assert.strictEqual(sessions[2]._sentMessages[0].message, "p-3-fix-2");
  });
});

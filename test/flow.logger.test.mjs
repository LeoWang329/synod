import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { OUTPUT_INLINE_THRESHOLD } from "../src/flow/logger.mjs";

/** In-memory filesystem sink for deterministic logger tests. */
function memoryFs() {
  const files = new Map();
  return {
    async writeFile(path, content) {
      files.set(path, content);
    },
    async appendFile(path, content) {
      const existing = files.get(path) ?? "";
      files.set(path, existing + content);
    },
    get(path) {
      return files.get(path);
    },
  };
}

describe("logger", () => {
  // ── step lifecycle ───────────────────────────────────────────────

  it("writes step:started + step:succeeded as two JSONL lines with required fields", async () => {
    const fs = memoryFs();
    const clock = () => 1700000000000;
    const runtime = createRuntime({ fs, clock });
    const ctx = runtime.createCtx({});

    await runtime.logger.logStep(ctx, {
      node: "agent",
      type: "agent",
      attempt: 1,
    });

    const logContent = fs.get("run.log.jsonl");
    assert.ok(logContent, "log should have content");
    const lines = logContent.trim().split("\n");
    assert.strictEqual(lines.length, 2, "should write two JSONL lines");

    // Line 1: step:started
    const started = JSON.parse(lines[0]);
    assert.strictEqual(started.event, "step:started");
    assert.ok(started.runId, "should have runId");
    assert.strictEqual(started.runId, ctx.runId, "runId must match ctx");
    assert.ok(started.stepId, "should have stepId");
    assert.strictEqual(started.node, "agent");
    assert.strictEqual(started.type, "agent");
    assert.strictEqual(started.attempt, 1);
    assert.strictEqual(started.ts, 1700000000000);

    // Line 2: step:succeeded
    const succeeded = JSON.parse(lines[1]);
    assert.strictEqual(succeeded.event, "step:succeeded");
    assert.strictEqual(succeeded.runId, ctx.runId);
    assert.strictEqual(succeeded.stepId, started.stepId,
      "stepId must match across start/succeed");
    assert.strictEqual(succeeded.node, "agent");
    assert.strictEqual(succeeded.type, "agent");
    assert.strictEqual(succeeded.attempt, 1);
    assert.strictEqual(succeeded.ts, 1700000000000);
  });

  it("writes step:failed with error field when error is provided", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const err = new Error("command failed");
    await runtime.logger.logStep(ctx, {
      node: "bash",
      type: "bash",
      attempt: 2,
      error: err,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    assert.strictEqual(lines.length, 2);

    const started = JSON.parse(lines[0]);
    assert.strictEqual(started.event, "step:started");

    const failed = JSON.parse(lines[1]);
    assert.strictEqual(failed.event, "step:failed");
    assert.ok(failed.error, "should have error field");
    assert.ok(failed.error.message.includes("command failed"),
      "error message should be preserved");
    assert.ok(failed.error.stack, "error stack should be preserved");
  });

  it("separates large output to artifact — JSONL contains outputRef, not full text", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const largeOutput = "x".repeat(1000);
    await runtime.logger.logStep(ctx, {
      node: "agent",
      type: "agent",
      attempt: 1,
      output: largeOutput,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const succeeded = JSON.parse(lines[1]);

    // Must have outputRef pointer, not inline output
    assert.ok(succeeded.outputRef, "large output must produce outputRef");
    assert.strictEqual(succeeded.output, undefined,
      "must not inline large output");

    // The JSONL line itself must be short (pointer, not full text)
    const lineLength = lines[1].length;
    assert.ok(lineLength < 500,
      `line should be short (${lineLength} < 500), output was separated`);

    // Artifact sink must receive the full content
    const artifactContent = fs.get(succeeded.outputRef);
    assert.strictEqual(artifactContent, largeOutput,
      "artifact sink must contain full output");
  });

  it("inlines small output directly in JSONL (no artifact)", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const smallOutput = "ok";
    await runtime.logger.logStep(ctx, {
      node: "bash",
      type: "bash",
      attempt: 1,
      output: smallOutput,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const succeeded = JSON.parse(lines[1]);

    assert.strictEqual(succeeded.output, smallOutput);
    assert.strictEqual(succeeded.outputRef, undefined,
      "small output must not produce outputRef");
  });

  it("uses fixed clock for deterministic timestamps", async () => {
    const fs = memoryFs();
    const fixedTime = 1712345678000;
    const runtime = createRuntime({ fs, clock: () => fixedTime });
    const ctx = runtime.createCtx({});

    await runtime.logger.logStep(ctx, {
      node: "test",
      type: "test",
      attempt: 1,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).ts, fixedTime,
      "step:started ts must match fixed clock");
    assert.strictEqual(JSON.parse(lines[1]).ts, fixedTime,
      "step:succeeded ts must match fixed clock");
  });

  // ── Artifact boundary ─────────────────────────────────────────────

  it("inlines output exactly at threshold (length === OUTPUT_INLINE_THRESHOLD)", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const exactOutput = "x".repeat(OUTPUT_INLINE_THRESHOLD);
    await runtime.logger.logStep(ctx, {
      node: "agent",
      type: "agent",
      attempt: 1,
      output: exactOutput,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const succeeded = JSON.parse(lines[1]);

    assert.strictEqual(succeeded.output, exactOutput,
      "output exactly at threshold must be inlined");
    assert.strictEqual(succeeded.outputRef, undefined,
      "output exactly at threshold must NOT produce outputRef");
  });

  it("separates output one past threshold (length === OUTPUT_INLINE_THRESHOLD + 1)", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const overOutput = "x".repeat(OUTPUT_INLINE_THRESHOLD + 1);
    await runtime.logger.logStep(ctx, {
      node: "agent",
      type: "agent",
      attempt: 1,
      output: overOutput,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const succeeded = JSON.parse(lines[1]);

    assert.ok(succeeded.outputRef, "output past threshold must produce outputRef");
    assert.strictEqual(succeeded.output, undefined,
      "output past threshold must NOT be inlined");

    const artifactContent = fs.get(succeeded.outputRef);
    assert.strictEqual(artifactContent, overOutput);
  });

  // ── Write failure ─────────────────────────────────────────────────

  it("rejects loudly when artifact writeFile fails, writes no fake outputRef line", async () => {
    const writeError = new Error("disk full");
    const fs = {
      files: new Map(),
      async writeFile(_path, _content) { throw writeError; },
      async appendFile(path, content) {
        this.files.set(path, (this.files.get(path) ?? "") + content);
      },
      get(path) { return this.files.get(path); },
    };
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const largeOutput = "x".repeat(OUTPUT_INLINE_THRESHOLD + 1);

    await assert.rejects(
      () => runtime.logger.logStep(ctx, {
        node: "agent",
        type: "agent",
        attempt: 1,
        output: largeOutput,
      }),
      writeError,
    );

    // The log must not contain a step:succeeded / step:failed line
    // with a fake outputRef pointing to a nonexistent artifact.
    const logContent = fs.get("run.log.jsonl") ?? "";
    const lines = logContent.trim().split("\n").filter(Boolean);
    // Only step:started should have been written before the failure
    assert.strictEqual(lines.length, 1, "only step:started should be written");
    const started = JSON.parse(lines[0]);
    assert.strictEqual(started.event, "step:started");
  });

  // ── Session lifecycle events ──────────────────────────────────────

  it("logSession writes session:open with required fields", async () => {
    const fs = memoryFs();
    const clock = () => 1712000000000;
    const runtime = createRuntime({ fs, clock });
    const ctx = runtime.createCtx({});

    const sessionId = "sess-abc123";
    await runtime.logger.logSession(ctx, {
      event: "session:open",
      sessionId,
      agent: "omp",
      model: "deepseek/deepseek-v4-pro",
      reused: false,
    });

    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n");
    assert.strictEqual(lines.length, 1, "logSession writes one line");

    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.event, "session:open");
    assert.strictEqual(entry.runId, ctx.runId);
    assert.strictEqual(entry.sessionId, sessionId);
    assert.strictEqual(entry.agent, "omp");
    assert.strictEqual(entry.model, "deepseek/deepseek-v4-pro");
    assert.strictEqual(entry.reused, false);
    assert.strictEqual(entry.ts, 1712000000000);
  });

  it("logSession writes session:close with reused flag", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await runtime.logger.logSession(ctx, {
      event: "session:close",
      sessionId: "sess-xyz",
      agent: "codex",
      model: "minimax-code-cn/MiniMax-M3",
      reused: true,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.event, "session:close");
    assert.strictEqual(entry.sessionId, "sess-xyz");
    assert.strictEqual(entry.agent, "codex");
    assert.strictEqual(entry.model, "minimax-code-cn/MiniMax-M3");
    assert.strictEqual(entry.reused, true);
    assert.ok(typeof entry.ts === "number");
  });

  it("logSession defaults reused to false when omitted", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await runtime.logger.logSession(ctx, {
      event: "session:open",
      sessionId: "sess-1",
      agent: "omp",
      model: "any",
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    assert.strictEqual(JSON.parse(lines[0]).reused, false);
  });

  it("logSession throws on invalid event type", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logSession(ctx, {
        event: "session:error",
        sessionId: "sess-1",
        agent: "omp",
        model: "any",
      }),
      /invalid event/,
    );
  });

  // ── Required field validation ────────────────────────────────────

  it("logStep throws when node is missing, writes nothing to log", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logStep(ctx, { type: "agent", attempt: 1 }),
      /node is required/,
    );
    // Log file must remain empty — nothing was written before the throw
    assert.strictEqual(fs.get("run.log.jsonl"), undefined,
      "log file must be empty when validation fails before any write");
  });

  it("logStep throws when type is missing, writes nothing to log", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logStep(ctx, { node: "agent", attempt: 1 }),
      /type is required/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logStep throws when attempt is missing (not defaulted), writes nothing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    // attempt defaults to 1 in destructuring, so we need to pass
    // something invalid — non-integer
    await assert.rejects(
      () => runtime.logger.logStep(ctx, { node: "a", type: "a", attempt: 0 }),
      /attempt must be a positive integer/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logSession throws when sessionId is missing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logSession(ctx, {
        event: "session:open",
        agent: "omp",
      }),
      /sessionId is required/,
    );
  });

  it("logSession throws when agent is missing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logSession(ctx, {
        event: "session:open",
        sessionId: "s-1",
      }),
      /agent is required/,
    );
  });

  it("logSession writes model as null when model is omitted", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await runtime.logger.logSession(ctx, {
      event: "session:open",
      sessionId: "s-1",
      agent: "omp",
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    // model must be explicitly null — not absent
    assert.strictEqual(entry.model, null,
      "model must be null (explicit), not absent");
    assert.ok("model" in entry, "model key must exist in the entry");
  });

  it("logSession throws when ctx.runId is not a string, writes nothing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const badCtx = { runId: () => "x" };

    await assert.rejects(
      () => runtime.logger.logSession(badCtx, {
        event: "session:open",
        sessionId: "s-1",
        agent: "omp",
      }),
      /ctx\.runId is required/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined,
      "log must be empty when validation fails before any write");
  });

  it("logSession throws when model is a function, writes nothing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logSession(ctx, {
        event: "session:open",
        sessionId: "s-1",
        agent: "omp",
        model: () => "deepseek",
      }),
      /model must be a non-empty string or null/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logSession throws when model is an object, writes nothing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logSession(ctx, {
        event: "session:close",
        sessionId: "s-1",
        agent: "codex",
        model: { provider: "x" },
      }),
      /model must be a non-empty string or null/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logSession throws when model is a number, writes nothing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logSession(ctx, {
        event: "session:open",
        sessionId: "s-1",
        agent: "omp",
        model: 42,
      }),
      /model must be a non-empty string or null/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logSession throws when model is an empty string, writes nothing", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () => runtime.logger.logSession(ctx, {
        event: "session:open",
        sessionId: "s-1",
        agent: "omp",
        model: "",
      }),
      /model must be a non-empty string or null/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  // ── input / inputRef (same artifact separation as output) ─────────

  it("inlines small input in logStep entry", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await runtime.logger.logStep(ctx, {
      node: "agent",
      type: "agent",
      attempt: 1,
      input: "hello world",
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const succeeded = JSON.parse(lines[1]);
    assert.strictEqual(succeeded.input, "hello world");
    assert.strictEqual(succeeded.inputRef, undefined);
  });

  it("separates large input to artifact — inputRef pointer, not inline", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});
    const largeInput = "y".repeat(OUTPUT_INLINE_THRESHOLD + 1);
    await runtime.logger.logStep(ctx, {
      node: "agent",
      type: "agent",
      attempt: 1,
      input: largeInput,
    });

    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const succeeded = JSON.parse(lines[1]);
    assert.ok(succeeded.inputRef, "large input must produce inputRef");
    assert.strictEqual(succeeded.input, undefined,
      "must not inline large input");
    const artifactContent = fs.get(succeeded.inputRef);
    assert.strictEqual(artifactContent, largeInput);
  });
  // ── meta ──────────────────────────────────────────────────────────
  it("merges meta fields into step entry", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});
    await runtime.logger.logStep(ctx, {
      node: "agent",
      type: "agent",
      attempt: 1,
      meta: { agent: "omp", model: "deepseek/v4" },
    });
    const lines = fs.get("run.log.jsonl").trim().split("\n");
    const succeeded = JSON.parse(lines[1]);
    assert.strictEqual(succeeded.agent, "omp");
    assert.strictEqual(succeeded.model, "deepseek/v4");
  });
  it("throws when meta contains a function value", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});
    await assert.rejects(
      () =>
        runtime.logger.logStep(ctx, {
          node: "agent",
          type: "agent",
          attempt: 1,
          meta: { fn: () => {} },
        }),
        /meta\.fn: functions are not allowed/,
      );
      assert.strictEqual(fs.get("run.log.jsonl"), undefined,
        "log must be empty when meta validation fails");
    });
});

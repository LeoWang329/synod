import { describe, it } from "node:test";
import assert from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

const FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "workflows",
);

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

describe("runner", () => {
  it("executes linear.mjs and returns expected result", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: [`reply-from-${opts.agent}`] }),
    });
    const ctx = runtime.createCtx({});

    // Dynamically import the flow module
    const linearPath = resolve(FIXTURES_ROOT, "valid", "linear.mjs");
    const flowModule = await import(linearPath);

    const result = await runFlow(runtime, flowModule, ctx, { topic: "test" });

    // Check return structure: agent → bash → agent
    assert.strictEqual(result.a, "reply-from-omp", "first agent reply");
    assert.deepStrictEqual(result.b, { stdout: "ok", stderr: "", code: 0 },
      "bash result");
    assert.strictEqual(result.c, "reply-from-codex", "second agent reply");
  });

  it("writes step events for all three nodes in correct order", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: [`r-${opts.agent}`] }),
    });
    const ctx = runtime.createCtx({});

    const linearPath = resolve(FIXTURES_ROOT, "valid", "linear.mjs");
    const flowModule = await import(linearPath);

    await runFlow(runtime, flowModule, ctx, {});

    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    const stepStarted = events.filter((e) => e.event === "step:started");
    assert.strictEqual(stepStarted.length, 3,
      "should have 3 step:started events");

    const stepSucceeded = events.filter((e) => e.event === "step:succeeded");
    assert.strictEqual(stepSucceeded.length, 3,
      "should have 3 step:succeeded events");

    // Verify order: agent(omp) → bash → agent(codex)
    const startedNodes = stepStarted.map((e) => e.node);
    assert.deepStrictEqual(startedNodes, ["omp", "bash", "codex"],
      "step order must be omp → bash → codex");
  });

  it("clears current runtime after run completes", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: ["ok"] }),
    });

    const linearPath = resolve(FIXTURES_ROOT, "valid", "linear.mjs");
    const flowModule = await import(linearPath);

    // Run once — should succeed
    const ctx = runtime.createCtx({});
    await runFlow(runtime, flowModule, ctx, {});
    // After run, the synod/flow proxy should throw (no active runtime)
    const { agent } = await import("synod/flow");
    const ctx2 = runtime.createCtx({});
    assert.throws(
      () => agent(ctx2, { agent: "omp", model: "m", prompt: "x" }),
      /No active flow runtime/,
    );
  });

  it("nested runFlow restores outer runtime, primitives still work after inner returns", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: ["ok"] }),
    });

    // Create a simple inner flow inline
    const innerFlow = {
      async run(_ctx, _input) {
        // Use the synod/flow proxy inside inner run
        const { agent } = await import("synod/flow");
        const result = await agent(_ctx, { agent: "codex", model: "m2", prompt: "inner" });
        return `inner:${result}`;
      },
    };

    const outerCtx = runtime.createCtx({});

    // Outer runFlow wraps inner runFlow
    await runFlow(runtime, {
      async run(ctx, _input) {
        // Call inner runFlow — this must save/restore the runtime
        const innerCtx = runtime.createCtx({});
        const innerResult = await runFlow(runtime, innerFlow, innerCtx, {});

        // After inner returns, outer can still call primitives
        const { bash } = await import("synod/flow");
        const b = await bash(ctx, "node -e 'process.stdout.write(\"outer\")'");

        return { innerResult, bashResult: b };
      },
    }, outerCtx, {});

    // Outer call works without "No active flow runtime" error
    assert.ok(true, "nested runFlow should not clear outer runtime");
  });

  it("disposes reused sessions when runFlow finishes (default path)", async () => {
    const fs = memoryFs();
    let opens = 0, closes = 0;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        opens++;
        const s = await fakeOpenBackend(opts);
        const origClose = s.close.bind(s);
        s.close = () => { closes++; return origClose(); };
        return s;
      },
    });
    const ctx = runtime.createCtx({});

    // Flow uses reuse:true
    const flow = {
      async run(_ctx, _input) {
        const { agent } = await import("synod/flow");
        await agent(_ctx, { agent: "omp", model: "m", prompt: "hi", reuse: true });
        return "done";
      },
    };

    await runFlow(runtime, flow, ctx, {});

    // runFlow's finally must close the reused session
    assert.strictEqual(closes, 1, "reused session must be closed by runFlow");

    // Second disposeRun is idempotent
    await runtime.disposeRun(ctx);
    assert.strictEqual(closes, 1, "second disposeRun must not double-close");
  });

  it("disposes reused sessions even when the flow throws", async () => {
    const fs = memoryFs();
    let closes = 0;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        const s = await fakeOpenBackend(opts);
        const origClose = s.close.bind(s);
        s.close = () => { closes++; return origClose(); };
        return s;
      },
    });
    const ctx = runtime.createCtx({});

    const flow = {
      async run(_ctx, _input) {
        const { agent } = await import("synod/flow");
        await agent(_ctx, { agent: "omp", model: "m", prompt: "hi", reuse: true });
        throw new Error("flow failed");
      },
    };

    await assert.rejects(
      () => runFlow(runtime, flow, ctx, {}),
      /flow failed/,
    );

    // dispose must still run (finally)
    assert.strictEqual(closes, 1, "reused session must be closed even when flow throws");
  });

  it("restores outer runtime even when disposeRun throws", async () => {
    const fs = memoryFs();
    // Outer runtime — normal
    const outerRuntime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    // Inner runtime — disposeRun will throw
    let innerDisposed = false;
    const innerRuntime = {
      ...createRuntime({ fs, clock: () => 0, openBackend: async (opts) => fakeOpenBackend(opts) }),
      async disposeRun(_ctx) {
        innerDisposed = true;
        throw new Error("dispose failed");
      },
    };

    const outerCtx = outerRuntime.createCtx({});

    // Outer runFlow wraps inner runFlow
    await runFlow(outerRuntime, {
      async run(_ctx, _input) {
        const innerCtx = innerRuntime.createCtx({});
        // inner runFlow — its disposeRun will throw
        await assert.rejects(
          () => runFlow(innerRuntime, { async run() { return "ok"; } }, innerCtx, {}),
          /dispose failed/,
        );
        // After inner runFlow throws, outer runtime must be restored
        const { bash } = await import("synod/flow");
        await bash(_ctx, "node -e '1'");
        return "recovered";
      },
    }, outerCtx, {});

    assert.ok(innerDisposed, "inner disposeRun was called");
    // If we got here without "No active flow runtime", restore worked
    assert.ok(true);
  });
});

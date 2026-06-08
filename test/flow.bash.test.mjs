import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";

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

describe("bash", () => {
  it("runs a command and returns {stdout, stderr, code:0}", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const result = await runtime.bash(ctx,
      'node -e "process.stdout.write(\'ok\')"');

    assert.deepStrictEqual(result, {
      stdout: "ok",
      stderr: "",
      code: 0,
    });
  });

  it("returns code ≠ 0 on failure, does not throw", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const result = await runtime.bash(ctx,
      'node -e "process.exit(42)"');

    assert.strictEqual(result.code, 42,
      "non-zero exit code should be returned, not thrown");
    assert.ok(typeof result.stderr === "string");
  });

  it("rejects loudly when success-path logStep fails (artifact write)", async () => {
    const writeErr = new Error("disk full");
    const fs = {
      files: new Map(),
      async writeFile(_path, _content) { throw writeErr; },
      async appendFile(path, content) {
        this.files.set(path, (this.files.get(path) ?? "") + content);
      },
      get(path) { return this.files.get(path); },
    };
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    // Large stdout triggers artifact write → logStep fails
    const largeCmd = `node -e "process.stdout.write('${"x".repeat(500)}')"`;

    await assert.rejects(
      () => runtime.bash(ctx, largeCmd),
      writeErr,
    );
  });

  it("failure path records stdout, stderr, and code in step log meta", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    const result = await runtime.bash(ctx,
      'node -e "process.stderr.write(\'err msg\'); process.exit(3)"');

    assert.strictEqual(result.code, 3);
    assert.strictEqual(result.stderr, "err msg");

    // Log should have step:started + step:succeeded (bash doesn't write
    // step:failed — it logs success and returns the error result)
    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n");
    const succeeded = JSON.parse(lines[1]);
    assert.strictEqual(succeeded.event, "step:succeeded");
    assert.strictEqual(succeeded.code, 3,
      "code should be in the entry (merged from meta)");
    assert.ok(succeeded.stderr.includes("err msg"),
      "stderr should be in the entry (merged from meta)");
    assert.ok(succeeded.input.includes("process.stderr"),
      "cmd should be in input");
  });
});

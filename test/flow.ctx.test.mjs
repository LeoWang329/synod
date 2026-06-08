import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createCtx } from "../src/flow/ctx.mjs";
import { createRuntime } from "../src/flow/runtime.mjs";

function noopFs() {
  const files = new Map();
  return {
    async writeFile(path, content) { files.set(path, content); },
    async appendFile(path, content) {
      files.set(path, (files.get(path) ?? "") + content);
    },
  };
}

describe("ctx", () => {
  it("is pure data — JSON.stringify does not throw", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    const ctx = runtime.createCtx({ topic: "test" });
    assert.doesNotThrow(() => JSON.stringify(ctx));
  });

  it("roundtrips without data loss (recursive deep equality)", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    const input = {
      topic: "test",
      nested: { a: 1, b: [2, 3, { c: true }] },
      arr: [{ x: null }, { y: "hello" }],
    };
    const ctx = runtime.createCtx(input);
    const json = JSON.stringify(ctx);
    const parsed = JSON.parse(json);
    assert.deepStrictEqual(parsed, ctx);
    // ctx.input must be a deep clone — mutating original input must not
    // affect ctx
    input.topic = "modified";
    input.nested.b.push(99);
    assert.strictEqual(ctx.input.topic, "test");
    assert.deepStrictEqual(ctx.input.nested.b, [2, 3, { c: true }]);
  });

  it("contains no functions or live objects at top level", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    const ctx = runtime.createCtx({});
    for (const [key, val] of Object.entries(ctx)) {
      const t = typeof val;
      assert.ok(
        t === "string" || t === "number" || t === "boolean" ||
          (t === "object" && val !== null),
        `ctx.${key} has type ${t}, expected plain data`,
      );
    }
  });

  it("each createCtx call produces unique runId", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    const ctx1 = runtime.createCtx({});
    const ctx2 = runtime.createCtx({});
    assert.notStrictEqual(ctx1.runId, ctx2.runId);
  });

  it("preserves input on ctx (deep-cloned)", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    const ctx = runtime.createCtx({ x: 1, y: "hello" });
    assert.deepStrictEqual(ctx.input, { x: 1, y: "hello" });
  });

  // ── Rejection cases ───────────────────────────────────────────────

  it("rejects input containing a function", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ fn: () => {} }),
      /input\.fn: functions are not allowed/,
    );
    assert.throws(
      () => runtime.createCtx({ nested: { fn: function foo() {} } }),
      /input\.nested\.fn: functions are not allowed/,
    );
  });

  it("rejects input containing an EventEmitter", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ ee: new EventEmitter() }),
      /input\.ee: non-plain object \(EventEmitter\) is not allowed/,
    );
  });

  it("rejects input containing a Date", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ when: new Date() }),
      /input\.when: non-plain object \(Date\) is not allowed/,
    );
  });

  it("rejects input containing a Map", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ m: new Map() }),
      /input\.m: non-plain object \(Map\) is not allowed/,
    );
  });

  it("rejects input containing a Set", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ s: new Set() }),
      /input\.s: non-plain object \(Set\) is not allowed/,
    );
  });

  it("rejects input containing a RegExp", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ re: /foo/ }),
      /input\.re: non-plain object \(RegExp\) is not allowed/,
    );
  });

  it("rejects input containing NaN or Infinity", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ val: NaN }),
      /non-finite number/,
    );
    assert.throws(
      () => runtime.createCtx({ val: Infinity }),
      /non-finite number/,
    );
    assert.throws(
      () => runtime.createCtx({ val: -Infinity }),
      /non-finite number/,
    );
  });

  it("rejects input containing undefined", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ val: undefined }),
      /input\.val: undefined is not allowed/,
    );
  });

  it("rejects input containing bigint", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ val: 1n }),
      /input\.val: bigint is not allowed/,
    );
  });

  it("rejects input containing a symbol", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.throws(
      () => runtime.createCtx({ val: Symbol("x") }),
      /input\.val: symbols are not allowed/,
    );
  });

  it("rejects input with circular references", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    const obj = { a: 1 };
    obj.self = obj;
    assert.throws(
      () => runtime.createCtx(obj),
      /circular reference/,
    );
  });

  // ── runId / cwd validation ──────────────────────────────────────

  it("rejects non-string runId (function)", () => {
    assert.throws(
      () => createCtx({ runId: () => "x", input: {} }),
      /runId must be a string/,
    );
  });

  it("rejects non-string runId (number)", () => {
    assert.throws(
      () => createCtx({ runId: 42, input: {} }),
      /runId must be a string/,
    );
  });

  it("rejects non-string cwd (Date)", () => {
    assert.throws(
      () => createCtx({ cwd: new Date(), input: {} }),
      /cwd must be a string/,
    );
  });

  it("rejects non-string cwd (object)", () => {
    assert.throws(
      () => createCtx({ cwd: { path: "/tmp" }, input: {} }),
      /cwd must be a string/,
    );
  });

  it("accepts explicit string runId and cwd", () => {
    const ctx = createCtx({ runId: "my-run", cwd: "/my/dir", input: {} });
    assert.strictEqual(ctx.runId, "my-run");
    assert.strictEqual(ctx.cwd, "/my/dir");
  });
});

// ── Runtime DI contract ────────────────────────────────────────────

describe("runtime", () => {
  it("exposes injected openBackend sentinel (injection works)", () => {
    const sentinel = async () => "fake-backend";
    const runtime = createRuntime({
      fs: noopFs(),
      clock: () => 0,
      openBackend: sentinel,
    });
    assert.strictEqual(runtime.openBackend, sentinel);
  });

  it("exposes injected io sentinel", () => {
    const sentinel = { stdin: "fake", stdout: "fake" };
    const runtime = createRuntime({
      fs: noopFs(),
      clock: () => 0,
      io: sentinel,
    });
    assert.strictEqual(runtime.io, sentinel);
  });

  it("defaults openBackend to real implementation when not injected", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.strictEqual(typeof runtime.openBackend, "function");
    assert.ok(runtime.openBackend !== undefined);
  });

  it("io defaults to real process stdio when not injected", () => {
    const runtime = createRuntime({ fs: noopFs(), clock: () => 0 });
    assert.ok(runtime.io && typeof runtime.io === "object", "io should default to real process stdio");
    assert.strictEqual(runtime.io.stdout, process.stdout);
    assert.strictEqual(runtime.io.stdin, process.stdin);
  });

  it("exposes fs and clock for transparency", () => {
    const fsSentinel = noopFs();
    const clockSentinel = () => 42;
    const runtime = createRuntime({ fs: fsSentinel, clock: clockSentinel });
    assert.strictEqual(runtime.fs, fsSentinel);
    assert.strictEqual(runtime.clock, clockSentinel);
  });
});

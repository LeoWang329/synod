import { describe, it } from "node:test";
import assert from "node:assert";
import { createDeferScope } from "../src/flow/defer.mjs";

describe("defer", () => {
  it("executes registered callbacks in LIFO reverse order on success", async () => {
    const calls = [];
    const scope = createDeferScope();
    scope.defer(() => calls.push("third"));
    scope.defer(() => calls.push("second"));
    scope.defer(() => calls.push("first"));

    await scope.run(async () => {
      calls.push("work");
    });

    assert.deepStrictEqual(calls, ["work", "first", "second", "third"]);
  });

  it("executes defers in LIFO order even when the work function throws", async () => {
    const calls = [];
    const scope = createDeferScope();
    scope.defer(() => calls.push("cleanup1"));
    scope.defer(() => calls.push("cleanup2"));

    let caught = null;
    try {
      await scope.run(async () => {
        calls.push("work");
        throw new Error("boom");
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, "error should propagate");
    assert.strictEqual(caught.message, "boom");
    // cleanup2 registered last → runs first (LIFO)
    assert.deepStrictEqual(calls, ["work", "cleanup2", "cleanup1"]);
  });

  it("continues running remaining defers when a middle defer throws (LIFO)", async () => {
    const calls = [];
    const scope = createDeferScope();
    // Registration order: oldest → bad(middle) → newest
    scope.defer(() => calls.push("oldest"));          // registered first, runs last
    scope.defer(() => {
      calls.push("bad");
      throw new Error("defer-fail");
    });                                               // registered second, runs second
    scope.defer(() => calls.push("newest"));           // registered last, runs first

    // No work error — defer error should be the one re-thrown
    let caught = null;
    try {
      await scope.run(async () => {
        calls.push("work");
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, "defer error should be re-thrown");
    assert.strictEqual(caught.message, "defer-fail");
    // LIFO: newest → bad(throws) → oldest.  Oldest still runs after bad throws.
    assert.deepStrictEqual(calls, ["work", "newest", "bad", "oldest"]);
  });

  it("when both work and a defer throw, work error takes precedence", async () => {
    const calls = [];
    const scope = createDeferScope();
    scope.defer(() => {
      calls.push("defer-boom");
      throw new Error("defer-error");
    });

    let caught = null;
    try {
      await scope.run(async () => {
        calls.push("work");
        throw new Error("work-error");
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, "error should propagate");
    assert.strictEqual(caught.message, "work-error", "work error takes precedence");
    assert.deepStrictEqual(calls, ["work", "defer-boom"]);
  });

  it("returns fn result on success", async () => {
    const scope = createDeferScope();
    scope.defer(() => {});

    const result = await scope.run(async () => 42);

    assert.strictEqual(result, 42);
  });

  it("supports async defer callbacks", async () => {
    const calls = [];
    const scope = createDeferScope();
    scope.defer(async () => {
      await new Promise((r) => setTimeout(r, 5));
      calls.push("async-defer");
    });

    await scope.run(async () => {
      calls.push("work");
    });

    assert.deepStrictEqual(calls, ["work", "async-defer"]);
  });

  it("dispose() runs remaining defers without a work function", async () => {
    const calls = [];
    const scope = createDeferScope();
    scope.defer(() => calls.push("first"));
    scope.defer(() => calls.push("second"));

    await scope.dispose();

    assert.deepStrictEqual(calls, ["second", "first"]);
  });

  it("dispose() re-throws the first defer error", async () => {
    const calls = [];
    const scope = createDeferScope();
    scope.defer(() => {
      calls.push("bad");
      throw new Error("dispose-fail");
    });
    scope.defer(() => calls.push("good"));

    let caught = null;
    try {
      await scope.dispose();
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, "dispose error should be re-thrown");
    assert.strictEqual(caught.message, "dispose-fail");
    assert.deepStrictEqual(calls, ["good", "bad"]);
  });

  it("dispose() is a no-op when no defers are registered", async () => {
    const scope = createDeferScope();
    // Should not throw
    await scope.dispose();
  });

  it("run() is a no-op for defers when fn succeeds and no defers registered", async () => {
    const scope = createDeferScope();
    const result = await scope.run(async () => "ok");
    assert.strictEqual(result, "ok");
  });

  it("P2-40 fn 与 defer 同时抛 → defer 错误附着到 fnErr.suppressed", async () => {
    const scope = createDeferScope();
    scope.defer(() => { throw new Error("defer-boom"); });
    await assert.rejects(
      scope.run(async () => { throw new Error("fn-boom"); }),
      (err) => {
        assert.equal(err.message, "fn-boom");
        assert.ok(err.suppressed instanceof Error, "defer 错误必须附着");
        assert.equal(err.suppressed.message, "defer-boom");
        return true;
      },
    );
  });
});

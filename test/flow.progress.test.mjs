/**
 * test/flow.progress.test.mjs — Progress visibility + per-call delta
 * subscription tests (IMPLEMENTATION_SPEC 测试节 1–5).
 *
 * Uses FakeSession (zero real agent) and a collector sink.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { createDefaultProgressSink } from "../src/flow.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

/** In-memory filesystem sink (no real disk). */
function memoryFs() {
  const files = new Map();
  return {
    async writeFile(path, content) { files.set(path, content); },
    async appendFile(path, content) {
      files.set(path, (files.get(path) ?? "") + content);
    },
  };
}

/**
 * Collector sink — records every emit() call for assertions.
 * Can be configured to throw on specific event types to test error paths.
 */
function collectorSink({ throwOn } = {}) {
  const events = [];
  return {
    events,
    emit(event) {
      if (throwOn && throwOn.has(event.type)) {
        throw new Error(`sink throw: ${event.type}`);
      }
      events.push({ ...event });
    },
  };
}

describe("progress visibility", () => {
  // ── 1. per-call 退订 ──────────────────────────────────────────────

  it("listenerCount('delta') === 0 after agent() completes (no residue)", async () => {
    const fs = memoryFs();
    let capturedSession = null;
    const openBackend = async (opts) => {
      const s = await fakeOpenBackend(opts);
      capturedSession = s;
      return s;
    };

    const sink = collectorSink();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend,
      progress: sink,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "test-model",
      prompt: "hello",
    });

    assert.ok(capturedSession, "session should have been created");
    // After send completes, the per-call finally should have removed the listener
    assert.strictEqual(
      capturedSession.listenerCount("delta"),
      0,
      "no residual delta listener after agent() call",
    );
  });

  // ── 2. reuse 不漏尾巴 ─────────────────────────────────────────────

  it("reuse: same runtime, same ctx — reuse branch hit, no delta leak between calls", async () => {
    const fs = memoryFs();
    let openCount = 0;
    let capturedSession = null;

    const openBackend = async (opts) => {
      openCount++;
      const s = await fakeOpenBackend({
        ...opts,
        // texts[N] returned for turn N (per FakeSession send() contract)
        texts: ["first-turn-response", "second-turn-response"],
      });
      capturedSession = s;
      return s;
    };

    const sink = collectorSink();
    const runtime = createRuntime({ fs, clock: () => 0, openBackend, progress: sink });
    const ctx = runtime.createCtx({});

    // ── First call — opens session ──────────────────────────────────
    const text1 = await runtime.agent(ctx, {
      agent: "omp",
      model: "x",
      prompt: "first question",
      reuse: true,
    });

    assert.strictEqual(openCount, 1, "first call should open backend exactly once");
    assert.ok(text1.includes("first-turn-response"), "first call returns correct text");
    assert.strictEqual(
      capturedSession.listenerCount("delta"),
      0,
      "no residual delta listener after first call",
    );

    // Between calls: emit a manual stale delta — sink should NOT receive it
    const eventCountBeforeManual = sink.events.length;
    capturedSession.emit("delta", "stale-from-first-call");
    assert.strictEqual(
      sink.events.length,
      eventCountBeforeManual,
      "manual delta between calls must not reach sink (per-call listener cleaned)",
    );

    // ── Second call — should REUSE, not open again ───────────────────
    const text2 = await runtime.agent(ctx, {
      agent: "omp",
      model: "x",
      prompt: "second question",
      reuse: true,
    });

    assert.strictEqual(openCount, 1, "second call must reuse session, not open again");
    assert.ok(text2.includes("second-turn-response"), "second call returns its own text");
    assert.strictEqual(
      capturedSession.listenerCount("delta"),
      0,
      "no residual delta listener after second call",
    );

    // start fires on every send, including the reused second call
    assert.strictEqual(
      sink.events.filter((e) => e.type === "start").length,
      2,
      "each agent() send emits a start event (incl. reuse)",
    );

    // DisposeRun closes the reused session
    await runtime.disposeRun(ctx);
    assert.strictEqual(capturedSession._closed, true, "disposeRun must close reused session");
  });
  // ── 3. disposeRun 之后不再收到 delta ──────────────────────────────

  it("after disposeRun, manual session emit delta does not reach sink", async () => {
    const fs = memoryFs();
    let capturedSession = null;
    const openBackend = async (opts) => {
      const s = await fakeOpenBackend(opts);
      capturedSession = s;
      return s;
    };

    const sink = collectorSink();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend,
      progress: sink,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "hello",
      reuse: true,
    });

    // Dispose the run (closes reused sessions)
    await runtime.disposeRun(ctx);

    // Record current event count
    const eventCountBefore = sink.events.length;

    // Manually emit delta — sink should NOT receive (listener was per-call cleaned)
    capturedSession.emit("delta", "stale-delta");

    assert.strictEqual(
      sink.events.length,
      eventCountBefore,
      "sink should not receive delta after disposeRun (per-call listener cleaned)",
    );
  });

  // ── 4. sink 抛错不污染 ────────────────────────────────────────────

  it("sink.emit throws → agent() still returns text, error in lastSinkError", async () => {
    const fs = memoryFs();
    const sink = collectorSink({ throwOn: new Set(["delta"]) });

    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: (opts) => fakeOpenBackend({ ...opts, deltas: ["hello"] }),
      progress: sink,
    });
    const ctx = runtime.createCtx({});

    // Should NOT throw despite sink.emit throwing on delta
    const text = await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "hello",
    });

    assert.ok(typeof text === "string" && text.length > 0, "agent() should return text normally");
    const rs = runtime._getRunState(ctx.runId);
    assert.ok(
      rs.lastSinkError instanceof Error,
      "lastSinkError should capture the sink error",
    );
  });

  // ── 5. opening 先于 delta ─────────────────────────────────────────

  it("sink events: 'opening' appears before any 'delta'", async () => {
    const fs = memoryFs();
    const sink = collectorSink();

    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: (opts) => fakeOpenBackend({ ...opts, deltas: ["a", "b"] }),
      progress: sink,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "hello",
    });

    // Find the first delta and check that opening is before it
    const firstDeltaIdx = sink.events.findIndex((e) => e.type === "delta");
    assert.ok(firstDeltaIdx >= 0, "should have at least one delta event");

    // Check that we have an "opening" event
    const openingEvents = sink.events.filter((e) => e.type === "opening");
    assert.ok(openingEvents.length >= 1, "should have at least one opening event");

    // All opening events must appear before the first delta
    for (const oe of openingEvents) {
      const idx = sink.events.indexOf(oe);
      assert.ok(
        idx < firstDeltaIdx,
        `opening at index ${idx} must be before first delta at index ${firstDeltaIdx}`,
      );
    }
  });
});

// ── default stdout sink: per-line prefix + agent-boundary line breaks ───────

/** Capture every write into a single string. */
function captureStdout() {
  let buf = "";
  return {
    write(s) { buf += s; },
    get out() { return buf; },
  };
}

describe("default progress sink — line boundaries", () => {
  it("multi-line delta: every line gets its [agent:model] prefix", () => {
    const cap = captureStdout();
    const sink = createDefaultProgressSink(cap);
    sink.emit({ type: "start", agent: "omp", model: "m" });
    sink.emit({ type: "delta", agent: "omp", model: "m", text: "a\nb\n" });
    assert.strictEqual(cap.out, "[omp:m] a\n[omp:m] b\n");
  });

  it("reuse seam: 2nd agent (no opening, prev line unterminated) starts a fresh prefixed line", () => {
    const cap = captureStdout();
    const sink = createDefaultProgressSink(cap);
    // agent A leaves a dangling (newline-less) line
    sink.emit({ type: "start", agent: "omp", model: "ds" });
    sink.emit({ type: "delta", agent: "omp", model: "ds", text: "question" });
    // agent B reuses its session → only a start event, no opening
    sink.emit({ type: "start", agent: "omp", model: "mm" });
    sink.emit({ type: "delta", agent: "omp", model: "mm", text: "answer" });
    // B must NOT run onto A's tail; it gets a newline + its own prefix
    assert.strictEqual(cap.out, "[omp:ds] question\n[omp:mm] answer");
  });

  it("opening also breaks a dangling line first", () => {
    const cap = captureStdout();
    const sink = createDefaultProgressSink(cap);
    sink.emit({ type: "start", agent: "omp", model: "ds" });
    sink.emit({ type: "delta", agent: "omp", model: "ds", text: "q" });
    sink.emit({ type: "opening", agent: "omp", model: "mm" });
    assert.strictEqual(cap.out, "[omp:ds] q\n[omp:mm] opening...\n");
  });

  it("start is a no-op when already at line start (no spurious blank line)", () => {
    const cap = captureStdout();
    const sink = createDefaultProgressSink(cap);
    sink.emit({ type: "start", agent: "omp", model: "m" });
    sink.emit({ type: "delta", agent: "omp", model: "m", text: "x\n" });
    sink.emit({ type: "start", agent: "omp", model: "m" }); // already at line start
    sink.emit({ type: "delta", agent: "omp", model: "m", text: "y\n" });
    assert.strictEqual(cap.out, "[omp:m] x\n[omp:m] y\n");
  });
});

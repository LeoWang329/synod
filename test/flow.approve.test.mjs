import { describe, it } from "node:test";
import assert from "node:assert";
import { PassThrough } from "node:stream";
import { createRuntime, makeQuestion } from "../src/flow/runtime.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

// ── Test helpers ────────────────────────────────────────────────────────

/** In-memory filesystem sink for logger assertions (same pattern as agent test). */
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
 * createFakeIo — simple line-queue programmable io for basic approve tests.
 *
 * `io.stdin.feed(line)` feeds a line; `io.question(prompt, { signal })`
 * returns a Promise<string> that resolves to the next fed line.
 */
function createFakeIo() {
  const _lines = [];
  const stdout = { write(s) { _lines.push(s); }, get lines() { return _lines; } };

  let _pendingResolve = null;
  let _lineQueue = [];

  function feed(line) {
    if (_pendingResolve) {
      const r = _pendingResolve;
      _pendingResolve = null;
      r(line);
    } else {
      _lineQueue.push(line);
    }
  }

  return {
    stdout,
    stdin: { feed },
    question(prompt, { signal } = {}) {
      if (_pendingResolve) throw new Error("a question is already pending");
      if (prompt != null) stdout.write(String(prompt));

      // Create the take-promise BEFORE handling signal so _pendingResolve
      // is set atomically with the guard check above.
      const takePromise = new Promise((resolve) => {
        if (_lineQueue.length > 0) {
          resolve(_lineQueue.shift());
        } else {
          _pendingResolve = resolve;
        }
      });

      if (!signal) return takePromise;
      if (signal.aborted) {
        // Release the pending slot
        _pendingResolve = null;
        return Promise.reject(
          Object.assign(new Error("Aborted"), { name: "AbortError" }),
        );
      }

      return new Promise((resolve, reject) => {
        const onAbort = () => {
          _pendingResolve = null;
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        takePromise.then(resolve, reject);
      });
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("approve", () => {
  it('accepts "accept" → {accepted:true}', async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });

    const ctx = runtime.createCtx({ input: {} });
    const pending = runtime.approve(ctx, { content: "review me" });

    await new Promise((r) => setImmediate(r));
    io.stdin.feed("accept");
    const result = await pending;

    assert.deepStrictEqual(result, { accepted: true });
    assert.ok(
      io.stdout.lines.some((l) => l.includes("review me")),
      "stdout must present the content for review",
    );
  });

  it('accepts "y" / "yes" / "ok" / "approve"', async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });

    for (const word of ["y", "yes", "ok", "approve"]) {
      const ctx = runtime.createCtx({ input: {} });
      const pending = runtime.approve(ctx, { content: "x" });
      await new Promise((r) => setImmediate(r));
      io.stdin.feed(word);
      const result = await pending;
      assert.deepStrictEqual(result, { accepted: true }, `word: ${word}`);
    }
  });

  it("/abort → {aborted:true}", async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = runtime.createCtx({ input: {} });

    const pending = runtime.approve(ctx, { content: "x" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("/abort");
    const result = await pending;
    assert.deepStrictEqual(result, { aborted: true });
  });

  it("/ABORT and /Abort are also aborted (case-insensitive)", async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });

    for (const word of ["/ABORT", "/Abort"]) {
      const ctx = runtime.createCtx({ input: {} });
      const pending = runtime.approve(ctx, { content: "x" });
      await new Promise((r) => setImmediate(r));
      io.stdin.feed(word);
      const result = await pending;
      assert.deepStrictEqual(result, { aborted: true }, `word: ${word}`);
    }
  });

  it("empty line → {aborted:true}", async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = runtime.createCtx({ input: {} });

    const pending = runtime.approve(ctx, { content: "x" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("");
    const result = await pending;
    assert.deepStrictEqual(result, { aborted: true });
  });

  it('free-form feedback → {accepted:false, feedback:"…"}', async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = runtime.createCtx({ input: {} });

    const pending = runtime.approve(ctx, { content: "x" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("请改进输出格式");
    const result = await pending;

    assert.deepStrictEqual(result, {
      accepted: false,
      feedback: "请改进输出格式",
    });
  });

  it("logs each approval round with input=content, output=decision", async () => {
    const fs = memoryFs();
    const io = createFakeIo();
    const runtime = createRuntime({ fs, clock: () => 0, io });

    const ctx = runtime.createCtx({ input: {} });
    const pending = runtime.approve(ctx, { content: "hello" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("accept");
    await pending;

    const logContent = fs.get("run.log.jsonl");
    assert.ok(logContent, "log must exist");
    const lines = logContent.trim().split("\n").map(JSON.parse);
    const stepLines = lines.filter(
      (l) => l.event === "step:started" || l.event === "step:succeeded",
    );
    assert.equal(stepLines.length, 2, "must have started + succeeded");
    assert.equal(stepLines[0].node, "approve");
    assert.equal(stepLines[1].node, "approve");
    assert.equal(stepLines[1].input, "hello");
    assert.equal(stepLines[1].output, "accept");
    assert.equal(stepLines[1].accepted, true);
  });

  it("logs aborted with output=/abort", async () => {
    const fs = memoryFs();
    const io = createFakeIo();
    const runtime = createRuntime({ fs, clock: () => 0, io });

    const ctx = runtime.createCtx({ input: {} });
    const pending = runtime.approve(ctx, { content: "doc" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("/abort");
    await pending;

    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n").map(JSON.parse);
    const succeeded = lines.find((l) => l.event === "step:succeeded");
    assert.equal(succeeded.input, "doc");
    assert.equal(succeeded.output, "/abort");
    assert.equal(succeeded.aborted, true);
  });

  it("logs feedback with output=feedback text", async () => {
    const fs = memoryFs();
    const io = createFakeIo();
    const runtime = createRuntime({ fs, clock: () => 0, io });

    const ctx = runtime.createCtx({ input: {} });
    const pending = runtime.approve(ctx, { content: "doc" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("needs work");
    await pending;

    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n").map(JSON.parse);
    const succeeded = lines.find((l) => l.event === "step:succeeded");
    assert.equal(succeeded.input, "doc");
    assert.equal(succeeded.output, "needs work");
    assert.equal(succeeded.accepted, false);
  });

  // ── Abort signal ───────────────────────────────────────────────────

  it("abort signal aborts waiting approve", async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = runtime.createCtx({ input: {} });
    const controller = new AbortController();

    const pending = runtime.approve(ctx, {
      content: "x",
      signal: controller.signal,
    });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const result = await pending;

    assert.deepStrictEqual(result, { aborted: true });
  });

  it("already-aborted signal resolves immediately", async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = runtime.createCtx({ input: {} });
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.approve(ctx, {
      content: "x",
      signal: controller.signal,
    });

    assert.deepStrictEqual(result, { aborted: true });
  });

  it("abort signal — log is complete immediately after await", async () => {
    // Use the real makeQuestion with PassThrough so we exercise the
    // actual AbortError path through io.question(), not the fake.
    const stdin = new PassThrough();
    const stdout = { _lines: [], write(s) { this._lines.push(s); } };
    const { question } = makeQuestion(stdin, stdout);
    const io = { stdout, stdin, question };

    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0, io });
    const ctx = runtime.createCtx({ input: {} });
    const controller = new AbortController();

    const approvePromise = runtime.approve(ctx, {
      content: "doc-under-review",
      signal: controller.signal,
    });

    // Let question() set up its pending state
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const result = await approvePromise;

    assert.deepStrictEqual(result, { aborted: true });

    // Immediately after await, both log lines must be present —
    // no race condition between step:started and step:succeeded.
    const logContent = fs.get("run.log.jsonl");
    assert.ok(logContent, "log must exist");
    const lines = logContent.trim().split("\n").map(JSON.parse);
    const stepLines = lines.filter(
      (l) => l.event === "step:started" || l.event === "step:succeeded",
    );
    assert.equal(stepLines.length, 2, "must have both started + succeeded");

    const succeeded = stepLines[1];
    assert.equal(succeeded.event, "step:succeeded");
    assert.equal(succeeded.input, "doc-under-review");
    assert.equal(succeeded.output, "/abort");
    assert.equal(succeeded.aborted, true);
    assert.equal(succeeded.accepted, false);
  });

  // ── Smoke: event loop not blocked (real makeQuestion + PassThrough) ─

  describe("smoke: event loop not blocked", () => {
    it("async delta arrives while approve is still pending", async () => {
      // Build io with the REAL makeQuestion on a PassThrough
      const stdin = new PassThrough();
      const _lines = [];
      const stdout = { write(s) { _lines.push(s); }, get lines() { return _lines; } };
      const { question } = makeQuestion(stdin, stdout);
      const io = { stdout, stdin, question };

      const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });
      const ctx = runtime.createCtx({ input: {} });

      let approveSettled = false;
      const approvePromise = runtime
        .approve(ctx, { content: "review" })
        .then((r) => { approveSettled = true; return r; });

      await new Promise((r) => setImmediate(r));
      assert.equal(approveSettled, false, "approve must not be settled yet");

      // Async delta via timer while approve waits
      const deltasReceived = [];
      const session = new FakeSession({
        agent: "omp",
        text: "final",
        deltas: ["chunk1", "chunk2", "chunk3"],
      });
      session.on("delta", (d) => deltasReceived.push(d));

      await new Promise((resolve) => {
        setTimeout(() => {
          session.send("hello", { wait: false });
          assert.equal(approveSettled, false,
            "approve must NOT be settled when async delta fires");
          resolve();
        }, 5);
      });

      assert.deepStrictEqual(deltasReceived, ["chunk1", "chunk2", "chunk3"]);

      // Feed the approval line
      stdin.write("accept\n");
      const result = await approvePromise;
      assert.deepStrictEqual(result, { accepted: true });
    });
  });

  // ── Abort listener cleanup (A1) ───────────────────────────────────────

  it("abort listener removed after normal ask resolves (no leak)", async () => {
    const io = createFakeIo();
    const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = runtime.createCtx({ input: {} });

    const controller = new AbortController();
    const signal = controller.signal;
    // Patch removeEventListener to count "abort" removals
    let removeCount = 0;
    const _origRemove = signal.removeEventListener.bind(signal);
    signal.removeEventListener = (type, ...args) => {
      if (type === "abort") removeCount++;
      return _origRemove(type, ...args);
    };

    const pending = runtime.approve(ctx, { content: "check", signal });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("accept");
    await pending;

    assert.strictEqual(
      removeCount,
      1,
      "removeEventListener('abort') must be called once after ask resolves — no leak",
    );
  });

  // ── Smoke: stdin single-owner (tested on REAL makeQuestion) ─────────

  describe("smoke: stdin single-owner", () => {
    it("concurrent question() throws — real guard via makeQuestion + PassThrough", () => {
      // Construct the REAL question() on a PassThrough — same code path
      // as defaultIo(), but with a controllable stream.
      const stdin = new PassThrough();
      const stdout = { _lines: [], write(s) { this._lines.push(s); } };
      const { question } = makeQuestion(stdin, stdout);

      // First question — must succeed (no throw)
      const p1 = question("prompt: ");

      // Second question while first is pending — must throw synchronously.
      // This proves the _pending guard works on the real implementation.
      assert.throws(
        () => question("CLI: "),
        /already pending/,
        "concurrent question must throw (real makeQuestion guard)",
      );

      // Feed a line — first question resolves, guard cleared
      stdin.write("ok\n");

      // After p1 resolves, a new question must work
      return p1.then((line) => {
        assert.equal(line, "ok");
        // Guard cleared — third question succeeds
        const p3 = question("third: ");
        stdin.write("yes\n");
        return p3.then((l3) => assert.equal(l3, "yes"));
      });
    });

    it("two serial approve calls do not conflict", async () => {
      const io = createFakeIo();
      const runtime = createRuntime({ fs: memoryFs(), clock: () => 0, io });

      const ctx1 = runtime.createCtx({ input: {} });
      const p1 = runtime.approve(ctx1, { content: "a" });
      await new Promise((r) => setImmediate(r));
      io.stdin.feed("accept");
      assert.deepStrictEqual(await p1, { accepted: true });

      const ctx2 = runtime.createCtx({ input: {} });
      const p2 = runtime.approve(ctx2, { content: "b" });
      await new Promise((r) => setImmediate(r));
      io.stdin.feed("y");
      assert.deepStrictEqual(await p2, { accepted: true });
    });
  });
});

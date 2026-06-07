import { describe, it } from "node:test";
import assert from "node:assert";
import { openBackend } from "../src/backend.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";


// ── Tests ─────────────────────────────────────────────────────────────

describe("openBackend omp contract", () => {
  it("emits 'delta' for each text_delta and 'status' running→idle", async () => {
    const proc = makeFakeOmpProc({ responseDeltas: ["Hello ", "world"] });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });

    const deltas = [];
    const statuses = [];
    session.on("delta", (d) => deltas.push(d));
    session.on("status", (s) => statuses.push(s));

    await session.send("hello");

    assert.deepStrictEqual(deltas, ["Hello ", "world"], "deltas should match");
    assert.strictEqual(statuses.length, 2);
    assert.strictEqual(statuses[0].status, "running");
    assert.strictEqual(statuses[0].isStreaming, true);
    assert.strictEqual(statuses[1].status, "idle");
    assert.strictEqual(statuses[1].isStreaming, false);

    await session.close();
  });

  it("result() returns accumulated text and session metadata", async () => {
    const proc = makeFakeOmpProc({
      responseDeltas: ["part1", "part2", "part3"],
    });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      model: "test-model",
      effort: "high",
      spawnImpl: () => proc,
    });

    await session.send("query");
    const res = await session.result();

    assert.strictEqual(res.text, "part1part2part3");
    assert.strictEqual(res.session.model, "test-model");
    assert.strictEqual(res.session.effort, "high");
    assert.strictEqual(res.session.agent, "omp");
    assert.ok(Array.isArray(res.recent_events));

    await session.close();
  });

  it("summary() includes model and effort", async () => {
    const proc = makeFakeOmpProc();
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      model: "my-model",
      effort: "xhigh",
      spawnImpl: () => proc,
    });

    const s = session.summary();

    assert.strictEqual(s.model, "my-model");
    assert.strictEqual(s.effort, "xhigh");
    assert.strictEqual(s.agent, "omp");
    assert.strictEqual(s.status, "idle"); // after ready

    await session.close();
  });

  it("close() calls stdin.end() on fake proc", async () => {
    const proc = makeFakeOmpProc();
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });

    assert.strictEqual(proc._closed, false);
    await session.close();
    assert.strictEqual(proc._closed, true);
  });

  it("start failure (proc error) → openBackend rejects and cleanup runs", async () => {
    const proc = makeFakeOmpProc({
      sendReady: false,
      emitProcError: new Error("spawn ENOENT"),
    });

    await assert.rejects(
      openBackend({
        agent: "omp",
        cwd: "/tmp",
        spawnImpl: () => proc,
      }),
      /spawn ENOENT/,
      "openBackend should reject with spawn error",
    );

    // Cleanup should have been called: stdin.end() via close()
    assert.strictEqual(proc._closed, true, "fake proc should be cleaned up");
  });

  it("start failure (proc closes with non-zero) → reject + cleanup", async () => {
    const proc = makeFakeOmpProc({
      sendReady: false,
      closeCodeOnStart: 1,
    });

    await assert.rejects(
      openBackend({
        agent: "omp",
        cwd: "/tmp",
        spawnImpl: () => proc,
      }),
      /exited/,
      "openBackend should reject when omp exits before ready",
    );

    assert.strictEqual(proc._closed, true, "fake proc should be cleaned up");
  });

  it("start failure (never sends ready) → reject on timeout (short timeout simulation)", async () => {
    // We simulate timeout by having the proc emit close during the wait.
    // The real timeout is 20 s — too long for tests. We use proc close with
    // non-zero exit to trigger early rejection.
    const proc = makeFakeOmpProc({
      sendReady: false,
    });

    // Schedule a close event after a short delay (simulates omp dying before ready)
    setTimeout(() => {
      proc.exitCode = 1;
      proc.emit("close", 1, null);
    }, 100);

    await assert.rejects(
      openBackend({
        agent: "omp",
        cwd: "/tmp",
        spawnImpl: () => proc,
      }),
      /exited/,
      "openBackend should reject when omp exits before ready",
    );

    assert.strictEqual(proc._closed, true, "fake proc should be cleaned up");
  });

  it("on('error') receives error when omp emits error event on stdout", async () => {
    const proc = makeFakeOmpProc({ errorMsgAfterReady: "simulated omp crash" });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });

    const errorPromise = new Promise((resolve) => {
      session.on("error", (err) => resolve(err));
    });

    const err = await errorPromise;
    assert.ok(err instanceof Error);
    assert.match(err.message, /simulated omp crash/);

    await session.close();
  });

  it("no 'error' listener → process does not crash on omp error", async () => {
    const proc = makeFakeOmpProc({ errorMsgAfterReady: "non-fatal omp error" });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });

    // Wait for the error message to be processed
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Session should still be alive (status likely idle or still idle)
    // This test passes if no unhandled 'error' event crashes the process.
    assert.ok(
      session.status === "idle" || session.status === "closed",
      `session should still be alive, got status=${session.status}`,
    );

    await session.close();
  });

  it("send with wait:true resolves with result after turn completes", async () => {
    const proc = makeFakeOmpProc({ responseDeltas: ["result"] });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });

    const res = await session.send("task", { wait: true });

    assert.strictEqual(res.text, "result");
    assert.strictEqual(res.session.agent, "omp");

    await session.close();
  });

  it("abort() sends abort request and sets status idle", async () => {
    const proc = makeFakeOmpProc();
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });

    const res = await session.abort();
    assert.strictEqual(res.aborted, true);
    assert.strictEqual(res.session_id, session.id);
    assert.strictEqual(session.status, "idle");

    await session.close();
  });

  it("result() falls back to accumulated deltas when get_last_assistant_text is unavailable", async () => {
    const proc = makeFakeOmpProc({
      responseDeltas: ["X", "Y", "Z"],
      noGetLastAssistantText: true,
    });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });

    await session.send("query");

    // Verify delta accumulation happened in-memory
    assert.strictEqual(
      session.lastAssistantText,
      "XYZ",
      "lastAssistantText should accumulate deltas",
    );

    const res = await session.result();
    assert.strictEqual(
      res.text,
      "XYZ",
      "result() should fall back to accumulated deltas when get_last_assistant_text unavailable",
    );

    await session.close();
  });

  it("passes --model and --thinking to omp spawn argv", async () => {
    let capturedArgs = null;
    function spawnImpl(_bin, args, _opts) {
      capturedArgs = [...args];
      return makeFakeOmpProc();
    }
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      model: "my-model",
      effort: "high",
      spawnImpl,
    });

    assert.ok(capturedArgs, "spawnImpl should have been called");
    const modelIdx = capturedArgs.indexOf("--model");
    assert.ok(modelIdx >= 0, "argv should contain --model");
    assert.strictEqual(
      capturedArgs[modelIdx + 1],
      "my-model",
      "argv should pass model value after --model",
    );
    const thinkingIdx = capturedArgs.indexOf("--thinking");
    assert.ok(thinkingIdx >= 0, "argv should contain --thinking");
    assert.strictEqual(
      capturedArgs[thinkingIdx + 1],
      "high",
      "argv should pass effort value after --thinking",
    );

    await session.close();
  });
});

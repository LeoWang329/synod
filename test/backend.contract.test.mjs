import { describe, it } from "node:test";
import assert from "node:assert";
import { openBackend } from "../src/backend.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";
import { MESH_INSTRUCTIONS } from "../src/mesh-instructions.mjs";
import { PassThrough } from "node:stream";


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

  it("mesh:true is stored on session", async () => {
    const proc = makeFakeOmpProc({ responseDeltas: ["ok"] });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      mesh: true,
      spawnImpl: () => proc,
    });
    assert.strictEqual(session.mesh, true, "session.mesh should be true");
    await session.close();
  });

  it("mesh defaults to false", async () => {
    const proc = makeFakeOmpProc({ responseDeltas: ["ok"] });
    const session = await openBackend({
      agent: "omp",
      cwd: "/tmp",
      spawnImpl: () => proc,
    });
    assert.strictEqual(session.mesh, false, "default session.mesh should be false");
    await session.close();
  });

  it("mesh:false → spawn args have no --append-system-prompt and no --system-prompt", async () => {
    let capturedArgs = null;
    function spawnImpl(_bin, args, _opts) { capturedArgs = [...args]; return makeFakeOmpProc(); }
    const session = await openBackend({
      agent: "omp", cwd: "/tmp", mesh: false, spawnImpl,
    });
    assert.ok(capturedArgs, "spawnImpl should have been called");
    assert.ok(!capturedArgs.some(a => a.startsWith("--append-system-prompt")),
      "mesh:false must not append --append-system-prompt");
    assert.ok(!capturedArgs.some(a => a.startsWith("--system-prompt")),
      "mesh:false must not pass --system-prompt");
    await session.close();
  });

  it("mesh:true → spawn args include --append-system-prompt=MESH_INSTRUCTIONS, no --system-prompt", async () => {
    let baseArgs = null;
    function spawnImplBase(_bin, args, _opts) { baseArgs = [...args]; return makeFakeOmpProc(); }
    const sessionBase = await openBackend({
      agent: "omp", cwd: "/tmp", mesh: false, spawnImpl: spawnImplBase,
    });
    assert.ok(baseArgs, "base args should be captured");
    await sessionBase.close();

    let meshArgs = null;
    function spawnImplMesh(_bin, args, _opts) { meshArgs = [...args]; return makeFakeOmpProc(); }
    const sessionMesh = await openBackend({
      agent: "omp", cwd: "/tmp", mesh: true, spawnImpl: spawnImplMesh,
    });
    assert.ok(meshArgs, "mesh args should be captured");

    // Find and verify --append-system-prompt
    const appendIdx = meshArgs.findIndex(a => a.startsWith("--append-system-prompt="));
    assert.ok(appendIdx >= 0, "mesh:true should include --append-system-prompt=...");
    const appendVal = meshArgs[appendIdx];
    const expectedFlag = "--append-system-prompt=" + MESH_INSTRUCTIONS;
    assert.strictEqual(appendVal, expectedFlag, "value must match MESH_INSTRUCTIONS exactly");

    // Remove --append-system-prompt from meshArgs, remainder must equal baseArgs
    const meshArgsWithoutAppend = meshArgs.filter(a => !a.startsWith("--append-system-prompt="));
    assert.deepStrictEqual(meshArgsWithoutAppend, baseArgs,
      "mesh:true args minus --append-system-prompt must equal mesh:false args");

    // Must NOT contain --system-prompt (replacement, not append)
    assert.ok(!meshArgs.some(a => a.startsWith("--system-prompt")),
      "must not use --system-prompt (replacement)");

    await sessionMesh.close();
  });

  it("mesh:false → log file contains OMP command line, no --append-system-prompt", async () => {
    const { open } = await import("node:fs/promises");
    const session = await openBackend({
      agent: "omp", cwd: "/tmp", mesh: false,
      spawnImpl: () => makeFakeOmpProc(),
    });
    // Read the log file content
    let content = "";
    try {
      const fh = await open(session.logFile);
      content = await fh.readFile("utf-8");
      await fh.close();
    } catch { /* log may not exist if appendLog never wrote */ }

    assert.ok(content.includes("--mode"), "should contain OMP args");
    assert.ok(content.includes("--no-extensions"), "should contain --no-extensions");
    assert.ok(content.includes("--no-rules"), "should contain --no-rules");
    assert.ok(!content.includes("--append-system-prompt"),
      "mesh:false log must not contain --append-system-prompt");
    assert.ok(!content.includes("--system-prompt"),
      "mesh:false log must not contain --system-prompt");

    await session.close();
  });
});

// ── CodexSession contract (fake app-server, no real codex startup) ──────

describe("CodexSession mesh injection", () => {
  /** Create a fake codex app-server companion for testing. */
  function makeFakeCodexCompanion() {
    const stdinWrites = [];
    const fakeStdin = new PassThrough();
    const fakeStdout = new PassThrough();
    const fakeStderr = new PassThrough();

    // Capture writes to stdin
    fakeStdin.on("data", (chunk) => {
      stdinWrites.push(chunk.toString().trim());
    });

    // Schedule JSON-RPC responses: initialize(id=1), thread/start(id=2)
    // Delayed to let readline set up its 'line' listener in start().
    setImmediate(() => {
      fakeStdout.push('{"id":1,"result":{"sessionId":"fake-session"}}\n');
      setImmediate(() => {
        fakeStdout.push('{"id":2,"result":{"thread":{"id":"fake-thread"}}}\n');
      });
    });

    const proc = {
      stdin: fakeStdin,
      stdout: fakeStdout,
      stderr: fakeStderr,
      pid: 99999,
      exitCode: null,
      on() {},
    };
    return { proc, stdinWrites };
  }

  it("mesh:false → thread/start params have no developerInstructions", async () => {
    const { proc, stdinWrites } = makeFakeCodexCompanion();
    const session = await openBackend({
      agent: "codex",
      cwd: "/tmp",
      mesh: false,
      spawnImpl: () => proc,
    });
    await session.close();

    // Find thread/start write
    const ts = stdinWrites.find(s => s.includes('"thread/start"'));
    assert.ok(ts, "should have thread/start request");
    const msg = JSON.parse(ts);
    assert.strictEqual(msg.method, "thread/start");
    assert.ok(!("developerInstructions" in msg.params),
      "mesh:false must not include developerInstructions");
    // Existing fields must be present
    assert.strictEqual(msg.params.cwd, "/tmp");
    assert.strictEqual(msg.params.ephemeral, true);
    assert.strictEqual(msg.params.sandbox, "read-only");
  });

  it("mesh:true → thread/start params include developerInstructions = MESH_INSTRUCTIONS", async () => {
    const { proc, stdinWrites } = makeFakeCodexCompanion();
    const session = await openBackend({
      agent: "codex",
      cwd: "/tmp",
      mesh: true,
      spawnImpl: () => proc,
    });
    await session.close();

    const ts = stdinWrites.find(s => s.includes('"thread/start"'));
    assert.ok(ts, "should have thread/start request");
    const msg = JSON.parse(ts);
    assert.strictEqual(msg.method, "thread/start");
    assert.strictEqual(msg.params.developerInstructions, MESH_INSTRUCTIONS,
      "developerInstructions must match MESH_INSTRUCTIONS exactly");
    // Existing fields still present
    assert.strictEqual(msg.params.cwd, "/tmp");
    assert.strictEqual(msg.params.ephemeral, true);
    assert.strictEqual(msg.params.sandbox, "read-only");
    assert.strictEqual(msg.params.serviceName, "agent_bridge");
    // Must NOT use baseInstructions (replacement)
    assert.ok(!("baseInstructions" in msg.params),
      "must not use baseInstructions (replacement), use developerInstructions");
  });
});

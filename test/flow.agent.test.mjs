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

/** Wrap fakeOpenBackend to count open/close calls. */
function countingOpenBackend() {
  let opens = 0;
  let closes = 0;

  async function open(opts) {
    opens++;
    const session = await fakeOpenBackend(opts);
    const origClose = session.close.bind(session);
    session.close = () => {
      closes++;
      return origClose();
    };
    return session;
  }

  return { open, get opens() { return opens; }, get closes() { return closes; } };
}

describe("agent", () => {
  // ── Happy path ────────────────────────────────────────────────────

  it("returns accumulated text from the fake backend", async () => {
    const fs = memoryFs();
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    const text = await runtime.agent(ctx, {
      agent: "omp",
      model: "deepseek/deepseek-v4-pro",
      prompt: "hello",
    });

    assert.strictEqual(text, "");
  });

  it("returns text matching configured deltas", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: ["Hello ", "world"] }),
    });
    const ctx = runtime.createCtx({});

    const text = await runtime.agent(ctx, {
      agent: "omp",
      model: "deepseek/deepseek-v4-pro",
      prompt: "greet",
    });

    assert.strictEqual(text, "Hello world");
  });

  // ── Default one-shot (open → send → close) ────────────────────────

  it("opens and closes exactly once for a single call (default one-shot)", async () => {
    const fs = memoryFs();
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "deepseek/deepseek-v4-pro",
      prompt: "hello",
    });

    assert.strictEqual(counter.opens, 1, "should open exactly once");
    assert.strictEqual(counter.closes, 1, "should close exactly once");
  });

  it("opens and closes once per call (no reuse)", async () => {
    const fs = memoryFs();
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, { agent: "omp", model: "m", prompt: "a" });
    await runtime.agent(ctx, { agent: "omp", model: "m", prompt: "b" });

    assert.strictEqual(counter.opens, 2);
    assert.strictEqual(counter.closes, 2);
  });

  // ── reuse:true ────────────────────────────────────────────────────

  it("reuses session across two calls with reuse:true, opens once", async () => {
    const fs = memoryFs();
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "deepseek/deepseek-v4-pro",
      prompt: "first",
      reuse: true,
    });
    await runtime.agent(ctx, {
      agent: "omp",
      model: "deepseek/deepseek-v4-pro",
      prompt: "second",
      reuse: true,
    });

    assert.strictEqual(counter.opens, 1, "should open exactly once with reuse");
    assert.strictEqual(counter.closes, 0,
      "should not close until dispose with reuse");
  });

  it("disposeRun closes reused sessions", async () => {
    const fs = memoryFs();
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "first",
      reuse: true,
    });
    await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "second",
      reuse: true,
    });

    assert.strictEqual(counter.closes, 0);

    await runtime.disposeRun(ctx);

    assert.strictEqual(counter.closes, 1, "disposeRun should close reused session");
  });

  // ── Logging ───────────────────────────────────────────────────────

  it("writes session:open / session:close and step:* events to log", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 1700000000000,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: ["ok"] }),
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "deepseek/deepseek-v4-pro",
      prompt: "hello",
    });

    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n");

    // Event order: session:open, step:started, step:succeeded, session:close
    const events = lines.map((l) => JSON.parse(l));

    const openEv = events.find((e) => e.event === "session:open");
    assert.ok(openEv, "should have session:open");
    assert.strictEqual(openEv.agent, "omp");
    assert.strictEqual(openEv.model, "deepseek/deepseek-v4-pro");
    assert.strictEqual(openEv.reused, false);

    const startedEv = events.find((e) => e.event === "step:started");
    assert.ok(startedEv, "should have step:started");
    assert.strictEqual(startedEv.node, "omp");
    assert.strictEqual(startedEv.type, "agent");

    const succeededEv = events.find((e) => e.event === "step:succeeded");
    assert.ok(succeededEv, "should have step:succeeded");
    assert.strictEqual(succeededEv.output, "ok");

    const closeEv = events.find((e) => e.event === "session:close");
    assert.ok(closeEv, "should have session:close");
    assert.strictEqual(closeEv.reused, false);

    // Verify ordering: open before started before succeeded before close
    const openIdx = lines.findIndex((l) => l.includes("session:open"));
    const startIdx = lines.findIndex((l) => l.includes("step:started"));
    const succIdx = lines.findIndex((l) => l.includes("step:succeeded"));
    const closeIdx = lines.findIndex((l) => l.includes("session:close"));
    assert.ok(openIdx < startIdx, "open before started");
    assert.ok(startIdx < succIdx, "started before succeeded");
    assert.ok(succIdx < closeIdx, "succeeded before close");
  });

  it("writes session:close with reused:true on disposeRun", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: ["x"] }),
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "hi",
      reuse: true,
    });

    // session:close should NOT be in log yet
    let lines = fs.get("run.log.jsonl").trim().split("\n");
    const hasCloseBefore = lines.some((l) => l.includes("session:close"));
    assert.strictEqual(hasCloseBefore, false,
      "session:close must not appear before disposeRun");

    await runtime.disposeRun(ctx);

    lines = fs.get("run.log.jsonl").trim().split("\n");
    const closeEv = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(closeEv.event, "session:close");
    assert.strictEqual(closeEv.reused, true);
  });

  // ── Error handling ────────────────────────────────────────────────


  it("throws on backend failure, writes step:failed, closes session", async () => {
    const fs = memoryFs();
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        counter.open({ ...opts, failPrompt: true }),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agent(ctx, {
          agent: "omp",
          model: "m",
          prompt: "boom",
        }),
      /simulated prompt failure/,
    );

    // Session must be closed (no leak)
    assert.strictEqual(counter.closes, 1, "session must be closed on error");

    // Log must have step:started + step:failed
    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    const startedEv = events.find((e) => e.event === "step:started");
    assert.ok(startedEv, "should have step:started");

    const failedEv = events.find((e) => e.event === "step:failed");
    assert.ok(failedEv, "should have step:failed");
    assert.ok(failedEv.error, "should have error field");
    assert.ok(
      failedEv.error.message.includes("simulated prompt failure"),
    );

    // session:close should also be written
    const closeEv = events.find((e) => e.event === "session:close");
    assert.ok(closeEv, "should have session:close on error");
  });

  // ── Session leak: close guaranteed even when log writes fail ─────

  it("closes session even when session:open log write fails", async () => {
    const counter = countingOpenBackend();
    let appendCalled = 0;
    const fs = {
      files: new Map(),
      async writeFile(path, content) {
        this.files.set(path, content);
      },
      async appendFile(path, content) {
        appendCalled++;
        // Fail the first appendFile call (session:open), let others succeed
        if (appendCalled === 1) throw new Error("disk full on open");
        this.files.set(path, (this.files.get(path) ?? "") + content);
      },
      get(path) { return this.files.get(path); },
    };
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "hello",
    });

    // Despite log write failure, session must be closed
    assert.strictEqual(counter.closes, 1,
      "session must be closed even when session:open log fails");
  });

  it("closes session even when step:failed log write fails", async () => {
    const counter = countingOpenBackend();
    let appendCalled = 0;
    const fs = {
      files: new Map(),
      async writeFile(path, content) {
        this.files.set(path, content);
      },
      async appendFile(path, content) {
        appendCalled++;
        // Let session:open and step:started succeed, fail step:failed write
        if (appendCalled >= 3) throw new Error("disk full on step:failed");
        this.files.set(path, (this.files.get(path) ?? "") + content);
      },
      get(path) { return this.files.get(path); },
    };
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        counter.open({ ...opts, failPrompt: true }),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agent(ctx, {
          agent: "omp",
          model: "m",
          prompt: "boom",
        }),
      /simulated prompt failure/,
    );

    // Session must be closed despite log write failure
    assert.strictEqual(counter.closes, 1,
      "session must be closed even when step:failed log fails");
  });

  it("throws before open on invalid model (empty string), no session leak", async () => {
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs: memoryFs(),
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agent(ctx, {
          agent: "omp",
          model: "",
          prompt: "hello",
        }),
      /model must be a non-empty string/,
    );

    // No session was ever opened or closed
    assert.strictEqual(counter.opens, 0, "must not open for invalid model");
    assert.strictEqual(counter.closes, 0);
  });

  // ── openBackend failure writes step:failed ───────────────────────

  it("writes step:failed when openBackend itself throws, no session events", async () => {
    const fs = memoryFs();
    const openErr = new Error("backend unreachable");
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async () => { throw openErr; },
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agent(ctx, {
          agent: "omp",
          model: "m",
          prompt: "hello",
        }),
      /backend unreachable/,
    );

    const logContent = fs.get("run.log.jsonl") ?? "";
    const lines = logContent.trim().split("\n").filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));

    // Must have step:started + step:failed
    const failedEv = events.find((e) => e.event === "step:failed");
    assert.ok(failedEv, "should have step:failed for openBackend failure");
    assert.ok(failedEv.error.message.includes("backend unreachable"));

    // No session:open or session:close (never opened)
    const openEv = events.find((e) => e.event === "session:open");
    assert.strictEqual(openEv, undefined,
      "must not write session:open when backend fails to start");
    const closeEv = events.find((e) => e.event === "session:close");
    assert.strictEqual(closeEv, undefined,
      "must not write session:close when backend fails to start");
  });

  // ── Reuse failure: session closed once, not double-closed ────────

  it("reuse:true — second send fails, closes once, disposeRun does not double-close", async () => {
    const counter = countingOpenBackend();
    let savedSession = null;
    const runtime = createRuntime({
      fs: memoryFs(),
      clock: () => 0,
      openBackend: async (opts) => {
        const s = await counter.open(opts);
        savedSession = s;
        return s;
      },
    });
    const ctx = runtime.createCtx({});

    // First call: reuse:true, succeeds
    await runtime.agent(ctx, {
      agent: "omp",
      model: "m",
      prompt: "first",
      reuse: true,
    });
    assert.strictEqual(counter.opens, 1);
    assert.strictEqual(counter.closes, 0);

    // Mutate session to fail on next send
    savedSession._failPrompt = true;

    // Second call: same key, reuse:true, send fails
    await assert.rejects(
      () =>
        runtime.agent(ctx, {
          agent: "omp",
          model: "m",
          prompt: "second",
          reuse: true,
        }),
      /simulated prompt failure/,
    );

    // Error path must close the session (no leak)
    assert.strictEqual(counter.closes, 1,
      "reuse failure must close session once");
    assert.strictEqual(counter.opens, 1,
      "must not re-open after reuse failure");

    // disposeRun must NOT double-close
    await runtime.disposeRun(ctx);
    assert.strictEqual(counter.closes, 1,
      "disposeRun must not double-close already-closed session");

    // Log must have step:failed + session:close (reused:true)
    const fs = runtime.fs;
    const logContent = fs.get("run.log.jsonl") ?? "";
    const lines = logContent.trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    const failedEv = events.find((e) => e.event === "step:failed");
    assert.ok(failedEv, "should have step:failed");

    const closeEvents = events.filter((e) => e.event === "session:close");
    // There should be exactly one session:close (reused:true, from error path)
    const reusedClose = closeEvents.find((e) => e.reused === true);
    assert.ok(reusedClose, "should have session:close with reused:true");
    assert.strictEqual(closeEvents.length, 1,
      "should have exactly one session:close (no double-close)");
  });

  // ── Step log includes prompt + meta ──────────────────────────────

  it("step log entries include input (prompt) and meta (agent, model)", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, deltas: ["ok"] }),
    });
    const ctx = runtime.createCtx({});

    await runtime.agent(ctx, {
      agent: "codex",
      model: "minimax/MiniMax-M3",
      prompt: "write a test",
    });

    const logContent = fs.get("run.log.jsonl");
    const lines = logContent.trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    const succeededEv = events.find((e) => e.event === "step:succeeded");
    assert.ok(succeededEv, "should have step:succeeded");
    assert.strictEqual(succeededEv.input, "write a test",
      "step log should contain prompt as input");
    assert.strictEqual(succeededEv.agent, "codex",
      "step log should contain meta.agent");
    assert.strictEqual(succeededEv.model, "minimax/MiniMax-M3",
      "step log should contain meta.model");
  });

  // ── disposeRun: close guaranteed, not blocked by log failures ────

  it("disposeRun closes both sessions even when close log fails for one", async () => {
    const counter = countingOpenBackend();
    const fs = {
      files: new Map(),
      async writeFile(path, content) { this.files.set(path, content); },
      async appendFile(path, content) {
        // Fail only on session:close log lines to test that close still happens
        if (content.includes('"session:close"')) throw new Error("close log fail");
        this.files.set(path, (this.files.get(path) ?? "") + content);
      },
      get(path) { return this.files.get(path); },
    };
    const runtime = createRuntime({ fs, clock: () => 0, openBackend: counter.open });
    const ctx = runtime.createCtx({});

    // Open two reused sessions with different keys
    await runtime.agent(ctx, { agent: "omp", model: "a", prompt: "hi", reuse: true });
    await runtime.agent(ctx, { agent: "omp", model: "b", prompt: "hi", reuse: true });

    assert.strictEqual(counter.closes, 0);

    // disposeRun — even though both close logs fail, both sessions must close
    // and disposeRun must not throw (best-effort log)
    await runtime.disposeRun(ctx);

    assert.strictEqual(counter.closes, 2,
      "both sessions must be closed even when close log fails");

    // Second disposeRun is idempotent (no extra close)
    await runtime.disposeRun(ctx);
    assert.strictEqual(counter.closes, 2,
      "second disposeRun must not double-close");
  });

  // ── Loud logStep: artifact write failure surfaces to caller ──────

  it("rejects when success-path logStep fails (e.g. large output artifact write fails)", async () => {
    const counter = countingOpenBackend();
    const writeErr = new Error("disk full on artifact");
    const fs = {
      files: new Map(),
      async writeFile(_path, _content) { throw writeErr; },
      async appendFile(path, content) {
        this.files.set(path, (this.files.get(path) ?? "") + content);
      },
      get(path) { return this.files.get(path); },
    };
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        counter.open({ ...opts, deltas: ["x".repeat(1000)] }),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agent(ctx, {
          agent: "omp",
          model: "m",
          prompt: "hello",
        }),
      writeErr,
    );

    // Session must still be closed (finally guarantee)
    assert.strictEqual(counter.closes, 1,
      "session must be closed even when logStep artifact write fails");
  });


  it("reuse:true + logStep artifact failure → closes + removes from pool, disposeRun no double-close", async () => {
    const counter = countingOpenBackend();
    const writeErr = new Error("disk full on artifact");
    const fs = {
      files: new Map(),
      async writeFile(_path, _content) { throw writeErr; },
      async appendFile(path, content) {
        this.files.set(path, (this.files.get(path) ?? "") + content);
      },
      get(path) { return this.files.get(path); },
    };
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        counter.open({ ...opts, deltas: ["x".repeat(1000)] }),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agent(ctx, {
          agent: "omp",
          model: "m",
          prompt: "hello",
          reuse: true,
        }),
      writeErr,
    );

    // Must close the dirty session even though it was reuse:true
    assert.strictEqual(counter.closes, 1,
      "reuse + logStep failure must close the session");

    // disposeRun must NOT double-close (session already removed from pool)
    await runtime.disposeRun(ctx);
    assert.strictEqual(counter.closes, 1,
      "disposeRun must not double-close after reuse + logStep failure");
  });
  // ── meta validation: reserved keys → no log pollution ────────────

  it("logStep throws when meta contains a reserved key (event)", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.logger.logStep(ctx, {
          node: "agent",
          type: "agent",
          attempt: 1,
          meta: { event: "hijacked" },
        }),
      /meta\.event is a reserved field/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logStep throws when meta contains nested function", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.logger.logStep(ctx, {
          node: "agent",
          type: "agent",
          attempt: 1,
          meta: { nested: { fn: () => {} } },
        }),
      /meta\.nested\.fn: functions are not allowed/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logStep throws when meta contains Date", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.logger.logStep(ctx, {
          node: "agent",
          type: "agent",
          attempt: 1,
          meta: { when: new Date() },
        }),
      /meta\.when: non-plain object \(Date\) is not allowed/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });

  it("logStep throws when meta contains undefined", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({ fs, clock: () => 0 });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.logger.logStep(ctx, {
          node: "agent",
          type: "agent",
          attempt: 1,
          meta: { val: undefined },
        }),
      /meta\.val: undefined is not allowed/,
    );
    assert.strictEqual(fs.get("run.log.jsonl"), undefined);
  });
});

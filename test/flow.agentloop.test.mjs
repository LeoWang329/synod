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

describe("agentLoop", () => {
  // ── Until stop condition ──────────────────────────────────────────

  it("stops immediately when until(output) returns true on the first turn", async () => {
    const fs = memoryFs();
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: counter.open,
    });
    const ctx = runtime.createCtx({});

    const output = await runtime.agentLoop(ctx, {
      agent: "omp",
      prompt: "hello",
      until: () => true, // stops on first turn
    });

    assert.strictEqual(output, "");
    assert.strictEqual(counter.opens, 1, "should open exactly once");
    assert.strictEqual(counter.closes, 1, "should close exactly once");
  });

  it("loops until until(output) becomes true, and does not send beyond that", async () => {
    const fs = memoryFs();
    let sendCount = 0;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        const s = await fakeOpenBackend({ ...opts, texts: ["one", "two", "DONE", "late"] });
        const origSend = s.send.bind(s);
        s.send = (msg, options) => {
          sendCount++;
          return origSend(msg, options);
        };
        return s;
      },
    });
    const ctx = runtime.createCtx({});

    const output = await runtime.agentLoop(ctx, {
      agent: "omp",
      prompt: "keep going",
      until: (out) => out === "DONE",
    });

    assert.strictEqual(output, "DONE");
    assert.strictEqual(sendCount, 3, "exactly 3 sends — stops at DONE, never sends 'late'");
  });

  it("stops at maxTurns when until never returns true, with exactly maxTurns sends", async () => {
    const fs = memoryFs();
    let sessionRef = null;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        const s = await fakeOpenBackend(opts);
        sessionRef = s;
        return s;
      },
    });
    const ctx = runtime.createCtx({});

    await runtime.agentLoop(ctx, {
      agent: "omp",
      prompt: "hello",
      until: () => false,
      maxTurns: 3,
    });

    assert.ok(sessionRef, "session was opened");
    assert.strictEqual(
      sessionRef._sentMessages.length,
      3,
      "exactly maxTurns (3) sends",
    );
  });

  it("reuses the same session across turns — 1 open, N sends, 1 close", async () => {
    const fs = memoryFs();
    let sessionRef = null;
    const counter = countingOpenBackend();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        const s = await counter.open(opts);
        sessionRef = s;
        return s;
      },
    });
    const ctx = runtime.createCtx({});

    await runtime.agentLoop(ctx, {
      agent: "omp",
      prompt: "hello",
      until: () => false,
      maxTurns: 5,
    });

    assert.strictEqual(counter.opens, 1, "exactly 1 open");
    assert.strictEqual(counter.closes, 1, "exactly 1 close");
    assert.strictEqual(
      sessionRef._sentMessages.length,
      5,
      "5 sends on the same session",
    );
  });

  // ── Prompt builder ─────────────────────────────────────────────────

  it("accepts a function as prompt builder, receiving turn and prevOutput", async () => {
    const fs = memoryFs();
    const prompts = [];
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        const session = await fakeOpenBackend({ ...opts, texts: ["a", "b", "c"] });
        const origSend = session.send.bind(session);
        session.send = (msg, options) => {
          prompts.push(msg);
          return origSend(msg, options);
        };
        return session;
      },
    });
    const ctx = runtime.createCtx({});

    await runtime.agentLoop(ctx, {
      agent: "omp",
      prompt: (turn, prev) => `Turn ${turn}, prev: ${prev || "none"}`,
      until: () => false,
      maxTurns: 3,
    });

    assert.strictEqual(prompts.length, 3);
    assert.strictEqual(prompts[0], "Turn 1, prev: none");
    assert.strictEqual(prompts[1], "Turn 2, prev: a");
    assert.strictEqual(prompts[2], "Turn 3, prev: b");
  });

  it("uses the same string prompt every turn when prompt is a string", async () => {
    const fs = memoryFs();
    const prompts = [];
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        const session = await fakeOpenBackend(opts);
        const origSend = session.send.bind(session);
        session.send = (msg, options) => {
          prompts.push(msg);
          return origSend(msg, options);
        };
        return session;
      },
    });
    const ctx = runtime.createCtx({});

    await runtime.agentLoop(ctx, {
      agent: "omp",
      prompt: "fixed prompt",
      until: () => false,
      maxTurns: 2,
    });

    assert.deepStrictEqual(prompts, ["fixed prompt", "fixed prompt"]);
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it("returns the output from the first turn when until is true on turn 1", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) =>
        fakeOpenBackend({ ...opts, texts: ["immediate"] }),
    });
    const ctx = runtime.createCtx({});

    const output = await runtime.agentLoop(ctx, {
      agent: "omp",
      prompt: "go",
      until: () => true,
    });

    assert.strictEqual(output, "immediate");
  });

  it("throws when until is not a function", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agentLoop(ctx, {
          agent: "omp",
          prompt: "hello",
          until: "not-a-function",
        }),
      /until must be a function/,
    );
  });

  it("throws when maxTurns is not a positive integer", async () => {
    const fs = memoryFs();
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => fakeOpenBackend(opts),
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agentLoop(ctx, {
          agent: "omp",
          prompt: "hello",
          until: () => false,
          maxTurns: 0,
        }),
      /maxTurns must be a positive integer/,
    );
  });

  it("throws when maxTurns is NaN — never opens a session", async () => {
    const fs = memoryFs();
    let opened = false;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (_opts) => {
        opened = true;
        return fakeOpenBackend(_opts);
      },
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agentLoop(ctx, {
          agent: "omp",
          prompt: "hello",
          until: () => false,
          maxTurns: NaN,
        }),
      /maxTurns must be a positive integer/,
    );
    assert.strictEqual(opened, false, "NaN: no session opened, no send");
  });

  it("throws when maxTurns is Infinity — never opens a session", async () => {
    const fs = memoryFs();
    let opened = false;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (_opts) => {
        opened = true;
        return fakeOpenBackend(_opts);
      },
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agentLoop(ctx, {
          agent: "omp",
          prompt: "hello",
          until: () => false,
          maxTurns: Infinity,
        }),
      /maxTurns must be a positive integer/,
    );
    assert.strictEqual(opened, false, "Infinity: no session opened, no send");
  });

  it("throws when maxTurns is 1.5 — never opens a session", async () => {
    const fs = memoryFs();
    let opened = false;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (_opts) => {
        opened = true;
        return fakeOpenBackend(_opts);
      },
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agentLoop(ctx, {
          agent: "omp",
          prompt: "hello",
          until: () => false,
          maxTurns: 1.5,
        }),
      /maxTurns must be a positive integer/,
    );
    assert.strictEqual(opened, false, "1.5: no session opened, no send");
  });
  it("session is closed even when send throws mid-loop", async () => {
    const fs = memoryFs();
    let closed = false;
    const runtime = createRuntime({
      fs,
      clock: () => 0,
      openBackend: async (opts) => {
        const session = await fakeOpenBackend(opts);
        const origClose = session.close.bind(session);
        session.close = () => {
          closed = true;
          return origClose();
        };
        // First send succeeds, second send throws
        let callCount = 0;
        const origSend = session.send.bind(session);
        session.send = (msg, options) => {
          callCount++;
          if (callCount === 2) throw new Error("simulated send failure");
          return origSend(msg, options);
        };
        return session;
      },
    });
    const ctx = runtime.createCtx({});

    await assert.rejects(
      () =>
        runtime.agentLoop(ctx, {
          agent: "omp",
          prompt: "hello",
          until: () => false,
          maxTurns: 5,
        }),
      /simulated send failure/,
    );

    assert.ok(closed, "session must be closed even on send failure");
  });
});

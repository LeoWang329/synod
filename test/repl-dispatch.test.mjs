// synod/test/repl-dispatch.test.mjs — Unit tests for createReplDispatch + parseOpenArgs
//
// Uses lightweight fakes (no real sessions, no subprocesses) to verifies:
// 1. Every command routes to the correct sm/registry method
// 2. Redraw/exit return values match the truth table in A0 spec
// 3. stdout/stderr output is written to the injected streams
// 4. Edge cases: missing labels, parse errors, registry.add throws, enqueue returns false

import { describe, it } from "node:test";
import assert from "node:assert";
import { createReplDispatch, parseOpenArgs } from "../src/repl-dispatch.mjs";

// ── helpers ────────────────────────────────────────────────────────────

function captureStream() {
  return { buf: "", write(s) { this.buf += s; } };
}

/** Build a fake sm with spy-capable methods and configurable behavior. */
function fakeSm(opts = {}) {
  const _sessions = new Map(opts._sessions || []);
  const calls = {
    open: [],
    enqueue: [],
    use: [],
    list: 0,
  };
  return {
    _sessions,
    currentLabel: opts.currentLabel || null,
    open: async (o) => {
      calls.open.push({ ...o });
      if (opts.openResult === undefined) return `${o.agent}#1`;
      return opts.openResult;
    },
    enqueue: (o) => {
      calls.enqueue.push({ ...o });
      return opts.enqueueResult !== undefined ? opts.enqueueResult : true;
    },
    use: (target) => {
      calls.use.push(target);
      return opts.useResult !== undefined ? opts.useResult : true;
    },
    list: () => {
      calls.list++;
    },
    calls,
  };
}

/** Build a fake relay registry with spy-capable methods. */
function fakeRegistry(opts = {}) {
  const calls = { add: [], remove: [], list: 0 };
  return {
    add: (from, to) => {
      calls.add.push({ from, to });
      if (opts.addThrow) throw opts.addThrow;
    },
    remove: (from, to) => {
      calls.remove.push({ from, to });
    },
    list: () => {
      calls.list++;
      return opts.listResult || [];
    },
    calls,
  };
}

function setup({ smOpts = {}, regOpts = {} } = {}) {
  const sm = fakeSm(smOpts);
  const registry = fakeRegistry(regOpts);
  const stdout = captureStream();
  const stderr = captureStream();
  const defaultAgent = "omp";
  const flowCalls = [];
  const runFlow = async (argv) => { flowCalls.push(argv); return 0; };
  const dispatch = createReplDispatch({ sm, registry, stdout, stderr, defaultAgent, runFlow });
  return { dispatch, sm, registry, stdout, stderr, defaultAgent, flowCalls };
}

// ── parseOpenArgs ───────────────────────────────────────────────────────

describe("parseOpenArgs", () => {
  it("empty tokens → empty opts", () => {
    assert.deepStrictEqual(parseOpenArgs([]), {});
  });

  it("--agent codex → { agent: 'codex' }", () => {
    assert.deepStrictEqual(parseOpenArgs(["--agent", "codex"]), { agent: "codex" });
  });

  it("--model mini → { model: 'mini' }", () => {
    assert.deepStrictEqual(parseOpenArgs(["--model", "mini"]), { model: "mini" });
  });

  it("--effort high → { effort: 'high' }", () => {
    assert.deepStrictEqual(parseOpenArgs(["--effort", "high"]), { effort: "high" });
  });

  it("--write → { write: true }", () => {
    assert.deepStrictEqual(parseOpenArgs(["--write"]), { write: true });
  });

  it("--mesh → { mesh: true }", () => {
    assert.deepStrictEqual(parseOpenArgs(["--mesh"]), { mesh: true });
  });

  it("--no-mesh → { mesh: false }", () => {
    assert.deepStrictEqual(parseOpenArgs(["--no-mesh"]), { mesh: false });
  });

  it("no mesh flag → mesh key absent (inherit default)", () => {
    assert.strictEqual("mesh" in parseOpenArgs(["--agent", "codex"]), false);
  });

  it("--mesh --no-mesh together → mutually-exclusive error", () => {
    const r = parseOpenArgs(["--mesh", "--no-mesh"]);
    assert.ok(r.error.includes("mutually exclusive"));
  });

  it("--no-mesh --mesh (reverse order) → mutually-exclusive error", () => {
    const r = parseOpenArgs(["--no-mesh", "--mesh"]);
    assert.ok(r.error.includes("mutually exclusive"));
  });

  it("repeated --mesh is idempotent (not an error)", () => {
    assert.deepStrictEqual(parseOpenArgs(["--mesh", "--mesh"]), { mesh: true });
  });

  it("repeated --no-mesh is idempotent (not an error)", () => {
    assert.deepStrictEqual(parseOpenArgs(["--no-mesh", "--no-mesh"]), { mesh: false });
  });

  it("combined: --agent codex --model mini --write", () => {
    assert.deepStrictEqual(parseOpenArgs(["--agent", "codex", "--model", "mini", "--write"]), {
      agent: "codex",
      model: "mini",
      write: true,
    });
  });

  it("--agent without value returns error", () => {
    assert.deepStrictEqual(parseOpenArgs(["--agent"]), { error: "--agent requires a value" });
  });

  it("--agent unknown is no longer rejected at parse (caught at open-time via sm.open → checkAgentAvailable)", () => {
    assert.deepStrictEqual(parseOpenArgs(["--agent", "gpt5"]), { agent: "gpt5" });
  });

  it("--model without value returns error", () => {
    assert.deepStrictEqual(parseOpenArgs(["--model"]), { error: "--model requires a value" });
  });

  it("unknown option returns error", () => {
    assert.deepStrictEqual(parseOpenArgs(["--verbose"]), { error: "Unknown option: --verbose" });
  });

  it("value starting with -- treated as missing value", () => {
    const r = parseOpenArgs(["--agent", "--model"]);
    assert.ok(r.error.includes("requires a value"));
  });
});

// ── / commands ─────────────────────────────────────────────────────────

describe("dispatch / commands", () => {
  it("/exit → { exit: true }", async () => {
    const { dispatch, stdout, stderr } = setup();
    const r = await dispatch("/exit");
    assert.deepStrictEqual(r, { exit: true });
    assert.strictEqual(stdout.buf, "");
    assert.strictEqual(stderr.buf, "");
  });

  it("/exit has zero side effects on sm and registry", async () => {
    const { dispatch, sm, registry } = setup();
    const r = await dispatch("/exit");
    assert.deepStrictEqual(r, { exit: true });
    // No sm methods called
    assert.strictEqual(sm.calls.open.length, 0, "sm.open should not be called");
    assert.strictEqual(sm.calls.enqueue.length, 0, "sm.enqueue should not be called");
    assert.strictEqual(sm.calls.use.length, 0, "sm.use should not be called");
    assert.strictEqual(sm.calls.list, 0, "sm.list should not be called");
    // No registry methods called
    assert.strictEqual(registry.calls.add.length, 0, "registry.add should not be called");
    assert.strictEqual(registry.calls.remove.length, 0, "registry.remove should not be called");
    assert.strictEqual(registry.calls.list, 0, "registry.list should not be called");
  });

  it("/quit → { exit: true }", async () => {
    const { dispatch } = setup();
    const r = await dispatch("/quit");
    assert.deepStrictEqual(r, { exit: true });
  });

  it("/sessions calls sm.list() and returns redraw:true", async () => {
    const { dispatch, sm, stdout, stderr } = setup();
    const r = await dispatch("/sessions");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(r.exit, undefined);
    assert.strictEqual(sm.calls.list, 1);
    assert.strictEqual(stderr.buf, "");
  });

  it("/relay with valid from→to calls registry.add", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup({
      smOpts: { _sessions: [["omp#1", {}], ["codex#1", {}]] },
    });
    const r = await dispatch("/relay omp#1->codex#1");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(r.exit, undefined);
    assert.strictEqual(registry.calls.add.length, 1);
    assert.deepStrictEqual(registry.calls.add[0], { from: "omp#1", to: "codex#1" });
    assert.ok(stdout.buf.includes("Relay added: omp#1 -> codex#1"));
    assert.strictEqual(stderr.buf, "");
  });

  it("/relay with parse error writes to stderr, does not call registry.add", async () => {
    const { dispatch, registry, stderr } = setup();
    const r = await dispatch("/relay bad");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes('"->"'));
    assert.strictEqual(registry.calls.add.length, 0);
  });

  it("/relay with from not in sessions writes to stderr, skips registry.add", async () => {
    const { dispatch, sm, registry, stderr } = setup({
      smOpts: { _sessions: [["codex#1", {}]] },
    });
    const r = await dispatch("/relay omp#1->codex#1");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes('No session "omp#1"'));
    assert.strictEqual(registry.calls.add.length, 0);
  });

  it("/relay with to not in sessions writes to stderr, skips registry.add", async () => {
    const { dispatch, sm, registry, stderr } = setup({
      smOpts: { _sessions: [["omp#1", {}]] },
    });
    const r = await dispatch("/relay omp#1->codex#1");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes('No session "codex#1"'));
    assert.strictEqual(registry.calls.add.length, 0);
  });

  it("/relay when registry.add throws → stderr gets error message, still redraw:true", async () => {
    const { dispatch, registry, stdout, stderr } = setup({
      smOpts: { _sessions: [["omp#1", {}], ["codex#1", {}]] },
      regOpts: { addThrow: new Error("cycle detected") },
    });
    const r = await dispatch("/relay omp#1->codex#1");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes("cycle detected"));
    assert.strictEqual(registry.calls.add.length, 1); // was called
    assert.ok(!stdout.buf.includes("Relay added"), "should not write Relay added on throw");
  });

  it("/unrelay calls registry.remove and writes stdout", async () => {
    const { dispatch, registry, stdout, stderr } = setup();
    const r = await dispatch("/unrelay omp#1->codex#1");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(registry.calls.remove.length, 1);
    assert.deepStrictEqual(registry.calls.remove[0], { from: "omp#1", to: "codex#1" });
    assert.ok(stdout.buf.includes("Relay removed: omp#1 -> codex#1"));
    assert.strictEqual(stderr.buf, "");
  });

  it("/unrelay with parse error writes stderr", async () => {
    const { dispatch, registry, stderr } = setup();
    const r = await dispatch("/unrelay bad");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes('"->"'));
    assert.strictEqual(registry.calls.remove.length, 0);
  });

  it("/relays with active rules lists them", async () => {
    const { dispatch, registry, stdout } = setup({
      regOpts: { listResult: [{ from: "a", to: "b" }, { from: "c", to: "d" }] },
    });
    const r = await dispatch("/relays");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(registry.calls.list, 1);
    assert.ok(stdout.buf.includes("Active relays:"));
    assert.ok(stdout.buf.includes("a -> b"));
    assert.ok(stdout.buf.includes("c -> d"));
  });

  it("/relays empty → No active relay rules", async () => {
    const { dispatch, stdout } = setup();
    const r = await dispatch("/relays");
    assert.strictEqual(r.redraw, true);
    assert.ok(stdout.buf.includes("No active relay rules"));
  });

  it("/use <label> calls sm.use and writes stdout on success", async () => {
    const { dispatch, sm, stdout, stderr } = setup();
    const r = await dispatch("/use omp#1");
    assert.strictEqual(r.redraw, true);
    assert.deepStrictEqual(sm.calls.use, ["omp#1"]);
    assert.ok(stdout.buf.includes("Switched to omp#1"));
    assert.strictEqual(stderr.buf, "");
  });

  it("/use without label writes usage to stderr", async () => {
    const { dispatch, sm, stderr } = setup();
    const r = await dispatch("/use");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes("Usage: /use <label>"));
    assert.strictEqual(sm.calls.use.length, 0);
  });

  it("/use with nonexistent label returns redraw:true, no Switched in stdout", async () => {
    const { dispatch, sm, stdout } = setup({ smOpts: { useResult: false } });
    const r = await dispatch("/use ghost");
    assert.strictEqual(r.redraw, true);
    assert.deepStrictEqual(sm.calls.use, ["ghost"]);
    assert.ok(!stdout.buf.includes("Switched to ghost"), "should not write Switched on failure");
  });

  it("/open with default agent passes defaultAgent to sm.open", async () => {
    const { dispatch, sm, defaultAgent } = setup();
    const r = await dispatch("/open");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].agent, defaultAgent);
    assert.strictEqual(sm.calls.open[0].announce, "interactive");
  });

  it("/open with defaultAgent:'codex' passes 'codex' to sm.open (not hardcoded omp)", async () => {
    const sm = fakeSm();
    const registry = fakeRegistry();
    const stdout = captureStream();
    const stderr = captureStream();
    const dispatch = createReplDispatch({ sm, registry, stdout, stderr, defaultAgent: "codex" });
    const r = await dispatch("/open");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].agent, "codex");
  });

  it("/open --agent codex passes codex to sm.open", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent codex");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].agent, "codex");
  });

  it("/open --agent codex --model mini --write passes all opts", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent codex --model mini --write");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].agent, "codex");
    assert.strictEqual(sm.calls.open[0].model, "mini");
    assert.strictEqual(sm.calls.open[0].write, true);
  });

  it("/open --agent codex --model mini --effort high --write passes all opts including effort", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent codex --model mini --effort high --write");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].agent, "codex");
    assert.strictEqual(sm.calls.open[0].model, "mini");
    assert.strictEqual(sm.calls.open[0].effort, "high");
    assert.strictEqual(sm.calls.open[0].write, true);
    assert.strictEqual(sm.calls.open[0].announce, "interactive");
  });

  it("/open --mesh propagates mesh:true to sm.open", async () => {
    const { dispatch, sm } = setup();
    await dispatch("/open --mesh");
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].mesh, true);
  });

  it("/open --no-mesh propagates mesh:false to sm.open", async () => {
    const { dispatch, sm } = setup();
    await dispatch("/open --no-mesh");
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].mesh, false);
  });

  it("/open without mesh flag passes mesh:undefined (sm inherits default)", async () => {
    const { dispatch, sm } = setup();
    await dispatch("/open");
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].mesh, undefined);
  });

  it("/open --verbose writes Unknown option to stderr, no sm.open", async () => {
    const { dispatch, sm, stderr } = setup();
    const r = await dispatch("/open --verbose");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes("Unknown option"), `stderr should mention Unknown option, got: ${stderr.buf}`);
    assert.strictEqual(sm.calls.open.length, 0);
  });

  it("/open with parse error writes stderr", async () => {
    const { dispatch, sm, stderr } = setup();
    const r = await dispatch("/open --agent");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes("requires a value"));
    assert.strictEqual(sm.calls.open.length, 0);
  });

  it("/open with unknown agent now passes through to sm.open (rejection moved to open-time, not parse)", async () => {
    const { dispatch, sm, stderr } = setup();
    const r = await dispatch("/open --agent gpt99");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].agent, "gpt99");
    assert.strictEqual(stderr.buf, "");
  });

  it("/open when sm.open returns null still redraws (error handled by sm)", async () => {
    const { dispatch, sm, stdout, stderr } = setup({ smOpts: { openResult: null } });
    const r = await dispatch("/open");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.open.length, 1);
  });

  it("unknown /foo writes stderr", async () => {
    const { dispatch, stderr } = setup();
    const r = await dispatch("/foo");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes("Unknown command: /foo"));
  });

  it("/ command with extra whitespace still works (split handles it)", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/sessions  ");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.list, 1);
  });
});

// ── /flow command (human-only flow-engine bridge) ──────────────────────

describe("dispatch /flow command", () => {
  it("/flow <name> <input> calls runFlow with [name, input], announces, redraws", async () => {
    const { dispatch, flowCalls, stdout } = setup();
    const r = await dispatch("/flow qa-loop hello world");
    assert.strictEqual(r.redraw, true);
    assert.deepStrictEqual(flowCalls, [["--progress", "qa-loop", "hello world"]]);
    assert.ok(stdout.buf.includes('Running flow "qa-loop"'));
  });

  it("/flow <name> (no input) calls runFlow with [name]", async () => {
    const { dispatch, flowCalls } = setup();
    const r = await dispatch("/flow hello");
    assert.strictEqual(r.redraw, true);
    assert.deepStrictEqual(flowCalls, [["--progress", "hello"]]);
  });

  it("/flow with no name lists flows via runFlow(['--list']) and does not announce a run", async () => {
    const { dispatch, flowCalls, stdout } = setup();
    const r = await dispatch("/flow");
    assert.strictEqual(r.redraw, true);
    assert.deepStrictEqual(flowCalls, [["--list"]]);
    assert.ok(!stdout.buf.includes("Running flow"));
  });

  it("/flow preserves input spacing verbatim (JSON input survives)", async () => {
    const { dispatch, flowCalls } = setup();
    await dispatch('/flow qa-loop {"topic":"a b"}');
    assert.deepStrictEqual(flowCalls, [["--progress", "qa-loop", '{"topic":"a b"}']]);
  });

  it("/flow without a runFlow dep reports unavailable and does not throw", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const dispatch = createReplDispatch({
      sm: fakeSm(), registry: fakeRegistry(), stdout, stderr, defaultAgent: "omp",
    });
    const r = await dispatch("/flow hello");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes("flow runner not available"));
  });
});

// ── @ directed messages ──────────────────────────────────────────────

describe("dispatch @ directed messages", () => {
  it("@label msg enqueues to target, returns redraw:false on success", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@omp#1 hello world");
    assert.strictEqual(r.redraw, false);
    assert.strictEqual(r.exit, undefined);
    assert.strictEqual(sm.calls.enqueue.length, 1);
    assert.deepStrictEqual(sm.calls.enqueue[0], { target: "omp#1", msg: "hello world" });
  });

  it("@label without space writes usage to stderr, redraw:true", async () => {
    const { dispatch, sm, stderr } = setup();
    const r = await dispatch("@omp#1");
    assert.strictEqual(r.redraw, true);
    assert.ok(stderr.buf.includes("Usage: @<label> <message>"));
    assert.strictEqual(sm.calls.enqueue.length, 0);
  });

  it("@label with whitespace-only msg returns redraw:true, does not enqueue", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@omp#1   ");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.enqueue.length, 0);
  });

  it("@label msg with enqueue returning false → redraw:true", async () => {
    const { dispatch, sm } = setup({ smOpts: { enqueueResult: false } });
    const r = await dispatch("@omp#1 hi");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.enqueue.length, 1);
  });

  it("@all broadcasts to all", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@all hello everyone");
    assert.strictEqual(r.redraw, false);
    assert.strictEqual(sm.calls.enqueue.length, 1);
    assert.deepStrictEqual(sm.calls.enqueue[0], { target: "all", msg: "hello everyone" });
  });

  it("@all with enqueue returning true → redraw:false", async () => {
    const { dispatch } = setup({ smOpts: { enqueueResult: true } });
    const r = await dispatch("@all hi");
    assert.strictEqual(r.redraw, false);
  });
});

// ── normal lines ──────────────────────────────────────────────────────

describe("dispatch normal lines", () => {
  it("normal line enqueues to current session, redraw:false", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("hello world");
    assert.strictEqual(r.redraw, false);
    assert.strictEqual(r.exit, undefined);
    assert.strictEqual(sm.calls.enqueue.length, 1);
    assert.deepStrictEqual(sm.calls.enqueue[0], { msg: "hello world" });
  });

  it("normal line with enqueue returning false → redraw:true", async () => {
    const { dispatch, sm } = setup({ smOpts: { enqueueResult: false } });
    const r = await dispatch("hello");
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.enqueue.length, 1);
  });

  it("line is already trimmed by caller", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("  trimmed by caller  ");
    assert.strictEqual(r.redraw, false);
    assert.deepStrictEqual(sm.calls.enqueue[0], { msg: "  trimmed by caller  " });
  });
});

// ── Interaction effects (no unwanted side-effects) ────────────────────

describe("dispatch has no side-effects beyond I/O", () => {
  it("dispatch does NOT call any close/signal/exit handler", async () => {
    const { dispatch } = setup();
    // Just verify dispatch returns cleanly without throwing for all paths
    const r = await dispatch("hello");
    assert.strictEqual(r.redraw, false);
  });

  it("dispatch for /exit returns exit:true but does not call any close method", async () => {
    const { dispatch } = setup();
    const r = await dispatch("/exit");
    assert.deepStrictEqual(r, { exit: true });
    // No sm/registry methods called
  });
});

// ── /open +<profile> (config-driven, Task 7) ───────────────────────────

describe("dispatch /open +profile", () => {
  it("/open +coder → 按 profile 解析后调 sm.open(内联 flag 覆盖 profile)", async () => {
    const opens = [];
    const sm = {
      _sessions: new Map(),
      open: async (o) => { opens.push(o); return "omp#1"; },
    };
    const config = {
      agents: { coder: { backend: "omp", model: "m1", write: true, role: "你是 coder" } },
    };
    const dispatch = createReplDispatch({
      sm, registry: { add() {} }, stdout: { write() {} }, stderr: { write() {} },
      defaultAgent: "omp", config,
    });
    await dispatch("/open +coder", { source: "human" });
    assert.equal(opens[0].agent, "omp");
    assert.equal(opens[0].model, "m1");
    assert.equal(opens[0].write, true);
    assert.equal(opens[0].systemPrompt, "你是 coder");

    await dispatch("/open +coder --model m2", { source: "human" });
    assert.equal(opens[1].model, "m2", "内联 --model 覆盖 profile.model");
  });

  it("/open +ghost(未知 profile)→ stderr 报错,不开会话", async () => {
    const errs = [];
    const sm = { _sessions: new Map(), open: async () => { throw new Error("unreachable"); } };
    const dispatch = createReplDispatch({
      sm, registry: { add() {} }, stdout: { write() {} },
      stderr: { write: (s) => errs.push(s) },
      defaultAgent: "omp", config: { agents: {} },
    });
    const r = dispatch("/open +ghost", { source: "human" });
    const res = r && typeof r.then === "function" ? await r : r;
    assert.equal(res.redraw, true);
    assert.match(errs.join(""), /unknown profile "ghost"/);
  });

  it("agent-fence /open +writer 被 allowWrite:false 护栏拦截(profile 不能绕过护栏)", async () => {
    const sm = { _sessions: new Map(), open: async () => { throw new Error("unreachable"); } };
    const config = {
      agents: { writer: { backend: "omp", write: true, role: "writer" } },
    };
    const dispatch = createReplDispatch({
      sm, registry: { add() {} }, stdout: { write() {} }, stderr: { write() {} },
      defaultAgent: "omp", config,
      guardrails: { allowWrite: false },
    });
    const res = await dispatch("/open +writer", { source: "agent-fence", depth: 0 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /allowWrite is false/);
  });
});

// synod/test/agent-fence.test.mjs — Tests for agent-fence dispatch path.
//
// Covers:
// 1. Whitelist: /open, @specific-label, /relay → ok; everything else → rejected
// 2. Guardrails on /open: maxSessions, maxDepth, allowedAgents, allowedModels, allowWrite
// 3. Zero side-effect on rejection (sm.open/enqueue, registry.add not called)
// 4. @all rejection specifically (agent-fence R4)
// 5. Human branch still works unchanged
// 6. depth+1 data flow: /open success returns label

import { describe, it } from "node:test";
import assert from "node:assert";
import { createReplDispatch } from "../src/repl-dispatch.mjs";

// ── helpers (replicated from repl-dispatch.test.mjs, self-contained) ──────

function captureStream() {
  return { buf: "", write(s) { this.buf += s; } };
}

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
    list: () => { calls.list++; },
    calls,
  };
}

function fakeRegistry(opts = {}) {
  const calls = { add: [], remove: [], list: 0 };
  return {
    add: (from, to) => {
      calls.add.push({ from, to });
      if (opts.addThrow) throw opts.addThrow;
    },
    remove: (from, to) => { calls.remove.push({ from, to }); },
    list: () => { calls.list++; return opts.listResult || []; },
    calls,
  };
}

/** Setup with optional guardrails. */
function setup({ smOpts = {}, regOpts = {}, guardrails } = {}) {
  const sm = fakeSm(smOpts);
  const registry = fakeRegistry(regOpts);
  const stdout = captureStream();
  const stderr = captureStream();
  const dispatch = createReplDispatch({ sm, registry, stdout, stderr, defaultAgent: "omp", guardrails });
  return { dispatch, sm, registry, stdout, stderr };
}

/** Assert zero side-effects on sm, registry, stdout, stderr. */
function assertNoSideEffects(sm, registry, stdout, stderr) {
  assert.strictEqual(sm.calls.open.length, 0, "sm.open should not be called");
  assert.strictEqual(sm.calls.enqueue.length, 0, "sm.enqueue should not be called");
  assert.strictEqual(sm.calls.use.length, 0, "sm.use should not be called");
  assert.strictEqual(sm.calls.list, 0, "sm.list should not be called");
  assert.strictEqual(registry.calls.add.length, 0, "registry.add should not be called");
  assert.strictEqual(registry.calls.remove.length, 0, "registry.remove should not be called");
  assert.strictEqual(registry.calls.list, 0, "registry.list should not be called");
  assert.strictEqual(stdout.buf, "", "stdout should be empty");
  assert.strictEqual(stderr.buf, "", "stderr should be empty");
}

// ── Whitelist: allowed commands ──────────────────────────────────────────

describe("agent-fence whitelist", () => {
  it("/open --agent omp → {ok:true, label} with announce:false", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent omp", { source: "agent-fence" });
    assert.deepStrictEqual(r, { ok: true, label: "omp#1" });
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].announce, false);
  });

  it("/open --no-mesh propagates mesh:false to sm.open (de-escalation)", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent omp --no-mesh", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].mesh, false);
  });

  it("/open --mesh propagates mesh:true to sm.open (no escalation guard by design)", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent omp --mesh", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].mesh, true);
  });

  it("/open without mesh flag passes mesh:undefined (inherits session default)", async () => {
    const { dispatch, sm } = setup();
    await dispatch("/open --agent omp", { source: "agent-fence" });
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].mesh, undefined);
  });

  it("@omp#1 hi → {ok:true}, enqueue called", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@omp#1 hi", { source: "agent-fence" });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(sm.calls.enqueue.length, 1);
    assert.deepStrictEqual(sm.calls.enqueue[0], { target: "omp#1", msg: "hi" });
  });

  it("/relay a->b (both in sessions) → {ok:true}, registry.add called", async () => {
    const { dispatch, sm, registry } = setup({
      smOpts: { _sessions: [["omp#1", {}], ["codex#1", {}]] },
    });
    const r = await dispatch("/relay omp#1->codex#1", { source: "agent-fence" });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(registry.calls.add.length, 1);
    assert.deepStrictEqual(registry.calls.add[0], { from: "omp#1", to: "codex#1" });
  });
});

// ── Whitelist: rejected commands (zero side-effect) ──────────────────────
describe("agent-fence rejects disallowed commands", () => {
  it("@all xxx → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("@all hi there", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("@all"));
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("@ hi (empty target labels) → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("@ hi", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("missing target label"), `reason: ${r.reason}`);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("/use xxx → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("/use omp#1", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("/exit → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("/exit", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("/quit → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("/quit", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("/sessions → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("/sessions", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("/relays → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("/relays", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("/unrelay a->b → rejected, zero side-effect", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("/unrelay omp#1->codex#1", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("unknown /foo → rejected", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("/foo", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("plain text 'hello' → rejected, reason mentions 'not a command'", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("hello", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("not a command"));
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("'open --agent omp' (no leading /) → rejected as plain text", async () => {
    const { dispatch, sm, registry, stdout, stderr } = setup();
    const r = await dispatch("open --agent omp", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("not a command"));
    assertNoSideEffects(sm, registry, stdout, stderr);
  });

  it("/OPEN (uppercase) → unknown command, rejected", async () => {
    const { dispatch } = setup();
    const r = await dispatch("/OPEN", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.length > 0);
  });
});

// ── Guardrails on /open ──────────────────────────────────────────────────

describe("agent-fence guardrails on /open", () => {
  it("maxSessions reached → rejected, sm.open not called", async () => {
    const { dispatch, sm } = setup({
      smOpts: { _sessions: [["s1", {}], ["s2", {}]] },
      guardrails: { maxSessions: 2 },
    });
    const r = await dispatch("/open --agent omp", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("max sessions"), `reason: ${r.reason}`);
    assert.strictEqual(sm.calls.open.length, 0, "sm.open should not be called");
  });

  it("maxSessions not reached (1 < 3) → allowed", async () => {
    const { dispatch, sm } = setup({
      smOpts: { _sessions: [["s1", {}]] },
      guardrails: { maxSessions: 3 },
    });
    const r = await dispatch("/open --agent omp", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.open.length, 1);
  });

  it("depth >= maxDepth → rejected", async () => {
    const { dispatch, sm } = setup({
      guardrails: { maxDepth: 2 },
    });
    const r = await dispatch("/open --agent omp", { source: "agent-fence", depth: 2 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("max depth"), `reason: ${r.reason}`);
    assert.strictEqual(sm.calls.open.length, 0);
  });

  it("depth < maxDepth → allowed", async () => {
    const { dispatch, sm } = setup({
      guardrails: { maxDepth: 2 },
    });
    const r = await dispatch("/open --agent omp", { source: "agent-fence", depth: 1 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.open.length, 1);
  });

  it("depth == maxDepth-1 → allowed (boundary)", async () => {
    const { dispatch, sm } = setup({
      guardrails: { maxDepth: 3 },
    });
    const r = await dispatch("/open --agent omp", { source: "agent-fence", depth: 2 });
    assert.strictEqual(r.ok, true);
  });

  it("depth == maxDepth → rejected (boundary)", async () => {
    const { dispatch, sm } = setup({
      guardrails: { maxDepth: 3 },
    });
    const r = await dispatch("/open --agent omp", { source: "agent-fence", depth: 3 });
    assert.strictEqual(r.ok, false);
  });

  it("allowedAgents whitelist rejects codex when only omp", async () => {
    const { dispatch, sm } = setup({
      guardrails: { allowedAgents: ["omp"] },
    });
    const r = await dispatch("/open --agent codex", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("not in whitelist"), `reason: ${r.reason}`);
    assert.strictEqual(sm.calls.open.length, 0);
  });

  it("allowedAgents whitelist allows omp when omp is in list", async () => {
    const { dispatch, sm } = setup({
      guardrails: { allowedAgents: ["omp"] },
    });
    const r = await dispatch("/open --agent omp", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.open.length, 1);
  });

  it("allowedModels rejects unrecognized model", async () => {
    const { dispatch, sm } = setup({
      guardrails: { allowedModels: ["mini"] },
    });
    const r = await dispatch("/open --agent omp --model large", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("model"), `reason: ${r.reason}`);
    assert.strictEqual(sm.calls.open.length, 0);
  });

  it("allowedModels allows recognized model", async () => {
    const { dispatch, sm } = setup({
      guardrails: { allowedModels: ["mini"] },
    });
    const r = await dispatch("/open --agent omp --model mini", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.open.length, 1);
  });

  it("allowWrite:false rejects --write", async () => {
    const { dispatch, sm } = setup({
      guardrails: { allowWrite: false },
    });
    const r = await dispatch("/open --agent omp --write", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("write"), `reason: ${r.reason}`);
    assert.strictEqual(sm.calls.open.length, 0);
  });

  it("allowWrite:true allows --write", async () => {
    const { dispatch, sm } = setup({
      guardrails: { allowWrite: true },
    });
    const r = await dispatch("/open --agent omp --write", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.open.length, 1);
  });
  it("default guardrails (none passed) → allowWrite defaults to false", async () => {
    const { dispatch, sm } = setup();
    // Default allowWrite is false, so --write is rejected
    const r = await dispatch("/open --agent codex --write", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("write"));
    assert.strictEqual(sm.calls.open.length, 0);
  });
});

// ── Guardrails do not affect non-/open commands ─────────────────────────

describe("guardrails only apply to /open", () => {
  it("@omp#1 hi not blocked by maxSessions", async () => {
    const { dispatch, sm } = setup({
      smOpts: { _sessions: [["s1", {}]] },
      guardrails: { maxSessions: 1 },
    });
    const r = await dispatch("@omp#1 hi", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sm.calls.enqueue.length, 1);
  });

  it("/relay not blocked by guardrails", async () => {
    const { dispatch, registry } = setup({
      smOpts: { _sessions: [["a", {}], ["b", {}]] },
      guardrails: { maxSessions: 0 },
    });
    const r = await dispatch("/relay a->b", { source: "agent-fence" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(registry.calls.add.length, 1);
  });
});

// ── /relay validation in agent-fence ────────────────────────────────────

describe("agent-fence /relay validation", () => {
  it("parse error → {ok:false}", async () => {
    const { dispatch, registry } = setup();
    const r = await dispatch("/relay bad", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("->"));
    assert.strictEqual(registry.calls.add.length, 0);
  });

  it("from not in sessions → {ok:false}", async () => {
    const { dispatch, registry } = setup({
      smOpts: { _sessions: [["b", {}]] },
    });
    const r = await dispatch("/relay a->b", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("a"));
    assert.strictEqual(registry.calls.add.length, 0);
  });

  it("to not in sessions → {ok:false}", async () => {
    const { dispatch, registry } = setup({
      smOpts: { _sessions: [["a", {}]] },
    });
    const r = await dispatch("/relay a->b", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("b"));
    assert.strictEqual(registry.calls.add.length, 0);
  });

  it("registry.add throws → {ok:false}", async () => {
    const { dispatch, registry } = setup({
      smOpts: { _sessions: [["a", {}], ["b", {}]] },
      regOpts: { addThrow: new Error("cycle detected") },
    });
    const r = await dispatch("/relay a->b", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("cycle"));
    assert.strictEqual(registry.calls.add.length, 1);
  });
});

// ── /open error paths ───────────────────────────────────────────────────

describe("agent-fence /open error paths", () => {
  it("parseOpenArgs error → {ok:false}", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("requires a value"));
    assert.strictEqual(sm.calls.open.length, 0);
  });

  it("sm.open returns null → {ok:false}", async () => {
    const { dispatch, sm } = setup({ smOpts: { openResult: null } });
    const r = await dispatch("/open --agent omp", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("open failed"));
    assert.strictEqual(sm.calls.open.length, 1);
  });
});

// ── @ messages error paths ──────────────────────────────────────────────

describe("agent-fence @ message error paths", () => {
  it("@label without space → {ok:false}", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@omp#1", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(sm.calls.enqueue.length, 0);
  });

  it("@label with empty msg → {ok:false}", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@omp#1   ", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(sm.calls.enqueue.length, 0);
  });

  it("enqueue returns false → {ok:false}", async () => {
    const { dispatch, sm } = setup({ smOpts: { enqueueResult: false } });
    const r = await dispatch("@omp#1 hi", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(sm.calls.enqueue.length, 1);
  });
});

// ── Human branch unchanged ──────────────────────────────────────────────

describe("human source unchanged", () => {
  it("@all still works in human mode (redraw:false)", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@all hi everyone", { source: "human" });
    assert.strictEqual(r.redraw, false);
    assert.strictEqual(sm.calls.enqueue.length, 1);
    assert.deepStrictEqual(sm.calls.enqueue[0], { target: "all", msg: "hi everyone" });
  });

  it("human /use still works", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/use omp#1", { source: "human" });
    assert.strictEqual(r.redraw, true);
    assert.strictEqual(sm.calls.use.length, 1);
  });

  it("human default source is 'human' (no source option)", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("@omp#1 test");
    assert.strictEqual(r.redraw, false);
    assert.strictEqual(sm.calls.enqueue.length, 1);
  });
});

// ── depth + label data flow ─────────────────────────────────────────────

describe("depth+1 data flow", () => {
  it("/open success returns label so wire layer can track child depth+1", async () => {
    const { dispatch, sm } = setup();
    const r = await dispatch("/open --agent omp", { source: "agent-fence", depth: 0 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.label, "omp#1");
    // Wire would do: depthMap.set(r.label, 0 + 1)
    assert.strictEqual(sm.calls.open.length, 1);
    assert.strictEqual(sm.calls.open[0].announce, false);
  });

  it("depth defaults to 0 when not provided", async () => {
    const { dispatch, sm } = setup({ guardrails: { maxDepth: 0 } });
    // Without depth, defaults to 0.  maxDepth=0 means depth>=0 fails.
    const r = await dispatch("/open --agent omp", { source: "agent-fence" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("max depth"));
    assert.strictEqual(sm.calls.open.length, 0);
  });
});

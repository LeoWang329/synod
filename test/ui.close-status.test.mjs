import test from "node:test";
import assert from "node:assert/strict";
import { createSessionManager } from "../src/session-manager.mjs";
import { createReplDispatch } from "../src/repl-dispatch.mjs";
import { createRelayRegistry } from "../src/relay.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function cap() { return { buf: "", write(s) { this.buf += s; } }; }
function makeSm() {
  return createSessionManager({
    openBackend: async () => new FakeSession({ deltas: ["x\n"] }),
    stdout: cap(), stderr: cap(),
    report: { omp: { available: true }, codex: { available: true } },
    cwd: process.cwd(), defaults: {}, onIdle: () => {},
  });
}

test("sm.close(label):关会话、移出 _sessions、重指当前会话", async () => {
  const sm = makeSm();
  const a = await sm.open({ agent: "omp" });
  const b = await sm.open({ agent: "codex" });
  assert.equal(sm.currentLabel, b);
  const sessA = sm._sessions.get(a).session;
  assert.equal(sm.close(b), true);
  assert.equal(sm._sessions.has(b), false);
  assert.equal(sm.currentLabel, a, "当前会话关闭后回退到剩余会话");
  assert.equal(sm.close(a), true);
  assert.equal(sessA._closed, true);
  assert.equal(sm.currentLabel, null, "最后一个关闭后无当前会话");
});

test("sm.close 未知 label → false", () => {
  assert.equal(makeSm().close("ghost#1"), false);
});

test("/close:dispatch 调 sm.close + registry.removeForLabel + onCloseLabel", () => {
  const closed = [], dropped = [];
  const sm = { _sessions: new Map([["omp#1", {}]]), currentLabel: "omp#1", close: (l) => (closed.push(l), true) };
  const registry = createRelayRegistry(() => {});
  let removedFor = null;
  registry.removeForLabel = (l) => { removedFor = l; };
  const stdout = cap();
  const dispatch = createReplDispatch({
    sm, registry, stdout, stderr: cap(), defaultAgent: "omp",
    onCloseLabel: (l) => dropped.push(l),
  });
  const r = dispatch("/close omp#1", { source: "human" });
  assert.equal(r.redraw, true);
  assert.deepEqual(closed, ["omp#1"]);
  assert.equal(removedFor, "omp#1");
  assert.deepEqual(dropped, ["omp#1"]);
  assert.ok(stdout.buf.includes("Closed omp#1"));
});

test("/close 无参 → usage", () => {
  const stderr = cap();
  const dispatch = createReplDispatch({ sm: { _sessions: new Map() }, registry: {}, stdout: cap(), stderr, defaultAgent: "omp" });
  dispatch("/close", { source: "human" });
  assert.ok(stderr.buf.includes("Usage: /close <label>"));
});

test("/close 在 agent-fence 下被拒(仅主持人可关会话)", async () => {
  const dispatch = createReplDispatch({ sm: { _sessions: new Map([["omp#1", {}]]) }, registry: {}, stdout: cap(), stderr: cap(), defaultAgent: "omp" });
  const r = await dispatch("/close omp#1", { source: "agent-fence", depth: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not allowed in agent-fence/);
});

test("/status:一行总览(会话数/在跑/relay/当前/flow)", () => {
  const stdout = cap();
  const sm = {
    _sessions: new Map([
      ["omp#1", { session: { status: "running" } }],
      ["codex#1", { session: { status: "idle" } }],
    ]),
    currentLabel: "omp#1",
  };
  const registry = createRelayRegistry(() => {});
  registry.add("omp#1", "codex#1");
  const dispatch = createReplDispatch({ sm, registry, stdout, stderr: cap(), defaultAgent: "omp", flowStatus: () => "none" });
  const r = dispatch("/status", { source: "human" });
  assert.equal(r.redraw, true);
  assert.match(stdout.buf, /sessions: 2 \(1 running\)/);
  assert.match(stdout.buf, /relays: 1/);
  assert.match(stdout.buf, /current: omp#1/);
  assert.match(stdout.buf, /flow: none/);
});

// test/flow.agent-concurrency.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/flow/api/agent.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function makeDeps() {
  const runs = new Map();
  const getRunState = (runId) => {
    let rs = runs.get(runId);
    if (!rs) {
      rs = { reusedSessions: new Map(), keyChains: new Map(), disposed: false, lastSinkError: null };
      runs.set(runId, rs);
    }
    return rs;
  };
  const removeReusedSession = (runId, key) => { runs.get(runId)?.reusedSessions.delete(key); };
  const logger = { logStep: async () => {}, logSession: async () => {} };
  return { runs, getRunState, removeReusedSession, logger };
}

// 现状 bug(V1 文档 P1-6b):reuse 会话在 send 之前入池;Promise.all
// 同 key 并发时,第二个调用拿到正在流式输出的会话并发 send。
// 期望语义:复用 = 同 key 调用按链串行,且只开一个会话。
test("reuse 同 key 并发调用串行执行且共享一个会话", async () => {
  let opened = 0, active = 0, maxActive = 0;
  const openBackend = async () => {
    opened++;
    const s = new FakeSession({ deltas: ["ok"] });
    const orig = s.send.bind(s);
    s.send = async (msg, o) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      const res = await orig(msg, o);
      active--;
      return res;
    };
    return s;
  };
  const deps = makeDeps();
  const agent = createAgent({
    openBackend, logger: deps.logger,
    getRunState: deps.getRunState, removeReusedSession: deps.removeReusedSession,
  });
  const ctx = { runId: "r1", cwd: "/tmp" };
  await Promise.all([
    agent(ctx, { agent: "omp", prompt: "a", reuse: true }),
    agent(ctx, { agent: "omp", prompt: "b", reuse: true }),
  ]);
  assert.equal(maxActive, 1, "同一会话的 send 不得并发");
  assert.equal(opened, 1, "同 key 只允许开一个会话");
});

test("前一个调用失败不阻断链上后续调用", async () => {
  let calls = 0;
  const openBackend = async () => {
    calls++;
    return new FakeSession(calls === 1 ? { failPrompt: true } : { deltas: ["fine"] });
  };
  const deps = makeDeps();
  const agent = createAgent({
    openBackend, logger: deps.logger,
    getRunState: deps.getRunState, removeReusedSession: deps.removeReusedSession,
  });
  const ctx = { runId: "r1", cwd: "/tmp" };
  const [a, b] = await Promise.allSettled([
    agent(ctx, { agent: "omp", prompt: "a", reuse: true }),
    agent(ctx, { agent: "omp", prompt: "b", reuse: true }),
  ]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
  assert.equal(b.value, "fine");
});

test("非 reuse 调用不进链(可并行)", async () => {
  let active = 0, maxActive = 0;
  const openBackend = async () => {
    const s = new FakeSession({ deltas: ["x"] });
    const orig = s.send.bind(s);
    s.send = async (msg, o) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      const res = await orig(msg, o);
      active--;
      return res;
    };
    return s;
  };
  const deps = makeDeps();
  const agent = createAgent({
    openBackend, logger: deps.logger,
    getRunState: deps.getRunState, removeReusedSession: deps.removeReusedSession,
  });
  const ctx = { runId: "r1", cwd: "/tmp" };
  await Promise.all([
    agent(ctx, { agent: "omp", prompt: "a" }),
    agent(ctx, { agent: "omp", prompt: "b" }),
  ]);
  assert.equal(maxActive, 2, "一次性会话各自独立,应并行");
});

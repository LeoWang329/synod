// test/flow.agent-profile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/flow/runtime.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {} };

function runtimeWithSpy(config) {
  const opened = [];
  const openBackend = async (opts) => {
    opened.push(opts);
    return new FakeSession({ deltas: ["ok"] });
  };
  return { opened, runtime: createRuntime({ openBackend, fs: nullFs, clock: () => 0, config }) };
}

test("agent({profile}) 解析 profile 并透传 write/effort/mesh/systemPrompt", async () => {
  const config = {
    agents: { coder: { backend: "omp", model: "m1", effort: "high",
                       write: true, mesh: false, role: "你是 coder" } },
  };
  const { opened, runtime } = runtimeWithSpy(config);
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  await runtime.agent(ctx, { profile: "coder", prompt: "do it" });
  assert.equal(opened[0].agent, "omp");
  assert.equal(opened[0].model, "m1");
  assert.equal(opened[0].effort, "high");
  assert.equal(opened[0].write, true);
  assert.equal(opened[0].systemPrompt, "你是 coder");
});

test("内联字段覆盖 profile;未知 profile 抛错", async () => {
  const config = { agents: { coder: { backend: "omp", model: "m1", write: true } } };
  const { opened, runtime } = runtimeWithSpy(config);
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  await runtime.agent(ctx, { profile: "coder", model: "m2", write: false, prompt: "x" });
  assert.equal(opened[0].model, "m2");
  assert.equal(opened[0].write, false);
  await assert.rejects(
    runtime.agent(ctx, { profile: "ghost", prompt: "x" }),
    /unknown profile "ghost"/,
  );
});

test("无 profile 仍可直接传 write/effort(P1-12 主诉求)", async () => {
  const { opened, runtime } = runtimeWithSpy(undefined);
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  await runtime.agent(ctx, { agent: "omp", write: true, effort: "xhigh", prompt: "x" });
  assert.equal(opened[0].write, true);
  assert.equal(opened[0].effort, "xhigh");
});

test("reuse 的 sessionKey 区分 write/effort(不同权限不得共用会话)", async () => {
  const { opened, runtime } = runtimeWithSpy(undefined);
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  await runtime.agent(ctx, { agent: "omp", prompt: "a", reuse: true });
  await runtime.agent(ctx, { agent: "omp", write: true, prompt: "b", reuse: true });
  assert.equal(opened.length, 2, "write 不同必须各开会话");
  await runtime.disposeRun(ctx);
});

test("agentLoop 同样支持 profile + 发 progress 事件", async () => {
  const events = [];
  const config = { agents: { judge: { backend: "omp", model: "m9" } } };
  const openBackend = async (opts) => {
    events.push({ type: "_open", opts });
    return new FakeSession({ deltas: ["PASS"] });
  };
  const runtime = createRuntime({
    openBackend, fs: nullFs, clock: () => 0, config,
    progress: { emit: (e) => events.push(e) },
  });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  const out = await runtime.agentLoop(ctx, {
    profile: "judge", prompt: "go", until: (o) => o.includes("PASS"), maxTurns: 2,
  });
  assert.equal(out, "PASS");
  assert.equal(events.find((e) => e.type === "_open").opts.model, "m9");
  assert.ok(events.some((e) => e.type === "delta"), "agentLoop 必须接 progress sink");
});

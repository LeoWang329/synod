// test/flow.dispose-race.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/flow/runtime.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {} };

// 现状 bug(V1 文档 P1-7):Promise.all 一支失败 → runFlow finally →
// disposeRun 删除 run state;另一支 agent(reuse) 的 openBackend 还在
// 飞,完成后把会话塞进"已被孤立"的 state → 永远没人 close = 子进程
// 泄漏到 synod 退出。期望:dispose 后完成的调用不入池、用完即关。
test("disposeRun 期间在飞的 reuse agent() 不复活会话(无泄漏)", async () => {
  let theSession;
  const openBackend = async () => {
    await new Promise((r) => setTimeout(r, 50));   // dispose 发生在 open 进行中
    theSession = new FakeSession({ deltas: ["ok"] });
    return theSession;
  };
  const runtime = createRuntime({ openBackend, fs: nullFs, clock: () => 0 });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });

  const p = runtime.agent(ctx, { agent: "omp", prompt: "x", reuse: true });
  await new Promise((r) => setTimeout(r, 10));
  await runtime.disposeRun(ctx);                   // 此刻 open 还没返回
  await p;                                         // 调用本身正常完成

  assert.equal(theSession._closed, true, "dispose 后完成的会话必须被关闭");
  assert.equal(runtime._getRunState(ctx.runId).reusedSessions.size, 0);
});

test("disposeRun 幂等且正常路径语义不变", async () => {
  const openBackend = async () => new FakeSession({ deltas: ["ok"] });
  const runtime = createRuntime({ openBackend, fs: nullFs, clock: () => 0 });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  await runtime.agent(ctx, { agent: "omp", prompt: "x", reuse: true });
  const rs = runtime._getRunState(ctx.runId);
  assert.equal(rs.reusedSessions.size, 1, "正常 reuse 仍入池");
  const pooled = rs.reusedSessions.values().next().value.session;
  await runtime.disposeRun(ctx);
  await runtime.disposeRun(ctx);                   // 幂等
  assert.equal(pooled._closed, true);
  assert.equal(rs.reusedSessions.size, 0);
});

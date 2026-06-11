// test/flow.concurrency.test.mjs — P1-29:并发 run 互不串扰(AsyncLocalStorage)。
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import { agent as flowAgent } from "../src/flow/index.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {} };

test("两个 run 并发,各自的 getCurrentRuntime 互不覆盖", async () => {
  const mk = (tag) => createRuntime({
    openBackend: async () => new FakeSession({ deltas: [tag] }),
    fs: nullFs, clock: () => 0,
  });
  const rtA = mk("A");
  const rtB = mk("B");
  const flowA = {
    name: "A", meta: { description: "a" },
    async run(ctx) {
      await new Promise((r) => setTimeout(r, 10));         // 让 B 插进来
      return flowAgent(ctx, { agent: "omp", prompt: "x" }); // 必须仍解析到 rtA
    },
  };
  const flowB = {
    name: "B", meta: { description: "b" },
    async run(ctx) { return flowAgent(ctx, { agent: "omp", prompt: "y" }); },
  };
  const [a, b] = await Promise.all([
    runFlow(rtA, flowA, rtA.createCtx(undefined, { cwd: "/tmp" }), undefined),
    runFlow(rtB, flowB, rtB.createCtx(undefined, { cwd: "/tmp" }), undefined),
  ]);
  assert.equal(a, "A", "run A 的原语必须用 run A 的 runtime(不被 B 覆盖)");
  assert.equal(b, "B");
});

test("非 LIFO 完成:先起的 run 先结束,不污染后起 run 的上下文", async () => {
  // 这是真正区分 ALS 与旧"模块单例 + save/restore"的用例:旧实现下 A 先起、
  // 先结束,其 runFlow finally 会把模块单例 restore 成 A 之前的值(null);B 在更
  // 晚的时点才读 getCurrentRuntime → 取到被污染的 null → 抛 "No active flow runtime"。
  // ALS 下每个 run 读自己的 store,A 结束与否都不影响 B。
  const mk = (tag) => createRuntime({
    openBackend: async () => new FakeSession({ deltas: [tag] }),
    fs: nullFs, clock: () => 0,
  });
  const rtA = mk("A");
  const rtB = mk("B");
  const flowA = {
    name: "A", meta: { description: "a" },
    async run() { await new Promise((r) => setTimeout(r, 10)); return "doneA"; },
  };
  const flowB = {
    name: "B", meta: { description: "b" },
    async run(ctx) {
      await new Promise((r) => setTimeout(r, 30));          // 等 A 结束并 restore 之后
      return flowAgent(ctx, { agent: "omp", prompt: "y" }); // 必须仍解析到 rtB
    },
  };
  const [, b] = await Promise.all([
    runFlow(rtA, flowA, rtA.createCtx(undefined, { cwd: "/tmp" }), undefined),
    runFlow(rtB, flowB, rtB.createCtx(undefined, { cwd: "/tmp" }), undefined),
  ]);
  assert.equal(b, "B", "A 的 finally 不得把 B 的活动 runtime 抹掉/恢复成旧值");
});

test("getCurrentRuntime 在 run 外抛错", async () => {
  const { getCurrentRuntime } = await import("../src/flow/current-run.mjs");
  assert.throws(() => getCurrentRuntime(), /No active flow runtime/);
});

// test/flow.resume.agent.test.mjs — Task 3 装配 + Task 4 命中回放。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRuntime } from "../src/flow/runtime.mjs";
import { shortHash } from "../src/flow/logger.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };
const h8 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 8);

test("logger.shortHash 是模块级导出且 = sha1 前 8 位(与 1C-a key 同源)", () => {
  assert.equal(typeof shortHash, "function");
  assert.equal(shortHash("hello"), h8("hello"));
});

test("createCtx 透传 runId(resume 复用旧 runId)", () => {
  const rt = createRuntime({ fs: nullFs, clock: () => 0 });
  const ctx = rt.createCtx({}, { cwd: "/tmp", runId: "old-run-1" });
  assert.equal(ctx.runId, "old-run-1");
});

test("replay 计划下 replayStep 前缀匹配 node+hash,命中推进游标;失配后停用", () => {
  const steps = [
    { node: "omp", hash: h8("p1"), output: "O1", type: "agent", entry: {} },
    { node: "bash", hash: h8("ls"), output: "L", type: "bash", entry: { code: 0 } },
  ];
  const rt = createRuntime({
    fs: nullFs, clock: () => 0,
    replay: { runId: "r", steps },
  });
  const ctx = rt.createCtx({}, { cwd: "/tmp", runId: "r" });
  let rep = rt._replayStep(ctx.runId, { node: "omp", input: "p1" });
  assert.equal(rep.hit, true);
  assert.equal(rep.output, "O1");
  rep = rt._replayStep(ctx.runId, { node: "bash", input: "WRONG" });
  assert.equal(rep.hit, false);
  rep = rt._replayStep(ctx.runId, { node: "bash", input: "ls" });
  assert.equal(rep.hit, false);
});

test("无 replay 计划:replayStep 永远 miss(常态零开销)", () => {
  const rt = createRuntime({ fs: nullFs, clock: () => 0 });
  const ctx = rt.createCtx({}, { cwd: "/tmp", runId: "fresh" });
  assert.equal(rt._replayStep(ctx.runId, { node: "omp", input: "x" }).hit, false);
});

// ── Task 4: agent / agentLoop 命中重放 ───────────────────────────────────

function throwingOpenBackend() {
  return async () => { throw new Error("openBackend MUST NOT be called on replay hit"); };
}

test("agent 命中重放:回放 logged 输出,绝不 openBackend", async () => {
  const steps = [{ node: "omp", hash: h8("do it"), output: "REPLAYED", type: "agent", entry: {} }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    openBackend: throwingOpenBackend(),
    replay: { runId: "r", steps },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const out = await runtime.agent(ctx, { agent: "omp", prompt: "do it" });
  assert.equal(out, "REPLAYED");
});

test("agent 失配后真跑:第一个不匹配处起 openBackend 被调用", async () => {
  let opened = 0;
  const { FakeSession } = await import("./helpers/fake-backend.mjs");
  const steps = [{ node: "omp", hash: h8("first"), output: "R1", type: "agent", entry: {} }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    openBackend: async () => { opened += 1; return new FakeSession({ deltas: ["LIVE"] }); },
    replay: { runId: "r", steps },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  assert.equal(await runtime.agent(ctx, { agent: "omp", prompt: "first" }), "R1");
  assert.equal(opened, 0, "首个命中重放,不开 agent");
  assert.equal(await runtime.agent(ctx, { agent: "omp", prompt: "second" }), "LIVE");
  assert.equal(opened, 1, "失配后真开一次");
});

test("agentLoop 全 turn 命中重放:不 openBackend,until 用 logged 输出", async () => {
  const steps = [
    { node: "omp", hash: h8("t1"), output: "step-1", type: "agentLoop", entry: {} },
    { node: "omp", hash: h8("t2"), output: "DONE",   type: "agentLoop", entry: {} },
  ];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    openBackend: throwingOpenBackend(),
    replay: { runId: "r", steps },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const out = await runtime.agentLoop(ctx, {
    agent: "omp",
    prompt: (turn) => (turn === 1 ? "t1" : "t2"),
    until: (o) => o === "DONE",
    maxTurns: 5,
  });
  assert.equal(out, "DONE");
});

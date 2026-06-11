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

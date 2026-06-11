// test/flow.perrun.test.mjs — P2-14/15:per-run 目录 + durationMs + 确定性 key。
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/flow/runtime.mjs";

function memoryFs() {
  const files = new Map(); const dirs = [];
  return {
    async writeFile(p, c) { files.set(p, c); },
    async appendFile(p, c) { files.set(p, (files.get(p) ?? "") + c); },
    async mkdir(p) { dirs.push(p); },
    files, dirs,
  };
}

test("per-run:日志写到 runsRoot/<runId>/run.log.jsonl", async () => {
  const fs = memoryFs();
  const runtime = createRuntime({ fs, clock: () => 1, runsRoot: "/RUNS" });
  const ctx = runtime.createCtx({});
  await runtime.logger.logStep(ctx, { node: "n", type: "agent", attempt: 1, input: "p", output: "o" });
  const key = `/RUNS/${ctx.runId}/run.log.jsonl`;
  assert.ok(fs.files.has(key), "应写到 per-run 目录");
  assert.ok(fs.dirs.some((d) => d.includes(ctx.runId)), "应 mkdir per-run 目录");
});

test("结束行有独立 ts + durationMs + 确定性 key", async () => {
  const fs = memoryFs();
  let t = 1000;
  const runtime = createRuntime({ fs, clock: () => (t += 5), runsRoot: "/RUNS" });
  const ctx = runtime.createCtx({});
  await runtime.logger.logStep(ctx, { node: "n", type: "agent", attempt: 1, input: "hello", output: "o" });
  const lines = fs.files.get(`/RUNS/${ctx.runId}/run.log.jsonl`).trim().split("\n").map(JSON.parse);
  const [started, ended] = lines;
  assert.notEqual(ended.ts, started.ts, "结束行独立时间戳");
  assert.equal(typeof ended.durationMs, "number");
  assert.ok(ended.durationMs >= 0);
  assert.match(started.key, /^0:n:[0-9a-f]{8}$/, "key = seq:node:inputHash8");
  assert.equal(started.key, ended.key, "start/end 同 key");
});

test("同 run 多次原语调用序号递增,不同 run 各自从 0 起", async () => {
  const fs = memoryFs();
  const runtime = createRuntime({ fs, clock: () => 1, runsRoot: "/RUNS" });
  const a = runtime.createCtx({}); const b = runtime.createCtx({});
  await runtime.logger.logStep(a, { node: "x", type: "bash", attempt: 1, input: "1" });
  await runtime.logger.logStep(a, { node: "y", type: "bash", attempt: 1, input: "2" });
  await runtime.logger.logStep(b, { node: "z", type: "bash", attempt: 1, input: "3" });
  const la = fs.files.get(`/RUNS/${a.runId}/run.log.jsonl`).trim().split("\n").map(JSON.parse);
  const lb = fs.files.get(`/RUNS/${b.runId}/run.log.jsonl`).trim().split("\n").map(JSON.parse);
  assert.match(la[0].key, /^0:x:/); assert.match(la[2].key, /^1:y:/);
  assert.match(lb[0].key, /^0:z:/);
});

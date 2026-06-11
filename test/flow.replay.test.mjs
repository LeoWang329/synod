import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunLog, prepareResume } from "../src/flow/replay.mjs";
import { writeCheckpoint } from "../src/flow/checkpoint.mjs";

function makeRun(lines) {
  const root = mkdtempSync(join(tmpdir(), "synod-replay-"));
  const runId = "run-x";
  const dir = join(root, runId);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "run.log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { root, runId, dir };
}

test("parseRunLog:succeeded step 按日志顺序收集,node/hash/output 抽取正确", async () => {
  const { root, runId } = makeRun([
    { event: "step:started",   runId: "run-x", stepId: "s1", node: "omp",  type: "agent", attempt: 1, ts: 1, key: "0:omp:11111111" },
    { event: "step:succeeded", runId: "run-x", stepId: "s1", node: "omp",  type: "agent", attempt: 1, ts: 2, durationMs: 1, key: "0:omp:11111111", input: "p1", output: "OUT1" },
    { event: "step:started",   runId: "run-x", stepId: "s2", node: "bash", type: "bash",  attempt: 1, ts: 3, key: "1:bash:22222222" },
    { event: "step:succeeded", runId: "run-x", stepId: "s2", node: "bash", type: "bash",  attempt: 1, ts: 4, durationMs: 1, key: "1:bash:22222222", input: "ls", output: "a\nb", code: 0 },
  ]);
  const { steps, sawFailure } = await parseRunLog(join(root, runId));
  assert.equal(sawFailure, false);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.node), ["omp", "bash"]);
  assert.deepEqual(steps.map((s) => s.hash), ["11111111", "22222222"]);
  assert.equal(steps[0].output, "OUT1");
  assert.equal(steps[1].entry.code, 0);
});

test("parseRunLog:step:failed 标记边界,失败 step 不进 steps", async () => {
  const { root, runId } = makeRun([
    { event: "step:started",   runId: "run-x", stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 1, key: "0:omp:aaaaaaaa" },
    { event: "step:succeeded", runId: "run-x", stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 2, key: "0:omp:aaaaaaaa", output: "OK" },
    { event: "step:started",   runId: "run-x", stepId: "s2", node: "omp", type: "agent", attempt: 1, ts: 3, key: "1:omp:bbbbbbbb" },
    { event: "step:failed",    runId: "run-x", stepId: "s2", node: "omp", type: "agent", attempt: 1, ts: 4, key: "1:omp:bbbbbbbb", error: { message: "boom" } },
  ]);
  const { steps, sawFailure, failedNode } = await parseRunLog(join(root, runId));
  assert.equal(steps.length, 1, "只 s1 完成");
  assert.equal(sawFailure, true);
  assert.equal(failedNode, "omp");
});

test("parseRunLog:大输出走 outputRef artifact → 读回全文", async () => {
  const { root, runId, dir } = makeRun([]);
  const big = "Z".repeat(500);
  const refPath = join(dir, "artifacts", "s9.output.txt");
  writeFileSync(refPath, big);
  writeFileSync(join(dir, "run.log.jsonl"),
    JSON.stringify({ event: "step:started",   runId, stepId: "s9", node: "omp", type: "agent", attempt: 1, ts: 1, key: "0:omp:cccccccc" }) + "\n" +
    JSON.stringify({ event: "step:succeeded", runId, stepId: "s9", node: "omp", type: "agent", attempt: 1, ts: 2, key: "0:omp:cccccccc", input: "p", outputRef: refPath }) + "\n");
  const { steps } = await parseRunLog(dir);
  assert.equal(steps[0].output, big, "outputRef 被读回全文");
});

test("parseRunLog:run.log 不存在 → 空 steps(不抛)", async () => {
  const root = mkdtempSync(join(tmpdir(), "synod-replay-none-"));
  const { steps, sawFailure } = await parseRunLog(join(root, "nope"));
  assert.deepEqual(steps, []);
  assert.equal(sawFailure, false);
});

test("prepareResume:合并 checkpoint(flowName/input/cwd)+ run.log(steps)", async () => {
  const { root, runId, dir } = makeRun([
    { event: "step:started",   runId: "run-x", stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 1, key: "0:omp:dddddddd" },
    { event: "step:succeeded", runId: "run-x", stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 2, key: "0:omp:dddddddd", input: "p", output: "OUT" },
  ]);
  writeCheckpoint(root, runId, { flowName: "build", input: { goal: "x" }, cwd: "/proj", status: "failed" });
  const r = await prepareResume(root, runId);
  assert.equal(r.flowName, "build");
  assert.deepEqual(r.input, { goal: "x" });
  assert.equal(r.cwd, "/proj");
  assert.equal(r.steps.length, 1);
});

test("prepareResume:无 checkpoint → 抛带 runId 的错(无从复跑 flowName/input)", async () => {
  const root = mkdtempSync(join(tmpdir(), "synod-resume-noc-"));
  mkdirSync(join(root, "run-z"), { recursive: true });
  writeFileSync(join(root, "run-z", "run.log.jsonl"), "");
  await assert.rejects(prepareResume(root, "run-z"), /no checkpoint.*run-z/i);
});

test("parseRunLog:失败边界之后的 succeeded(如 defer 清理)不进重放计划", async () => {
  const { root, runId } = makeRun([
    { event: "step:started",   runId: "run-x", stepId: "s1", node: "omp",  type: "agent", attempt: 1, ts: 1, key: "0:omp:aaaaaaaa" },
    { event: "step:succeeded", runId: "run-x", stepId: "s1", node: "omp",  type: "agent", attempt: 1, ts: 2, key: "0:omp:aaaaaaaa", output: "OK" },
    { event: "step:started",   runId: "run-x", stepId: "s2", node: "omp",  type: "agent", attempt: 1, ts: 3, key: "1:omp:bbbbbbbb" },
    { event: "step:failed",    runId: "run-x", stepId: "s2", node: "omp",  type: "agent", attempt: 1, ts: 4, key: "1:omp:bbbbbbbb", error: { message: "boom" } },
    // 失败之后的 defer 清理 succeeded —— 绝不能进重放(否则越界回放)
    { event: "step:started",   runId: "run-x", stepId: "s3", node: "bash", type: "bash",  attempt: 1, ts: 5, key: "2:bash:cccccccc" },
    { event: "step:succeeded", runId: "run-x", stepId: "s3", node: "bash", type: "bash",  attempt: 1, ts: 6, key: "2:bash:cccccccc", output: "cleanup", code: 0 },
  ]);
  const { steps, sawFailure, failedNode } = await parseRunLog(join(root, runId));
  assert.equal(sawFailure, true);
  assert.equal(failedNode, "omp");
  assert.equal(steps.length, 1, "只 s1(失败前)进重放;s3 在失败边界之后被排除");
  assert.equal(steps[0].node, "omp");
});

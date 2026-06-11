import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns } from "../src/runs.mjs";
import { writeCheckpoint } from "../src/flow/checkpoint.mjs";

test("listRuns 读 runsRoot 下每个 run 的元信息", () => {
  const root = mkdtempSync(join(tmpdir(), "synod-runs-"));
  mkdirSync(join(root, "run-1"));
  writeFileSync(join(root, "run-1", "run.log.jsonl"),
    JSON.stringify({ event: "step:started", runId: "run-1", node: "n", type: "agent", ts: 1000, key: "0:n:abc" }) + "\n" +
    JSON.stringify({ event: "step:succeeded", runId: "run-1", node: "n", type: "agent", ts: 1005, durationMs: 5, key: "0:n:abc" }) + "\n");
  const runs = listRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "run-1");
  assert.equal(typeof runs[0].startedAt, "number");
  assert.ok(["done", "failed", "running"].includes(runs[0].status));
});

test("listRuns:runsRoot 不存在 → 空数组", () => {
  assert.deepEqual(listRuns(join(tmpdir(), "nope-" + Date.now())), []);
});

test("listRuns 优先读 checkpoint:awaiting-approval / failed@<node>", () => {
  const root = mkdtempSync(join(tmpdir(), "synod-runs-ck-"));
  mkdirSync(join(root, "run-aw"));
  writeFileSync(join(root, "run-aw", "run.log.jsonl"),
    JSON.stringify({ event: "step:succeeded", runId: "run-aw", node: "n", type: "agent", ts: 1000, key: "0:n:x" }) + "\n");
  writeCheckpoint(root, "run-aw", { flowName: "f", input: null, cwd: "/p", status: "awaiting-approval",
    stoppedAt: { node: "approve", type: "approve", inputHash: "h" } });
  mkdirSync(join(root, "run-fail"));
  writeFileSync(join(root, "run-fail", "run.log.jsonl"),
    JSON.stringify({ event: "step:failed", runId: "run-fail", node: "build", type: "agent", ts: 2000, key: "0:build:y" }) + "\n");
  writeCheckpoint(root, "run-fail", { flowName: "f", input: null, cwd: "/p", status: "failed",
    stoppedAt: { node: "build", type: "agent", inputHash: "h" }, error: "boom" });

  const runs = Object.fromEntries(listRuns(root).map((r) => [r.runId, r]));
  assert.equal(runs["run-aw"].status, "awaiting-approval");
  assert.equal(runs["run-fail"].status, "failed");
  assert.equal(runs["run-fail"].failedNode, "build");
});

test("listRuns:无 checkpoint → 回落 log 末行猜测(1C-a 行为不回归)", () => {
  const root = mkdtempSync(join(tmpdir(), "synod-runs-nock-"));
  mkdirSync(join(root, "run-old"));
  writeFileSync(join(root, "run-old", "run.log.jsonl"),
    JSON.stringify({ event: "step:succeeded", runId: "run-old", node: "n", type: "agent", ts: 5, key: "0:n:z" }) + "\n");
  const r = listRuns(root)[0];
  assert.equal(r.runId, "run-old");
  assert.ok(["done", "failed", "running"].includes(r.status));
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns } from "../src/runs.mjs";

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

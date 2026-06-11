import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCheckpoint, readCheckpoint, EXIT_AWAITING_HUMAN, awaitingHumanError, isAwaitingHuman,
} from "../src/flow/checkpoint.mjs";

function runsRootTmp() {
  return mkdtempSync(join(tmpdir(), "synod-ckpt-"));
}

test("退出码常量 = 5;awaitingHumanError 可被 isAwaitingHuman 识别", () => {
  assert.equal(EXIT_AWAITING_HUMAN, 5);
  const e = awaitingHumanError({ runId: "r1", node: "approve" });
  assert.equal(e.name, "AwaitingHuman");
  assert.equal(e.runId, "r1");
  assert.equal(e.exitCode, 5);
  assert.equal(isAwaitingHuman(e), true);
  assert.equal(isAwaitingHuman(new Error("nope")), false);
});

test("writeCheckpoint 建 per-run 目录并写 checkpoint.json;readCheckpoint 取回", () => {
  const root = runsRootTmp();
  writeCheckpoint(root, "run-a", {
    flowName: "build", input: { x: 1 }, cwd: "/proj", status: "running",
  });
  const p = join(root, "run-a", "checkpoint.json");
  assert.ok(existsSync(p));
  const got = readCheckpoint(root, "run-a");
  assert.equal(got.runId, "run-a");
  assert.equal(got.flowName, "build");
  assert.deepEqual(got.input, { x: 1 });
  assert.equal(got.status, "running");
  assert.equal(typeof got.startedAt, "number");
  assert.equal(typeof got.updatedAt, "number");
});

test("writeCheckpoint 二次调用是合并补丁:保留 startedAt/flowName,更新 status+stoppedAt", () => {
  const root = runsRootTmp();
  writeCheckpoint(root, "run-b", { flowName: "f", input: null, cwd: "/p", status: "running" });
  const first = readCheckpoint(root, "run-b");
  writeCheckpoint(root, "run-b", {
    status: "awaiting-approval",
    stoppedAt: { node: "approve", type: "approve", inputHash: "abc12345" },
    pending: { content: "ready?" },
  });
  const got = readCheckpoint(root, "run-b");
  assert.equal(got.startedAt, first.startedAt, "startedAt 不被覆盖");
  assert.equal(got.flowName, "f", "已有字段不被补丁抹掉");
  assert.equal(got.status, "awaiting-approval");
  assert.equal(got.stoppedAt.node, "approve");
  assert.equal(got.pending.content, "ready?");
  assert.ok(got.updatedAt >= first.updatedAt);
});

test("writeCheckpoint:patch 即便显式带 startedAt 也不覆盖首写时间(锁死防御)", () => {
  const root = runsRootTmp();
  writeCheckpoint(root, "run-lock", { flowName: "f", input: null, cwd: "/p", status: "running" });
  const first = readCheckpoint(root, "run-lock");
  // 恶意/误传:patch 携带 startedAt
  writeCheckpoint(root, "run-lock", { status: "done", startedAt: 999999 });
  const got = readCheckpoint(root, "run-lock");
  assert.equal(got.startedAt, first.startedAt, "startedAt 被锁死,patch 无法覆盖");
  assert.notEqual(got.startedAt, 999999);
  assert.equal(got.status, "done");
});

test("readCheckpoint:不存在 → null;坏 JSON → null(不抛)", () => {
  const root = runsRootTmp();
  assert.equal(readCheckpoint(root, "ghost"), null);
});

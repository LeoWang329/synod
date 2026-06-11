// synod/src/flow/checkpoint.mjs — 断点文件(resume 与尸检的共同入口,§4.12-4)。
//
// 落点:~/.synod/runs/<runId>/checkpoint.json。字段:
//   { runId, flowName, input, cwd, status, startedAt, updatedAt,
//     stoppedAt:{node,type,inputHash}|null, pending:{content}|null,
//     error:string|null, worktrees:[{name,branch,path}] }
//   status ∈ "running" | "done" | "failed" | "awaiting-approval"
//
// 设计:writeCheckpoint 是"合并补丁"——读旧文件浅合并新字段,故 flow 启动写一份
// running 初始档(含 flowName/input/cwd,供 resume 复跑;硬 kill 也留得住),
// 后续 headless 断点/异常只补 status/stoppedAt/pending/error。同步 fs:checkpoint
// 写在原语边界(approve)与 flow 收尾,量极小,同步免去 async 传染。
import fs from "node:fs";
import path from "node:path";

/** 退出码 5 = awaiting human(§4.13;阶段 3 退出码字典正式收编,本计划先落地)。 */
export const EXIT_AWAITING_HUMAN = 5;

/** 构造"等人"专用错误:flow.main 据此返回退出码 5。 */
export function awaitingHumanError({ runId, node }) {
  const e = new Error(
    `awaiting human at node "${node}" (run ${runId}) — resume with: synod resume ${runId}`,
  );
  e.name = "AwaitingHuman";
  e.runId = runId;
  e.node = node;
  e.exitCode = EXIT_AWAITING_HUMAN;
  return e;
}

export function isAwaitingHuman(err) {
  return Boolean(err) && err.name === "AwaitingHuman";
}

function checkpointPath(runsRoot, runId) {
  return path.join(runsRoot, runId, "checkpoint.json");
}

/** 读取 checkpoint;不存在或坏 JSON → null(尽力而为,绝不抛)。 */
export function readCheckpoint(runsRoot, runId) {
  try {
    const raw = fs.readFileSync(checkpointPath(runsRoot, runId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 合并写 checkpoint。首次写补 runId/startedAt;每次写更新 updatedAt。
 * patch 里出现的键覆盖旧值;未出现的键保留(浅合并)。
 */
export function writeCheckpoint(runsRoot, runId, patch = {}) {
  const dir = path.join(runsRoot, runId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* 目录可能已存在 */ }
  const prev = readCheckpoint(runsRoot, runId) ?? {};
  const now = Date.now();
  const next = {
    runId,
    ...prev,
    ...patch,
    runId, // 锁死 runId 不被 patch 覆盖
    startedAt: prev.startedAt ?? now, // 锁死 startedAt:首写后绝不被 patch 覆盖
    updatedAt: now,
  };
  fs.writeFileSync(checkpointPath(runsRoot, runId), JSON.stringify(next, null, 2) + "\n");
  return next;
}

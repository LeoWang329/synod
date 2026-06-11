// synod/src/runs.mjs — 列举 ~/.synod/runs 下的 run(synod runs 用)。
// 基础版:runId / flow 名(从首个 step:started 的 node 不可靠,故读 run.log 头部
// 的 ts 与末行 event 判定状态)。1C-b 会在此基础上加 resume 可恢复性标注。
import fs from "node:fs";
import path from "node:path";
import { readCheckpoint } from "./flow/checkpoint.mjs";

export function listRuns(runsRoot) {
  let names;
  try { names = fs.readdirSync(runsRoot, { withFileTypes: true }); }
  catch { return []; }
  const runs = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const logPath = path.join(runsRoot, ent.name, "run.log.jsonl");
    let startedAt = null, status = "running", failedNode = null, worktrees = [];

    // 1C-b:checkpoint 是权威状态来源(awaiting-approval 等)。
    const ck = readCheckpoint(runsRoot, ent.name);
    if (ck) {
      status = ck.status ?? "running";
      startedAt = ck.startedAt ?? null;
      failedNode = ck.stoppedAt?.node ?? null;
      worktrees = Array.isArray(ck.worktrees) ? ck.worktrees : [];
    }

    // 无 checkpoint(或缺 startedAt)→ 回落 1C-a 的 log 末行猜测。
    if (!ck || startedAt == null) {
      try {
        const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
        if (lines.length && lines[0]) {
          const first = JSON.parse(lines[0]);
          if (startedAt == null) startedAt = first.ts ?? null;
          if (!ck) {
            const last = JSON.parse(lines[lines.length - 1]);
            status = last.event === "step:failed" ? "failed"
              : last.event === "step:succeeded" || last.event === "session:close" ? "done"
              : "running";
          }
        }
      } catch { if (!ck) continue; }
    }
    runs.push({ runId: ent.name, startedAt, status, failedNode, worktrees });
  }
  runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return runs;
}

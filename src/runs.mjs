// synod/src/runs.mjs — 列举 ~/.synod/runs 下的 run(synod runs 用)。
// 基础版:runId / flow 名(从首个 step:started 的 node 不可靠,故读 run.log 头部
// 的 ts 与末行 event 判定状态)。1C-b 会在此基础上加 resume 可恢复性标注。
import fs from "node:fs";
import path from "node:path";

export function listRuns(runsRoot) {
  let names;
  try { names = fs.readdirSync(runsRoot, { withFileTypes: true }); }
  catch { return []; }
  const runs = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const logPath = path.join(runsRoot, ent.name, "run.log.jsonl");
    let startedAt = null, status = "running";
    try {
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      if (lines.length) {
        const first = JSON.parse(lines[0]); startedAt = first.ts ?? null;
        const last = JSON.parse(lines[lines.length - 1]);
        status = last.event === "step:failed" ? "failed"
          : last.event === "step:succeeded" || last.event === "session:close" ? "done"
          : "running";
      }
    } catch { continue; }    // 无 run.log → 跳过
    runs.push({ runId: ent.name, startedAt, status });
  }
  runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return runs;
}

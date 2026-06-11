// synod/src/flow/replay.mjs — run.log.jsonl 重放解析 + resume 准备(§4.12)。
//
// resume 的对账依据是 1C-a 的确定性 step key(`<seq>:<node>:<hash8>`)。本模块把
// run.log 解析成**有序的已完成 step**;runtime 的 replayStep 据此前缀匹配:第 i 个
// 原语调用与 steps[i] 比 node+hash,匹配则回放 steps[i].output(不开 agent),
// 第一个不匹配处起重放停用、全部真跑。
//
// 诚实限制:seq 在 1C-a 由 logStep 在调用完成时分配,顺序流下 = 调用序;并发流
// (Promise.all)下 = 完成序(不确定),故并发 run 的 resume 可能整段失配→真跑
// (不损坏,只是不省)。FLOW_AUTHORING「resume 与确定性」节向作者明示。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readCheckpoint } from "./checkpoint.mjs";

const LOG_FILE = "run.log.jsonl";

/**
 * 解析一个 run 目录的 run.log.jsonl。
 * @param {string} runDir 绝对路径 ~/.synod/runs/<runId>
 * @returns {Promise<{ steps: Array, sawFailure: boolean, failedNode: string|null }>}
 *   steps[i] = { key, node, type, hash, output, entry }
 */
export async function parseRunLog(runDir) {
  let text;
  try {
    text = await readFile(path.join(runDir, LOG_FILE), "utf8");
  } catch {
    return { steps: [], sawFailure: false, failedNode: null };
  }

  const started = new Map(); // stepId → started entry(占位,保序)
  const order = [];          // 按 succeeded 出现顺序的 stepId
  const succeeded = new Map(); // stepId → succeeded entry
  let sawFailure = false;
  let failedNode = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === "step:started") {
      started.set(e.stepId, e);
    } else if (e.event === "step:succeeded") {
      // 按 stepId 配对:仅收有对应 started、且未重复的 succeeded(孤立/重复行跳过)。
      if (started.has(e.stepId) && !succeeded.has(e.stepId)) {
        succeeded.set(e.stepId, e);
        order.push(e.stepId);
      }
    } else if (e.event === "step:failed") {
      sawFailure = true;
      if (failedNode === null) failedNode = e.node ?? null;
    }
    // session:* 行与本模块无关,忽略
  }

  const steps = [];
  for (const stepId of order) {
    const entry = succeeded.get(stepId);
    const hash = String(entry.key ?? "").split(":")[2] ?? "";
    let output = entry.output ?? null;
    if (output == null && entry.outputRef) {
      try { output = await readFile(entry.outputRef, "utf8"); }
      catch { output = null; }
    }
    steps.push({
      key: entry.key ?? null,
      node: entry.node,
      type: entry.type,
      hash,
      output,
      entry,
    });
  }
  return { steps, sawFailure, failedNode };
}

/**
 * 准备 resume:合并 checkpoint(flowName/input/cwd)与 run.log(steps)。
 * @returns {Promise<{ runId, flowName, input, cwd, steps, status }>}
 */
export async function prepareResume(runsRoot, runId) {
  const ckpt = readCheckpoint(runsRoot, runId);
  if (!ckpt || typeof ckpt.flowName !== "string" || !ckpt.flowName) {
    throw new Error(
      `resume: no checkpoint (or missing flowName) for run "${runId}" — nothing to resume`,
    );
  }
  const { steps } = await parseRunLog(path.join(runsRoot, runId));
  return {
    runId,
    flowName: ckpt.flowName,
    input: ckpt.input,
    cwd: ckpt.cwd,
    steps,
    status: ckpt.status ?? null,
  };
}

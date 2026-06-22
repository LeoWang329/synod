/**
 * workflows/execute-plan.mjs — subagent 驱动开发:逐 task backtrack(写→测→审→回退)。
 *
 * flow 名 = execute-plan。写之前读 docs/FLOW_AUTHORING.md。
 * parsePlan 内联并导出供单测(flow 文件只能 import synod/flow,故无法外置成 helper;
 * 测试不受 loader 约束,可直接 import 本文件测 parsePlan)。
 */
import { agent, bash, backtrack, approve } from "synod/flow";

export const meta = {
  description: "按 plan 逐 task 开发:deepseek 写 → npm test → deepseek 审 → 不过带反馈回退",
  // inputs: { planText, testCmd?, gates? }
};

const MODEL = "deepseek/deepseek-v4-pro";
const TASK_HEADER = /^#{2,3}\s+Task\s+(\S+?):\s*(.+?)\s*$/;

/**
 * parsePlan(planText) — 解析 plan 文本 → 有序 task 列表。
 * 识别 `### Task N: 标题` 或 `## Task N: 标题` 段头,段体 = 到下一个 Task 头前的文本。
 * 无 Task 头 / 空输入 → []。
 * @returns {Array<{id:string,title:string,body:string}>}
 */
export function parsePlan(planText) {
  const lines = String(planText ?? "").split("\n");
  const tasks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(TASK_HEADER);
    if (m) {
      if (cur) tasks.push(cur);
      cur = { id: m[1], title: m[2], body: "" };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  if (cur) tasks.push(cur);
  return tasks.map((t) => ({ ...t, body: t.body.trim() }));
}

export async function run(ctx, input) {
  const planText = typeof input === "string" ? input : (input?.planText ?? "");
  const testCmd = input?.testCmd ?? "npm test";
  const gates = input?.gates ?? "none";
  const tasks = parsePlan(planText);
  const completed = [];

  for (const task of tasks) {
    const result = await backtrack(ctx, {
      maxTurns: 3,
      initialPrompt:
        `实现下面这个 task,写出代码与必要测试:\n\n## Task ${task.id}: ${task.title}\n${task.body}`,
      produce: (ctx2, prompt) =>
        agent(ctx2, { agent: "omp", model: MODEL, write: true, workspace: "dev", prompt }),
      review: async (_code) => {
        const tested = await bash(ctx, testCmd);
        const verdict = await agent(ctx, {
          agent: "omp", model: MODEL, write: false,
          prompt:
            `审查刚完成的 task「${task.title}」。测试输出:\n` +
            `exit=${tested.code}\nstdout:\n${tested.stdout}\nstderr:\n${tested.stderr}\n\n` +
            `若实现正确且测试通过,只回一个词 APPROVE。否则第一行 REJECT,其后给具体修改点。`,
        });
        const passed = tested.code === 0 && /APPROVE/.test(verdict);
        return { passed, feedback: passed ? undefined : `测试 exit=${tested.code}\n${verdict}` };
      },
      buildPrompt: ({ feedback }) =>
        `上次未通过。反馈:\n${feedback}\n\n请据此修正 task「${task.title}」的实现与测试。`,
    });

    if (!result.passed) {
      return { done: false, failedTask: task.id, completed };   // 自动刹车:不往下合
    }
    completed.push(task.id);
    if (gates === "all") {
      await approve(ctx, { content: `Task ${task.id} (${task.title}) 验收。\n${result.output}` });
    }
  }

  return { done: true, completed };
}

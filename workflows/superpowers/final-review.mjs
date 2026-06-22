/**
 * workflows/final-review.mjs — deepseek 审全量 diff,有问题再让 deepseek 修(≤2 轮)。
 *
 * 审(write:false 只读)与改(write:true 写)是同一模型 deepseek 的两次不同调用:
 * backtrack 的 produce 每轮同一函数,不适合"先审、不过再改后复审",故用显式循环。
 * flow 名 = final-review。写之前读 docs/FLOW_AUTHORING.md。
 */
import { agent, bash } from "synod/flow";

export const meta = {
  description: "deepseek 审全量 diff,有问题带反馈让 deepseek 修",
  // inputs: { testCmd? }(暂未用,留扩展)
};

const MODEL = "deepseek/deepseek-v4-pro";

export async function run(ctx, _input) {
  let feedback = null;
  let verdict = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (feedback) {
      await agent(ctx, {
        agent: "omp", model: MODEL, write: true, workspace: "dev",
        prompt: `评审未通过,反馈:\n${feedback}\n\n请修正实现(写代码)。`,
      });
    }
    const diff = await bash(ctx, "git diff");
    verdict = await agent(ctx, {
      agent: "omp", model: MODEL, write: false,
      prompt:
        `审查下面的 diff。若整体正确、可合并,只回 APPROVE。否则第一行 REJECT,其后给修改点。\n\n` +
        `=== DIFF ===\n${diff.stdout}`,
    });
    if (/APPROVE/.test(verdict)) return { approved: true, report: verdict };
    feedback = verdict;
  }

  return { approved: false, report: verdict };
}

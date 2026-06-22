/**
 * workflows/final-review.mjs — codex 审全量 diff,有问题让 deepseek 修(≤2 轮)。
 *
 * 审者(codex,只读)≠ 改者(deepseek,写):backtrack 的 produce 每轮同一函数,
 * 不适合"先审、不过再让另一个角色改后复审",故用显式循环。
 * flow 名 = final-review。写之前读 docs/FLOW_AUTHORING.md。
 */
import { agent, bash } from "synod/flow";

export const meta = {
  description: "codex 审全量 diff,有问题带反馈让 deepseek 修",
  // inputs: { testCmd? }(暂未用,留扩展)
};

const WRITER_MODEL = "deepseek/deepseek-v4-pro";

export async function run(ctx, _input) {
  let feedback = null;
  let verdict = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (feedback) {
      await agent(ctx, {
        agent: "omp", model: WRITER_MODEL, write: true, workspace: "dev",
        prompt: `评审未通过,反馈:\n${feedback}\n\n请修正实现(写代码)。`,
      });
    }
    const diff = await bash(ctx, "git diff");
    verdict = await agent(ctx, {
      agent: "codex", write: false,
      prompt:
        `审查下面的 diff。若整体正确、可合并,只回 APPROVE。否则第一行 REJECT,其后给修改点。\n\n` +
        `=== DIFF ===\n${diff.stdout}`,
    });
    if (/APPROVE/.test(verdict)) return { approved: true, report: verdict };
    feedback = verdict;
  }

  return { approved: false, report: verdict };
}

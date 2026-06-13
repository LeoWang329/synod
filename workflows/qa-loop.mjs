/**
 * workflows/qa-loop.mjs — mimo 出题 → minimax 回答 → mimo 评审 的回退循环。
 *
 * 流程:
 *   1. mimo 就给定主题出一道有明确判定标准的问题。
 *   2. backtrack 循环(最多 3 轮):
 *        produce: minimax-m3 回答(首轮答原问题,后续带 mimo 反馈重答)。
 *        review:  mimo 评审该回答 → PASS / FAIL(+ 改进反馈)。
 *   3. PASS 即结束;3 轮仍 FAIL 则返回最后一次回答(passed:false)。
 * 模型经 omp 后端以 `--model` 调用(provider 限定串)。
 *
 * reuse:true 复用会话上下文(同一 agent:model 对共享 thread 历史)——
 * mimo 的出题与评审在同一个会话 history 里运行(对本 flow 可接受,甚至有益)。
 * 冷启动从 3–7 次降到 2 次:mimo 一条 session,minimax 一条 session。
 */
import { agent, backtrack } from "synod/flow";

const MIMO = "xiaomi-token-plan-cn/mimo-v2.5-pro";
const MINIMAX = "minimax-code-cn/MiniMax-M3";

export const meta = {
  description: "mimo 出题 → minimax 回答 → mimo 评审,失败带反馈重答(≤3 轮)",
};

export async function run(ctx, input) {
  const topic = typeof input === "string" ? input : (input?.topic ?? "编程");

  // 1) mimo 出题
  const question = (await agent(ctx, {
    agent: "omp",
    model: MIMO,
    reuse: true,
    prompt:
      `请就「${topic}」出一道简短、清晰、有明确判定标准的问题。` +
      `只输出问题本身,不要解释,不要附答案。`,
  })).trim();

  // 2) minimax 回答 + mimo 评审 的回退循环
  const result = await backtrack(ctx, {
    initialPrompt: `请回答下面这个问题,简明扼要:\n\n${question}`,
    maxTurns: 3,

    // minimax-m3 回答
    produce: (ctx, prompt) =>
      agent(ctx, { agent: "omp", model: MINIMAX, prompt, reuse: true }),

    // mimo 评审 → { passed, feedback }
    review: async (answer) => {
      const verdict = (await agent(ctx, {
        agent: "omp",
        model: MIMO,
        reuse: true,
        prompt:
          `你是严格的评审。问题:\n${question}\n\n候选回答:\n${answer}\n\n` +
          `若回答正确、切题、完整,只回一个词 PASS。` +
          `否则第一行回 FAIL,第二行起给出需要改进的具体反馈。`,
      })).trim();

      const passed = verdict.toUpperCase().startsWith("PASS");
      return { passed, feedback: passed ? undefined : verdict };
    },

    // 失败:带 mimo 反馈让 minimax 重答
    buildPrompt: ({ attempt, feedback }) =>
      `这是第 ${attempt} 次尝试,你上次的回答未通过评审。\n` +
      `评审反馈:\n${feedback}\n\n` +
      `请据此改进,重新回答下面的问题,简明扼要:\n\n${question}`,
  });

  return {
    topic,
    question,
    answer: result.output,
    passed: result.passed,
    attempts: result.attempts,
  };
}

/**
 * workflows/backtrack-demo.mjs — FA3: Backtrack flow with real codex review.
 *
 * Uses `backtrack()` to produce output with omp, then has codex review it.
 * Retries up to maxTurns if codex finds issues.
 */
import { agent, backtrack } from "synod/flow";

export const meta = {
  description: "Backtrack: produce with omp, review with codex, retry on fail",
};

export async function run(ctx, input) {
  const topic = typeof input === "string" ? input : (input?.topic ?? "programming");

  const result = await backtrack(ctx, {
    initialPrompt: `Write exactly ONE sentence about ${topic}. Keep it short.`,
    produce: async (ctx, prompt) => agent(ctx, { agent: "omp", prompt }),
    review: async (output) => {
      const reviewText = await agent(ctx, {
        agent: "codex",
        prompt: `You are a strict reviewer. Check this output:\n\n"${output}"\n\nReply with EXACTLY one word: PASS if the output is a single clear sentence about ${topic}, or FAIL if not.`,
      });
      const passed = reviewText.trim().toUpperCase().startsWith("PASS");
      return { passed, feedback: passed ? undefined : reviewText };
    },
    buildPrompt: ({ attempt, feedback }) =>
      `Previous output had issues: ${feedback}\n\nWrite exactly ONE sentence about ${topic}. Keep it short.`,
    maxTurns: 2,
  });

  return result;
}

/**
 * workflows/hello.mjs — FA2: Simple linear flow calling a real omp agent.
 *
 * Used by the acceptance test to verify that the flow engine can
 * run a real agent end-to-end and produce output.
 */
import { agent } from "synod/flow";

export const meta = {
  description: "Simple linear: call omp, return response",
};

export async function run(ctx, input) {
  const prompt = typeof input === "string" ? input : (input?.prompt ?? "Say hello in exactly one sentence.");
  // model 经 SYNOD_FLOW_MODEL 注入(e2e 在 minimax 余额不足时切 deepseek);未设则用 omp 默认。
  const result = await agent(ctx, { agent: "omp", model: process.env.SYNOD_FLOW_MODEL || undefined, prompt });
  return { response: result };
}

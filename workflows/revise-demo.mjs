/**
 * workflows/revise-demo.mjs — FA4: reviseWithHuman end-to-end.
 *
 * Uses `reviseWithHuman()` to present a draft, accept human feedback,
 * revise via omp, and loop until accepted.
 */
import { agent, reviseWithHuman } from "synod/flow";

export const meta = {
  description: "Revise with human: draft → feedback → accept",
};

export async function run(ctx, input) {
  const draft = typeof input === "string" ? input : (input?.draft ?? "The sky is blue.");

  // model 经 SYNOD_FLOW_MODEL 注入(minimax 余额不足时切 deepseek);reviseWithHuman 透传给内部 agent()。
  const result = await reviseWithHuman(ctx, draft, { agent: "omp", model: process.env.SYNOD_FLOW_MODEL || undefined });

  return { final: result };
}

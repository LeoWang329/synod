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

  const result = await reviseWithHuman(ctx, draft, { agent: "omp" });

  return { final: result };
}

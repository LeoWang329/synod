// Sibling flow A — used for concurrent active sub-run tests
import { agent } from "synod/flow";

export const meta = {
  description: "Sibling A for concurrent sub-run tests",
};

export async function run(ctx, input) {
  const reply = await agent(ctx, {
    agent: "omp",
    model: "m",
    prompt: `sibling-a: ${input.label ?? "x"}`,
  });
  return { from: "a", reply, childRunId: ctx.runId };
}

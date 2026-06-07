// Sibling flow B — used for concurrent active sub-run tests
import { agent } from "synod/flow";

export const meta = {
  description: "Sibling B for concurrent sub-run tests",
};

export async function run(ctx, input) {
  const reply = await agent(ctx, {
    agent: "omp",
    model: "m",
    prompt: `sibling-b: ${input.label ?? "y"}`,
  });
  return { from: "b", reply, childRunId: ctx.runId };
}

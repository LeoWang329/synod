// Child flow: echoes input back with a prefix
import { agent } from "synod/flow";

export const meta = {
  description: "Child flow that echoes input via agent",
};

export async function run(ctx, input) {
  const reply = await agent(ctx, {
    agent: "omp",
    model: "m",
    prompt: `echo: ${input.message ?? "default"}`,
  });
  return { echoed: reply, childRunId: ctx.runId };
}

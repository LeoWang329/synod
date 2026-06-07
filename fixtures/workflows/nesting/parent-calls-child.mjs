// Parent flow: calls a child flow via runWorkflow and uses its return value
import { agent, runWorkflow } from "synod/flow";

export const meta = {
  description: "Parent that calls child-echo and uses the return value",
};

export async function run(ctx, input) {
  const childResult = await runWorkflow(ctx, "./child-echo", {
    message: input.message ?? "hello",
  });

  // Use the child's return value in the parent
  const summary = await agent(ctx, {
    agent: "codex",
    model: "m2",
    prompt: `summarize: ${childResult.echoed}`,
  });

  return { summary, childEchoed: childResult.echoed };
}

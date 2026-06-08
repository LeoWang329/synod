// Child flow: runs a bash command and returns result
import { bash } from "synod/flow";

export const meta = {
  description: "Child flow that runs bash",
};

export async function run(ctx, input) {
  const result = await bash(ctx, input.cmd ?? "echo ok");
  return { result, childRunId: ctx.runId };
}

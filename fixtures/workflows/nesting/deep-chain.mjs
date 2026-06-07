// Deep chain: calls itself recursively to test depth guard
import { runWorkflow } from "synod/flow";

export const meta = {
  description: "Recursive flow that calls itself to test depth limits",
};

export async function run(ctx, input) {
  const depth = ctx.depth ?? 0;
  if (depth >= (input.maxDepth ?? 5)) {
    return { reached: "bottom", depth };
  }
  // Call self to go deeper
  const deeper = await runWorkflow(ctx, "./deep-chain", {
    maxDepth: input.maxDepth ?? 5,
  });
  return { depth, child: deeper };
}

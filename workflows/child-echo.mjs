/**
 * workflows/child-echo.mjs — FA5: Child flow called by parent.
 *
 * Simple child that echoes input via omp.
 */
import { agent } from "synod/flow";

export const meta = {
  description: "Child: echo input via omp",
};

export async function run(ctx, input) {
  const msg = typeof input === "string" ? input : JSON.stringify(input);
  const result = await agent(ctx, { agent: "omp", prompt: `Repeat exactly this message: "${msg}"` });
  return { echoed: result, received: input };
}

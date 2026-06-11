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
  // model 经 SYNOD_FLOW_MODEL 注入(e2e 在 minimax 余额不足时切 deepseek);未设则用 omp 默认。
  const result = await agent(ctx, { agent: "omp", model: process.env.SYNOD_FLOW_MODEL || undefined, prompt: `Repeat exactly this message: "${msg}"` });
  return { echoed: result, received: input };
}

// test/_fixtures/workflows/linear.mjs
// A simple 3-node linear flow: agent → bash → agent
import { agent, bash } from "synod/flow";

export const meta = {
  description: "Linear 3-node: agent → bash → agent",
};

export async function run(ctx, input) {
  const a = await agent(ctx, { agent: "omp", model: "m", prompt: "step 1" });
  const b = await bash(ctx, "node -e 'process.stdout.write(\"ok\")'");
  const c = await agent(ctx, { agent: "codex", model: "m2", prompt: "step 3" });
  return { a, b, c };
}

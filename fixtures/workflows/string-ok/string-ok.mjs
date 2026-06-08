// fixtures/workflows/string-ok/string-ok.mjs
// Bad import appears ONLY inside a template literal (prompt) —
// the state-machine scanner must skip template content and NOT reject.
import { agent } from "synod/flow";

export const meta = {
  description: "Bad import inside a template literal prompt — must not be rejected",
};

export async function run(ctx, input) {
  const prompt = `Here is an example:
  \`\`\`
  import { readFile } from "node:fs/promises";
  \`\`\``;
  const result = await agent(ctx, { agent: "omp", model: "m", prompt });
  return result;
}

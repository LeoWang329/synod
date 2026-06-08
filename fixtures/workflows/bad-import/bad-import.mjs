// test/_fixtures/workflows/bad-import.mjs
// Imports fs — should be rejected by AST lint.
import { readFile } from "node:fs/promises";

export const meta = {
  description: "This flow imports fs and should be rejected",
};

export async function run(_ctx, _input) {
  return "bad";
}

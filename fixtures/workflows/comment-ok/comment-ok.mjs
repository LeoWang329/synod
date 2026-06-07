// fixtures/workflows/comment-ok/comment-ok.mjs
// This flow has a bad import ONLY inside a comment — the linter
// should strip the comment and NOT reject this flow.
//
// Example: import { readFile } from "node:fs/promises"
import { agent } from "synod/flow";

export const meta = {
  description: "Comment-only bad import — must not be rejected",
};

export async function run(_ctx, _input) {
  return "ok";
}

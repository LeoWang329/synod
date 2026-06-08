// fixtures/workflows/from-comment-bad/from-comment-bad.mjs
// Named import with a block comment between `from` and the specifier.
// skipTrivia must handle this.
import { readFile } from /* c */ "node:fs/promises";

export const meta = {
  description: "from-comment before specifier — must be rejected",
};

export async function run(_ctx, _input) {
  return "bad";
}

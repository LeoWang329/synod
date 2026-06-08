// fixtures/workflows/import-comment-bad/import-comment-bad.mjs
// Side-effect import with a block comment before the specifier.
// skipTrivia must handle this.
import /* comment */ "node:fs/promises";

export const meta = {
  description: "Import with comment before specifier — must be rejected",
};

export async function run(_ctx, _input) {
  return "bad";
}

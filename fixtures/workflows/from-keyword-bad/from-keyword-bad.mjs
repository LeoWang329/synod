// fixtures/workflows/from-keyword-bad/from-keyword-bad.mjs
// `from` used as an import binding name — the scanner must NOT stop
// at this first `from` but continue to the real one at depth 0.
import { from as f } from "node:fs/promises";

export const meta = {
  description: "from keyword as binding name — must still reject the real import",
};

export async function run(_ctx, _input) {
  return "bad";
}

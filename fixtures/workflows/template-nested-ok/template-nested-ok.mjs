// fixtures/workflows/template-nested-ok/template-nested-ok.mjs
// Nested template literal with a bad import inside ${…} expression —
// the scanner must track brace depth in template expressions and NOT
// falsely flag this as a static import.
const s = `x ${`import y from "node:fs"`} z`;

import { agent } from "synod/flow";

export const meta = {
  description: "Nested template with bad import in ${} — must not be rejected",
};

export async function run(_ctx, _input) {
  void s;
  return "ok";
}

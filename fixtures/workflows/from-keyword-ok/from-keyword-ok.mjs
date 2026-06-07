// fixtures/workflows/from-keyword-ok/from-keyword-ok.mjs
// `from` used as a binding name — but the REAL specifier is synod/flow,
// so this must be accepted.
import { agent as from } from "synod/flow";

export const meta = {
  description: "from as binding name but specifier is synod/flow — must be accepted",
};

export async function run(_ctx, _input) {
  void from;
  return "ok";
}

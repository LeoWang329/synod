// fixtures/workflows/export-local-then-ok/export-local-then-ok.mjs
// Local export followed by a valid synod/flow import — must be accepted.
export { run as flowMain };
import { agent } from "synod/flow";

export const meta = {
  description: "Local export then valid synod/flow import — must be accepted",
};

export async function run(_ctx, _input) {
  return "ok";
}

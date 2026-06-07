// fixtures/workflows/export-local-then-bad/export-local-then-bad.mjs
// Local export followed by a bad import — extractExportSpec must stop
// at the end of the local export statement so the bad import below is
// caught by the main loop.
export { run };
import "node:fs/promises";

export const meta = {
  description: "Local export then bad import — must reject the bad import",
};

export async function run(_ctx, _input) {
  return "bad";
}

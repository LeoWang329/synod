// fixtures/workflows/compact-bad/compact-bad.mjs
// Compact import of a disallowed module — MUST be rejected.
import{readFile}from"node:fs/promises";

export const meta = {
  description: "Compact bad import — should be rejected",
};

export async function run(_ctx, _input) {
  return "bad";
}

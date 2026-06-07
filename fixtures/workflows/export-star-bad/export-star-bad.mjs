// fixtures/workflows/export-star-bad/export-star-bad.mjs
// Static re-export of a non-synod/flow module — must be rejected.
export * from "node:fs/promises";

// Also need to export meta/run so the module loads (for discovery test
// to reach the lint check)
export const meta = {
  description: "export * from bad module — must be rejected",
};

export async function run(_ctx, _input) {
  return "bad";
}

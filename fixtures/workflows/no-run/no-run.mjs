// test/_fixtures/workflows/no-run.mjs
// Missing run export — should be rejected by loader.
export const meta = {
  description: "This flow has no run function",
};

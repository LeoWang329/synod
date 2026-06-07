// fixtures/workflows/dynamic-ok/dynamic-ok.mjs
// Dynamic import — NOT a sandbox boundary, linter must NOT reject.
import { agent } from "synod/flow";

export const meta = {
  description: "Dynamic import — must NOT be rejected by static lint",
};

export async function run(_ctx, _input) {
  // Dynamic import is intentionally not blocked by the static lint
  const fs = await import("node:fs/promises");
  void fs;
  return "ok";
}

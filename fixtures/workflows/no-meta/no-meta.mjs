// test/_fixtures/workflows/no-meta.mjs
// Missing meta.description — should be rejected by loader.
export const meta = {
  // no description
};

export async function run(_ctx, _input) {
  return "ok";
}

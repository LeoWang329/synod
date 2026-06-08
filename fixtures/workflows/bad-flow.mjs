// fixtures/workflows/bad-flow.mjs
// Deliberately broken file — causes discoverFlows() to throw during import.
// Used to test the fallback: discoverFlows throws → loadFlow still succeeds
// for valid flows in subdirectories.
export const meta = {
  description: "Intentionally broken flow for testing",
};
// Syntax error below: missing closing brace
export async function run(ctx, input) {
  return { ok: true };
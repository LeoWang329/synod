/**
 * fixtures/workflows/valid/echo-input.mjs — Fixture for input parsing tests.
 *
 * Returns the received input plus type metadata so unit tests can assert
 * that JSON input was parsed to an object, raw strings stay as strings, etc.
 */
export const meta = {
  description: "Echo-input: returns input with type metadata",
};

export async function run(ctx, input) {
  return {
    input,
    type: typeof input,
    isArray: Array.isArray(input),
    isNull: input === null,
  };
}

/**
 * backtrack — cross-node retry loop that feeds review feedback back to
 * the produce step, so the agent can target what was wrong instead of
 * blindly retrying.
 *
 * ## Signature
 *
 *   backtrack(ctx, {
 *     produce,       // async (ctx, prompt: string) => output
 *     review,        // async (output) => { passed: boolean, feedback?: string }
 *     buildPrompt,   // ({ attempt: number, feedback?: string }) => string
 *     initialPrompt, // string
 *     maxTurns,      // number (default 5)
 *   }) → { output, passed: boolean, attempts: number }
 *
 * ## How it works
 *
 *   1. produce(ctx, initialPrompt) → output
 *   2. review(output) → { passed, feedback }
 *   3. If !passed and attempts < maxTurns:
 *        buildPrompt({ attempt, feedback }) → next prompt
 *        produce(ctx, nextPrompt) → …
 *   4. Loop until passed or maxTurns exhausted.
 *
 * `produce` and `review` are callbacks so the caller controls what
 * primitives they delegate to (agent, bash, approve, etc.).
 *
 * `buildPrompt` receives the attempt number (1-indexed) and the
 * previous review's feedback string, so the next prompt can include
 * specific instructions about what to fix.
 *
 * @param {object} ctx  – pure-data context (passed through to produce)
 * @param {object} opts
 * @param {(ctx: object, prompt: string) => Promise<*>} opts.produce
 * @param {(output: *) => Promise<{passed: boolean, feedback?: string}>} opts.review
 * @param {(info: {attempt: number, feedback?: string}) => string} opts.buildPrompt
 * @param {string} opts.initialPrompt
 * @param {number} [opts.maxTurns=5]
 * @returns {Promise<{output: *, passed: boolean, attempts: number}>}
 */
export async function backtrack(ctx, {
  produce,
  review,
  buildPrompt,
  initialPrompt,
  maxTurns = 5,
}) {
  if (typeof produce !== "function") {
    throw new Error("backtrack: produce must be a function");
  }
  if (typeof review !== "function") {
    throw new Error("backtrack: review must be a function");
  }
  if (typeof buildPrompt !== "function") {
    throw new Error("backtrack: buildPrompt must be a function");
  }
  if (typeof initialPrompt !== "string" || !initialPrompt) {
    throw new Error("backtrack: initialPrompt is required (non-empty string)");
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("backtrack: maxTurns must be a positive integer");
  }

  let attempt = 0;
  let feedback;
  let lastOutput;

  while (attempt < maxTurns) {
    attempt++;

    const prompt =
      attempt === 1
        ? initialPrompt
        : buildPrompt({ attempt, feedback });

    lastOutput = await produce(ctx, prompt);

    const result = await review(lastOutput);

    if (result.passed) {
      return { output: lastOutput, passed: true, attempts: attempt };
    }

    feedback = result.feedback;
  }

  return { output: lastOutput, passed: false, attempts: attempt };
}

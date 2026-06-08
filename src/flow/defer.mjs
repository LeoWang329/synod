/**
 * createDeferScope — factory for a LIFO cleanup scope.
 *
 * Usage:
 *
 *   const scope = createDeferScope();
 *   scope.defer(() => cleanup1());
 *   scope.defer(() => cleanup2());
 *   await scope.run(async () => {
 *     // … work …
 *   });
 *   // → cleanup2() then cleanup1() execute in LIFO order
 *
 * ## Error semantics
 *
 * - If `fn` throws, all registered defer callbacks still run (LIFO),
 *   then the original error is re-thrown.
 * - If a defer callback itself throws, remaining defers still run.
 *   After all defers execute, the first defer error is re-thrown
 *   (or the original `fn` error, if any).
 * - If BOTH `fn` and at least one defer throw, the `fn` error takes
 *   precedence (it's the root cause), and defer errors are attached
 *   as `.suppressed` (when the runtime supports `Error.cause`).
 *
 * `dispose()` runs remaining defers without a work function — useful
 * when the scope outlives the `run()` call.
 */

/**
 * @returns {{
 *   defer: (fn: () => void | Promise<void>) => void,
 *   run: <T>(fn: () => T | Promise<T>) => Promise<T>,
 *   dispose: () => Promise<void>,
 * }}
 */
export function createDeferScope() {
  /** @type {Array<() => void | Promise<void>>} */
  const stack = [];

  /**
   * Register a cleanup callback.  Callbacks execute in LIFO order
   * when `run()` finishes or `dispose()` is called.
   */
  function defer(fn) {
    stack.push(fn);
  }

  /**
   * Execute all registered defers in LIFO order, swallowing individual
   * errors so remaining defers still run.  Returns the first error
   * encountered, or null.
   */
  async function _drain() {
    let firstErr = null;
    while (stack.length > 0) {
      const fn = stack.pop();
      try {
        await fn();
      } catch (err) {
        firstErr = firstErr ?? err;
      }
    }
    return firstErr;
  }

  /**
   * Run `fn`, then execute all registered defers in LIFO order.
   *
   * - On success: runs defers, returns fn's result.
   * - On `fn` error: runs defers, then re-throws the fn error
   *   (with any defer error attached as `.suppressed` when possible).
   */
  async function run(fn) {
    let result;
    let fnErr = null;
    try {
      result = await fn();
    } catch (err) {
      fnErr = err;
    }

    const deferErr = await _drain();

    if (fnErr) {
      if (deferErr && Error.cause !== undefined) {
        // Attach the first defer error as suppressed metadata.
        // Error.cause is writable in Node 20+.
        try {
          fnErr.suppressed = deferErr;
        } catch {
          // If .suppressed is read-only (rare), just drop it.
        }
      }
      throw fnErr;
    }

    if (deferErr) throw deferErr;

    return result;
  }

  /**
   * Execute remaining defers without a work function.
   * The first defer error is re-thrown; remaining defers still run.
   */
  async function dispose() {
    const err = await _drain();
    if (err) throw err;
  }

  return { defer, run, dispose };
}

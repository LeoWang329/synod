import { runWithRuntime } from "./current-run.mjs";

/**
 * runFlow(runtime, flowModule, ctx, input)
 *
 * Execute a loaded flow module within the given runtime context.
 * Uses AsyncLocalStorage so nested and concurrent runFlow() calls
 * each see their own runtime — ALS exit automatically restores the
 * parent context.
 *
 * @param {object} runtime     – the DI container (createRuntime return)
 * @param {object} flowModule  – { run: Function, meta: object, name: string }
 * @param {object} ctx         – pure-data context
 * @param {*}      input       – flow input
 * @returns {Promise<*>} the flow's return value
 */
export async function runFlow(runtime, flowModule, ctx, input) {
  return runWithRuntime(runtime, async () => {
    try {
      return await flowModule.run(ctx, input);
    } finally {
      await runtime.disposeRun?.(ctx);
    }
  });
}

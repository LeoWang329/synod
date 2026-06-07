import { setCurrentRuntime, getCurrentRuntimeRaw } from "./current-run.mjs";

/**
 * runFlow(runtime, flowModule, ctx, input)
 *
 * Execute a loaded flow module within the given runtime context.
 * Saves and restores the previous runtime so nested runFlow() calls
 * work correctly.
 *
 * @param {object} runtime     – the DI container (createRuntime return)
 * @param {object} flowModule  – { run: Function, meta: object, name: string }
 * @param {object} ctx         – pure-data context
 * @param {*}      input       – flow input
 * @returns {Promise<*>} the flow's return value
 */
export async function runFlow(runtime, flowModule, ctx, input) {
  const prev = getCurrentRuntimeRaw();
  setCurrentRuntime(runtime);
  try {
    return await flowModule.run(ctx, input);
  } finally {
    try {
      await runtime.disposeRun?.(ctx);
    } finally {
      // Always restore, even if disposeRun threw
      setCurrentRuntime(prev);
    }
  }
}

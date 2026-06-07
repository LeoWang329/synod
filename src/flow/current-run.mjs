/**
 * Module-level current-run context for flow primitives.
 *
 * Flows import from 'synod/flow', which delegates to the runtime set
 * here by the runner.  This keeps ctx pure (no live objects) while
 * letting primitives access injected dependencies.
 *
 * IMPORTANT: this is a module-level singleton — it only supports
 * sequential, single-run execution.  Nested runFlow() works via
 * save/restore of the previous runtime.  Concurrent flows would need
 * AsyncLocalStorage (out of scope for now).
 */

let _currentRuntime = null;

/** Set the active runtime for the current run (called by runner). */
export function setCurrentRuntime(rt) {
  _currentRuntime = rt;
}

/**
 * Get the active runtime (called by primitive proxies in index.mjs).
 * Throws if no runtime is active.
 */
export function getCurrentRuntime() {
  if (!_currentRuntime) {
    throw new Error(
      "No active flow runtime — primitives must be called inside run()",
    );
  }
  return _currentRuntime;
}

/**
 * Get the active runtime without throwing.  Returns null when no
 * runtime is active (used by runFlow for save/restore).
 */
export function getCurrentRuntimeRaw() {
  return _currentRuntime;
}

/**
 * synod/flow — public API for flow files.
 *
 * Every export is a proxy that delegates to the current runtime
 * (set by the runner via setCurrentRuntime).  Flows never touch
 * the runtime directly; ctx remains pure data.
 */
import { getCurrentRuntime } from "./current-run.mjs";

export function agent(ctx, opts) {
  return getCurrentRuntime().agent(ctx, opts);
}

export function bash(ctx, cmd, opts) {
  return getCurrentRuntime().bash(ctx, cmd, opts);
}

export function approve(ctx, opts) {
  return getCurrentRuntime().approve(ctx, opts);
}

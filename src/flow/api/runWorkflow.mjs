import { loadFlow } from "../loader.mjs";
import { runFlow } from "../runner.mjs";
import { createCtx } from "../ctx.mjs";

/**
 * Default maximum nesting depth for child workflow calls.
 * A parent at depth 0 can nest down to depth `maxDepth` (inclusive).
 * E.g. with maxDepth=5: root→child1→child2→child3→child4→child5 is allowed,
 * but child5→child6 is rejected.
 */
export const DEFAULT_MAX_DEPTH = 5;

/**
 * Default maximum number of concurrently active child sub-runs.
 * AsyncLocalStorage 落地后,同一 parent 的多个 runWorkflow
 * 可真正并发,故默认不再限流(Infinity)。maxDepth 仍是递归深度护栏(默认 5);
 * 需要限流的 flow 可显式传 maxActiveSubRuns。
 */
export const DEFAULT_MAX_ACTIVE_SUB_RUNS = Infinity;

/**
 * Create the `runWorkflow` primitive bound to a runtime.
 *
 * Uses a lazy `getRuntime` accessor to avoid circular dependency:
 * the runtime object includes `runWorkflow`, so we can't pass it
 * directly at construction time.
 *
 * @param {object} opts
 * @param {string} opts.workflowsRoot    – absolute path to workflows directory
 * @param {number} [opts.maxDepth]       – max nesting depth (default 5)
 * @param {number} [opts.maxActiveSubRuns] – max concurrent child runs (default Infinity)
 * @param {Function} opts.getRuntime     – () => runtime DI container
 * @returns {Function} runWorkflow(ctx, childRef, input)
 */
export function createRunWorkflow({
  workflowsRoot,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxActiveSubRuns = DEFAULT_MAX_ACTIVE_SUB_RUNS,
  getRuntime,
}) {
  /**
   * Per-parent-run counter of active direct children.
   * Key = parent ctx.runId, value = count of active children.
   * This allows nested children (grandchildren) to run without
   * conflicting with their parent's own child limit.
   */
  const _activeByParent = new Map();

  /**
   * runWorkflow(ctx, childRef, input) — load and execute a child flow.
   *
   * @param {object} ctx       – parent flow's context
   * @param {string} childRef  – flow reference, relative to workflowsRoot (e.g. "./child")
   * @param {*}      input     – input passed to the child flow
   * @returns {Promise<*>} the child flow's return value
   */
  async function runWorkflow(ctx, childRef, input) {
    // ── Guard: max nesting depth ──────────────────────────────────
    const parentDepth = ctx.depth ?? 0;
    const childDepth = parentDepth + 1;
    if (childDepth > maxDepth) {
      throw new Error(
        `runWorkflow: max nesting depth exceeded (${childDepth} > ${maxDepth}). ` +
        `Parent flow "${ctx.runId}" at depth ${parentDepth} cannot spawn further children.`,
      );
    }

    // ── Guard + reserve: max active sub-runs for THIS parent ──────
    // Reserve the slot BEFORE any await (loadFlow) to close the
    // race window between check and increment.
    const current = _activeByParent.get(ctx.runId) ?? 0;
    if (current >= maxActiveSubRuns) {
      throw new Error(
        `runWorkflow: max active sub-runs reached (${maxActiveSubRuns}) for parent "${ctx.runId}". ` +
        `Only ${maxActiveSubRuns} direct child flow(s) can run concurrently per parent. ` +
        `Wait for active children to complete before starting a new one.`,
      );
    }
    _activeByParent.set(ctx.runId, current + 1);

    try {
      // ── Load child flow ─────────────────────────────────────────
      const childModule = await loadFlow(workflowsRoot, childRef);

      // ── Create child context (inherit parent cwd) ───────────────
      const childCtx = createCtx({
        cwd: ctx.cwd,
        parentRunId: ctx.runId,
        depth: childDepth,
        input,
      });

      // ── Execute child flow ──────────────────────────────────────
      return await runFlow(getRuntime(), childModule, childCtx, input);
    } finally {
      const after = (_activeByParent.get(ctx.runId) ?? 1) - 1;
      if (after <= 0) {
        _activeByParent.delete(ctx.runId);
      } else {
        _activeByParent.set(ctx.runId, after);
      }
    }
  }

  return runWorkflow;
}

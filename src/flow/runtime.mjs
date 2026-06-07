import { createCtx } from "./ctx.mjs";
import { createLogger } from "./logger.mjs";
import { createAgent } from "./api/agent.mjs";
import { createBash } from "./api/bash.mjs";
import { openBackend as realOpenBackend } from "../backend.mjs";

/**
 * createRuntime — DI container for the flow engine.
 *
 * Accepts injectable dependencies so every subsystem (ctx, logger,
 * primitives) can be tested with fakes.
 *
 *   deps.fs          – filesystem sink  (test: memory sink)
 *   deps.clock       – time source      (test: fixed clock)
 *   deps.openBackend – backend factory  (default: real openBackend)
 *   deps.io          – stdin/stdout     (placeholder for F3)
 *
 * Returns { createCtx, agent, disposeRun, logger, fs, clock, openBackend, io }.
 *
 * Live run-state (reused sessions) is held in a per-run Map keyed by
 * ctx.runId — never stored on the pure-data ctx itself.
 */
export function createRuntime({ fs, clock, openBackend, io } = {}) {
  const logger = createLogger({ fs, clock });
  const resolvedOpenBackend = openBackend ?? realOpenBackend;

  /** @type {Map<string, { reusedSessions: Map<string, object> }>} */
  const _runs = new Map();

  function getRunState(runId) {
    let rs = _runs.get(runId);
    if (!rs) {
      rs = { reusedSessions: new Map() };
      _runs.set(runId, rs);
    }
    return rs;
  }

  function removeReusedSession(runId, key) {
    const rs = _runs.get(runId);
    if (rs) rs.reusedSessions.delete(key);
  }

  const agent = createAgent({
    openBackend: resolvedOpenBackend,
    logger,
    getRunState,
    removeReusedSession,
  });

  const bash = createBash({ logger });

  /**
   * disposeRun(ctx) — close all reused sessions and clean up run-state.
   *
   * Must be called when a run completes.  Idempotent (safe to call
   * multiple times for the same run).
   */
  async function disposeRun(ctx) {
    const rs = _runs.get(ctx.runId);
    if (!rs) return;
    try {
      for (const [, entry] of rs.reusedSessions) {
        entry.session.close();
        await logger.logSession(ctx, {
          event: "session:close",
          sessionId: entry.sessionId,
          agent: entry.agent,
          model: entry.model,
          reused: true,
        }).catch(() => {});
      }
    } finally {
      _runs.delete(ctx.runId);
    }
  }

  return {
    /**
     * createCtx(input) — produce a pure-data context for a single run.
     */
    createCtx(input) {
      return createCtx({ input });
    },
    /** agent() primitive — call a backend, return text. */
    agent,
    /** bash() primitive — run a shell command. */
    bash,
    /** disposeRun(ctx) — close reused sessions for a run. */
    disposeRun,
    /** Logger instance bound to the injected sinks. */
    logger,
    /** Filesystem sink (injected or undefined). */
    fs,
    /** Time source (injected or undefined). */
    clock,
    /** Backend factory — injected sentinel or the real openBackend. */
    openBackend: resolvedOpenBackend,
    /** I/O interface — injected sentinel or undefined (placeholder for F3). */
    io,
  };
}

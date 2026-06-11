import { createInterface } from "node:readline";
import { createCtx } from "./ctx.mjs";
import { createApprove } from "./api/approve.mjs";
import { createLogger } from "./logger.mjs";
import { createAgent } from "./api/agent.mjs";
import { createAgentLoop } from "./api/agentLoop.mjs";
import { backtrack } from "./api/backtrack.mjs";
import { createDeferScope } from "./defer.mjs";
import { createBash } from "./api/bash.mjs";
import { createReviseWithHuman } from "./api/reviseWithHuman.mjs";
import { createRunWorkflow } from "./api/runWorkflow.mjs";
import { openBackend as realOpenBackend } from "../backend.mjs";

/**
 * makeQuestion(input, output) — factory for a single-owner `question()`
 * backed by a shared (lazy) `readline.Interface` on `input`.
 *
 * The returned `question(prompt, { signal })` method enforces **stdin
 * single-ownership**: only one question may be pending at a time.
 * A concurrent call throws synchronously `"a question is already pending"`.
 *
 * This is the canonical implementation — both `defaultIo()` and the
 * smoke tests construct their io through this factory to avoid
 * mock-vs-real divergence.
 */
export function makeQuestion(input, output) {
  let _rl = null;
  let _pending = false;

  function getRl() {
    if (!_rl) _rl = createInterface({ input, terminal: false });
    return _rl;
  }

  function question(prompt, { signal } = {}) {
    if (_pending) {
      throw new Error("a question is already pending");
    }
    _pending = true;
    if (prompt != null) output.write(String(prompt));

    const rl = getRl();

    return new Promise((resolve, reject) => {
      const onLine = (line) => {
        cleanup();
        resolve(line);
      };
      const onAbort = () => {
        cleanup();
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      };
      const cleanup = () => {
        _pending = false;
        rl.removeListener("line", onLine);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      rl.once("line", onLine);
      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  return { question };
}

/**
 * Build the default I/O interface backed by real process stdio.
 *
 * Uses `makeQuestion(process.stdin, process.stdout)` so the single-
 * pending guard is enforced on the real path, not just in mocks.
 * The underlying readline is created lazily on first question().
 */
function defaultIo() {
  const { question } = makeQuestion(process.stdin, process.stdout);
  return {
    stdout: process.stdout,
    stdin: process.stdin,
    question,
  };
}
/**
 * createRuntime — DI container for the flow engine.
 *
 * Accepts injectable dependencies so every subsystem (ctx, logger,
 * primitives) can be tested with fakes.
 *
 *   deps.fs              – filesystem sink    (test: memory sink)
 *   deps.clock           – time source        (test: fixed clock)
 *   deps.openBackend     – backend factory    (default: real openBackend)
 *   deps.io              – stdin/stdout       (default: real process stdio
 *                           with a shared lazy readline for question())
 *   deps.workflowsRoot   – absolute path to workflows directory (required
 *                           for runWorkflow child-flow resolution)
 *   deps.maxDepth        – max nesting depth for runWorkflow (default 5)
 *   deps.maxActiveSubRuns – max concurrent child sub-runs (default 1)
 *
 * Returns { createCtx, agent, bash, approve, runWorkflow, disposeRun,
 *           logger, fs, clock, openBackend, io }.
 *
 * Live run-state (reused sessions) is held in a per-run Map keyed by
 * ctx.runId — never stored on the pure-data ctx itself.
 */
export function createRuntime({
  fs, clock, openBackend, io, progress, config,
  workflowsRoot, maxDepth, maxActiveSubRuns,
} = {}) {
  const resolvedIo = io ?? defaultIo();
  const logger = createLogger({ fs, clock });
  const resolvedOpenBackend = openBackend ?? realOpenBackend;

  /** @type {Map<string, { reusedSessions: Map<string, object> }>} */
  const _runs = new Map();

  function getRunState(runId) {
    let rs = _runs.get(runId);
    if (!rs) {
      rs = {
        reusedSessions: new Map(),
        keyChains: new Map(),   // sessionKey → 串行链(reuse 调用排队,P1-6b)
        disposed: false,        // disposeRun 后立此标记,防复活(P1-7)
        lastSinkError: null,
      };
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
    progress,
    config,
  });

  const bash = createBash({ logger });

  const agentLoop = createAgentLoop({
    openBackend: resolvedOpenBackend,
    logger,
    config,
    progress,
  });

  const approve = createApprove({ io: resolvedIo, logger });

  const reviseWithHuman = createReviseWithHuman({
    agent,
    approve,
    logger,
  });

  /**
   * disposeRun(ctx) — close all reused sessions and clean up run-state.
   *
   *
   * Must be called when a run completes.  Idempotent (safe to call
   * multiple times for the same run).
   */
  async function disposeRun(ctx) {
    const rs = _runs.get(ctx.runId);
    if (!rs || rs.disposed) return;
    rs.disposed = true;     // 先立标记:在飞的 agentOnce 持有同一对象引用,看得见
    try {
      for (const [, entry] of rs.reusedSessions) {
        try { entry.session.close(); } catch { /* 单个会话 close 抛错不连累其余 */ }
        await logger.logSession(ctx, {
          event: "session:close",
          sessionId: entry.sessionId,
          agent: entry.agent,
          model: entry.model,
          reused: true,
        }).catch(() => {});
      }
    } finally {
      rs.reusedSessions.clear();
      // 故意不从 _runs 删除:保留 disposed 标记,防止此后的
      // getRunState 重建一个无人收尾的新 state(P1-7)。
    }
  }

  // ── Build the runtime object ────────────────────────────────────
  // runWorkflow needs the runtime object (to pass to runFlow), so we
  // build the object first, then wire runWorkflow with a lazy getter.
  const runtimeObj = {
    /**
     * createCtx(input, { cwd }) — produce a pure-data context for a single run.
     *
     * @param {*}      input – flow input (passed through to ctx.input)
     * @param {object} [opts]
     * @param {string} [opts.cwd] – working directory (default: process.cwd())
     */
    createCtx(input, { cwd } = {}) {
      return createCtx({ input, cwd });
    },
    /** agent() primitive — call a backend, return text. */
    agent,
    /** bash() primitive — run a shell command. */
    bash,
    /** agentLoop() primitive — multi-turn agent iteration, reuses session. */
    agentLoop,
    /** backtrack() helper — cross-node retry with feedback. */
    backtrack,
    /** defer() factory — create a LIFO defer scope. */
    defer: createDeferScope,
    /** approve() primitive — present content, wait for human decision. */
    approve,
    /** reviseWithHuman() primitive — human-in-the-loop revision loop. */
    reviseWithHuman,
    /** disposeRun(ctx) — close reused sessions for a run. */
    disposeRun,
    /** Escape hatch for tests: return the per-run state map entry. */
    _getRunState: getRunState,
    /** Logger instance bound to the injected sinks. */
    logger,
    /** Filesystem sink (injected or undefined). */
    fs,
    /** Time source (injected or undefined). */
    clock,
    /** Backend factory — injected sentinel or the real openBackend. */
    openBackend: resolvedOpenBackend,
    /** I/O interface — resolved to defaultIo() when not injected. */
    io: resolvedIo,
  };

  // Wire runWorkflow after runtimeObj exists (lazy getRuntime avoids
  // circular dependency).
  if (workflowsRoot) {
    runtimeObj.runWorkflow = createRunWorkflow({
      workflowsRoot,
      maxDepth,
      maxActiveSubRuns,
      getRuntime: () => runtimeObj,
    });
  }

  return runtimeObj;
}

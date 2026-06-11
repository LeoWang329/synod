/**
 * createAgent — factory for the `agent()` primitive.
 *
 * Accepts injected dependencies (openBackend, logger, run-state accessors)
 * so the primitive is testable with fakes and never accesses live objects
 * through ctx.
 *
 * The returned `agent()` function is a closure — it holds no state of its
 * own; all live run-state (reused sessions) lives in the runtime's
 * per-run map.
 *
 * ## Session lifecycle invariant
 *
 * Once `openBackend()` succeeds, `session.close()` MUST be called
 * regardless of any log-write failures.  The control flow uses a
 * try/finally with a `succeeded` flag:
 *
 *   - non-reuse: close in finally (always)
 *   - reuse + success: keep in pool (no close)
 *   - reuse + failure: close + remove from pool
 *
 * All log writes (logSession / logStep) are best-effort inside the
 * try/catch/finally — they use `.catch(() => {})` so a disk-full log
 * never blocks session teardown.
 */
import { makeResolveOpts } from "./resolve-opts.mjs";
import { raceAbort } from "./abortable.mjs";

export function createAgent({
  openBackend,
  logger,
  getRunState,
  removeReusedSession,
  progress,
  config,
  getSignal,
}) {
  /** Best-effort await — never throws. */
  const bg = (p) => p.catch(() => {});

  const resolveOpts = makeResolveOpts(config);

  /**
   * agent(ctx, opts) — call an agent backend, return accumulated text.
   *
   * Default (one-shot): open → send(wait) → close, all within this call.
   * reuse:true: session is stored per run and closed at disposeRun().
   *
   * Always writes session:open / step:* / session:close to the run log.
   *
   * @param {object} ctx          – pure-data context (must have .runId, .cwd)
   * @param {object} opts
   * @param {string} opts.agent   – backend name ("omp" | "codex")
   * @param {string} [opts.model] – model string, passed to backend
   * @param {string} opts.prompt  – the message to send
   * @param {boolean} [opts.reuse] – keep session alive for later calls
   * @returns {Promise<string>} accumulated response text
   */
  async function agent(ctx, rawOpts) {
    const opts = resolveOpts(rawOpts);
    validateAgentArgs(ctx, opts);
    if (!opts.reuse) return agentOnce(ctx, opts);
    // reuse = 同 key 串行:复用会话绝不并发 send(P1-6b)。
    // 链头 catch 吞掉前序错误——排队语义只关心"轮到我",不继承前者失败。
    const runState = getRunState(ctx.runId);
    const key = sessionKeyOf(opts);
    const prev = runState.keyChains.get(key) ?? Promise.resolve();
    const task = prev.catch(() => {}).then(() => agentOnce(ctx, opts));
    runState.keyChains.set(key, task);
    return task;
  }

  function sessionKeyOf({ agent: agentName, model, effort, write, mesh, systemPrompt }) {
    // 结构化 key:避免 model/systemPrompt 内含分隔符导致不同字段元组碰撞同一 key。
    return JSON.stringify([agentName, model ?? "", effort ?? "", !!write, !!mesh, systemPrompt ?? ""]);
  }

  function validateAgentArgs(ctx, { agent: agentName, model, prompt }) {
    if (!ctx || typeof ctx.runId !== "string" || !ctx.runId) {
      throw new Error("agent: ctx.runId is required (non-empty string)");
    }
    if (!ctx.cwd || typeof ctx.cwd !== "string") {
      throw new Error("agent: ctx.cwd is required (non-empty string)");
    }
    if (typeof agentName !== "string" || !agentName) {
      throw new Error("agent: agent name is required (non-empty string)");
    }
    if (model !== undefined && model !== null && (typeof model !== "string" || !model)) {
      throw new Error(
        `agent: model must be a non-empty string or null/undefined, got ${typeof model}`,
      );
    }
    if (typeof prompt !== "string" || !prompt) {
      throw new Error("agent: prompt is required (non-empty string)");
    }
  }

  async function agentOnce(
    ctx,
    { agent: agentName, model, effort, write, mesh, systemPrompt, prompt, reuse, signal: optsSignal },
  ) {
    const sink = progress;

    const runState = getRunState(ctx.runId);
    // opts.signal 显式优先于 run 级 signal(CLI Ctrl-C / abortRun)。
    const signal = optsSignal ?? getSignal?.(ctx.runId);
    const sessionKey = sessionKeyOf({ agent: agentName, model, effort, write, mesh, systemPrompt });

    let session;
    let reused = false;
    let sessionId;

    // ── Acquire or create session ─────────────────────────────────
    if (reuse && runState.reusedSessions.has(sessionKey)) {
      const entry = runState.reusedSessions.get(sessionKey);
      session = entry.session;
      sessionId = entry.sessionId;
      reused = true;
    } else {
      // openBackend may throw — handle separately (no session to leak)
      if (sink) {
        try { sink.emit({ type: "opening", agent: agentName, model }); }
        catch (e) { /* sink error is best-effort */ }
      }
      try {
        session = await openBackend({
          agent: agentName,
          model,
          effort,
          write,
          mesh,
          systemPrompt,
          cwd: ctx.cwd,
        });
      } catch (openErr) {
        await bg(logger.logStep(ctx, {
          node: agentName,
          type: "agent",
          attempt: 1,
          error: openErr,
          input: prompt,
          meta: { agent: agentName, model: model ?? null },
        }));
        throw openErr;
      }

      sessionId = session.summary().id;

      // session:open log is best-effort — must not block close
      await bg(logger.logSession(ctx, {
        event: "session:open",
        sessionId,
        agent: agentName,
        model: model ?? null,
        reused: false,
      }));

      if (reuse && !runState.disposed) {
        runState.reusedSessions.set(sessionKey, {
          session,
          sessionId,
          agent: agentName,
          model: model ?? null,
        });
      }
    }

    // ── Per-call delta subscription (independent of close/logStep) ──
    let onDelta = null;
    if (sink) {
      onDelta = (chunk) => {
        try {
          sink.emit({ type: "delta", agent: agentName, model, text: chunk });
        } catch (e) {
          runState.lastSinkError = e;
        }
      };
      session.on("delta", onDelta);
      // Signal turn start on EVERY send (incl. reuse, where no "opening"
      // fires) so the sink can begin each agent's output on a fresh,
      // prefixed line instead of running onto the previous agent's tail.
      try {
        sink.emit({ type: "start", agent: agentName, model });
      } catch (e) {
        runState.lastSinkError = e;
      }
    }

    // ── Send + log + close ────────────────────────────────────────
    let result;
    try {
      result = await raceAbort(
        session.send(prompt, { wait: true }),
        signal,
        () => { try { session.close(); } catch {} },   // abort 杀进程
      );
    } catch (sendErr) {
      // Log failure is best-effort
      await bg(logger.logStep(ctx, {
        node: agentName,
        type: "agent",
        attempt: 1,
        error: sendErr,
        input: prompt,
        meta: { agent: agentName, model: model ?? null },
      }));

      // Remove from reuse pool so disposeRun won't double-close
      if (reuse) {
        removeReusedSession(ctx.runId, sessionKey);
      }

      session.close();
      await bg(logger.logSession(ctx, {
        event: "session:close",
        sessionId,
        agent: agentName,
        model: model ?? null,
        reused,
      }));

      throw sendErr;
    } finally {
      // Per-call cleanup — always runs, independent of close-in-finally below
      if (onDelta) session.off("delta", onDelta);
    }

    const text = result.text ?? "";

    // Success-path logStep is LOUD — if artifact write fails we must
    // surface the error (do not silently swallow).
    let logOk = false;
    try {
      await logger.logStep(ctx, {
        node: agentName,
        type: "agent",
        attempt: 1,
        output: text,
        input: prompt,
        meta: { agent: agentName, model: model ?? null },
      });
      logOk = true;
      return text;
    } finally {
      // 关闭条件:一次性会话(总是)、logStep 失败(脏会话)、
      // 或 run 已 dispose(本调用在 dispose 竞态窗口内完成,不得入池存活)。
      if (!reuse || !logOk || runState.disposed) {
        if (reuse) {
          removeReusedSession(ctx.runId, sessionKey);
        }
        session.close();
        await bg(logger.logSession(ctx, {
          event: "session:close",
          sessionId,
          agent: agentName,
          model: model ?? null,
          reused,
        }));
      }
    }
  }

  return agent;
}

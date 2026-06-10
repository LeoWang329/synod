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
export function createAgent({
  openBackend,
  logger,
  getRunState,
  removeReusedSession,
  progress,
}) {
  /** Best-effort await — never throws. */
  const bg = (p) => p.catch(() => {});

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
  async function agent(
    ctx,
    { agent: agentName, model, prompt, reuse },
  ) {
    // ── Pre-validation (before any session is opened) ─────────────
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

    const sink = progress;

    const runState = getRunState(ctx.runId);
    const sessionKey = `${agentName}:${model ?? ""}`;

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

      if (reuse) {
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
    }

    // ── Send + log + close ────────────────────────────────────────
    let result;
    try {
      result = await session.send(prompt, { wait: true });
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
      // Close if non-reuse (always) or reuse + logStep failed (dirty session)
      if (!reuse || !logOk) {
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

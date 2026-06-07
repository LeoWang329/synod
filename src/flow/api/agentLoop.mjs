/**
 * createAgentLoop — factory for the `agentLoop()` primitive.
 *
 * `agentLoop` opens a single session and sends multiple prompts in a
 * loop, reusing the session across turns.  It stops when `until(output)`
 * returns truthy, or after `maxTurns` (whichever comes first).
 *
 * ## Session lifecycle
 *
 * The session is opened once before the loop and closed in a `finally`
 * block — it is always closed regardless of send errors.
 *
 * ## Logging
 *
 * Each turn writes a `step:*` pair (started + succeeded/failed) via
 * the logger.  A `session:open` / `session:close` pair brackets the
 * entire loop.
 *
 * ## Prompt builder
 *
 * `opts.prompt` may be a string (same prompt every turn) or a function
 * `(turn: number, prevOutput?: string) => string` that builds the prompt
 * for each turn.  `turn` is 1-indexed.
 */

export function createAgentLoop({ openBackend, logger }) {
  /** Best-effort await — never throws. */
  const bg = (p) => p.catch(() => {});

  /**
   * agentLoop(ctx, opts) — multi-turn agent iteration within a node.
   *
   * @param {object} ctx        – pure-data context (must have .runId, .cwd)
   * @param {object} opts
   * @param {string} opts.agent   – backend name ("omp" | "codex")
   * @param {string} [opts.model] – model string, passed to backend
   * @param {string|((turn: number, prevOutput?: string) => string)} opts.prompt
   * @param {(output: string, turn: number) => boolean} opts.until
   * @param {number} [opts.maxTurns=5]
   * @returns {Promise<string>} final accumulated text
   */
  async function agentLoop(
    ctx,
    { agent: agentName, model, prompt, until, maxTurns = 5 },
  ) {
    // ── Validation ──────────────────────────────────────────────────
    if (!ctx || typeof ctx.runId !== "string" || !ctx.runId) {
      throw new Error("agentLoop: ctx.runId is required (non-empty string)");
    }
    if (!ctx.cwd || typeof ctx.cwd !== "string") {
      throw new Error("agentLoop: ctx.cwd is required (non-empty string)");
    }
    if (typeof agentName !== "string" || !agentName) {
      throw new Error("agentLoop: agent name is required (non-empty string)");
    }
    if (model !== undefined && model !== null && (typeof model !== "string" || !model)) {
      throw new Error(
        `agentLoop: model must be a non-empty string or null/undefined, got ${typeof model}`,
      );
    }
    if (typeof prompt !== "string" && typeof prompt !== "function") {
      throw new Error(
        "agentLoop: prompt must be a string or function(turn, prevOutput) => string",
      );
    }
    if (typeof until !== "function") {
      throw new Error("agentLoop: until must be a function(output, turn) => boolean");
    }
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error("agentLoop: maxTurns must be a positive integer");
    }

    // ── Open session ────────────────────────────────────────────────
    let session;
    try {
      session = await openBackend({
        agent: agentName,
        model,
        cwd: ctx.cwd,
      });
    } catch (openErr) {
      await bg(
        logger.logStep(ctx, {
          node: agentName,
          type: "agentLoop",
          attempt: 1,
          error: openErr,
          meta: { agent: agentName, model: model ?? null },
        }),
      );
      throw openErr;
    }

    const sessionId = session.summary().id;

    // session:open log is best-effort
    await bg(
      logger.logSession(ctx, {
        event: "session:open",
        sessionId,
        agent: agentName,
        model: model ?? null,
        reused: false,
      }),
    );

    // ── Loop ────────────────────────────────────────────────────────
    let lastOutput = "";

    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        const promptText =
          typeof prompt === "function" ? prompt(turn, lastOutput) : prompt;

        let result;
        try {
          result = await session.send(promptText, { wait: true });
        } catch (sendErr) {
          // Log failure is best-effort
          await bg(
            logger.logStep(ctx, {
              node: agentName,
              type: "agentLoop",
              attempt: turn,
              error: sendErr,
              input: promptText,
              meta: { agent: agentName, model: model ?? null, turn, maxTurns },
            }),
          );
          throw sendErr;
        }

        lastOutput = result.text ?? "";

        // Log this turn (success-path logStep is LOUD — if artifact
        // write fails we must surface the error)
        await logger.logStep(ctx, {
          node: agentName,
          type: "agentLoop",
          attempt: turn,
          output: lastOutput,
          input: promptText,
          meta: { agent: agentName, model: model ?? null, turn, maxTurns },
        });

        // Check stop condition
        if (until(lastOutput, turn)) {
          return lastOutput;
        }
      }

      // maxTurns reached
      return lastOutput;
    } finally {
      session.close();
      await bg(
        logger.logSession(ctx, {
          event: "session:close",
          sessionId,
          agent: agentName,
          model: model ?? null,
          reused: false,
        }),
      );
    }
  }

  return agentLoop;
}

/**
 * createReviseWithHuman — factory for the `reviseWithHuman()` primitive.
 *
 * ## What it does
 *
 * Human-in-the-loop revision (Plan A: natural-language feedback, no
 * structured anchoring).  The caller provides an initial draft; the
 * primitive loops:
 *
 *   1. Present the current full doc to a human via `approve()`.
 *   2. If accepted → return the doc as final.
 *   3. If aborted  → return the current doc (graceful exit, no throw).
 *   4. If feedback  → call `agent()` with the **full current doc +
 *      feedback explicitly in the prompt**, get revised doc, repeat.
 *
 * ## Reuse = optimisation, not a correctness dependency
 *
 * The agent session is reused across turns (`reuse: true`) for
 * coherence and token savings, but **every turn's prompt includes the
 * complete current doc**.  If the session drops mid-loop, the failed
 * `agent()` call removes it from the pool; the primitive retries
 * immediately — the next `agent()` opens a fresh session and the
 * explicit prompt guarantees the new session has all the context it
 * needs.
 *
 * ## Abort contract
 *
 * The abort is cooperative: when `approve()` returns `{ aborted: true }`,
 * `reviseWithHuman` returns the current draft.  No `process.exit()`,
 * no thrown exception — the caller decides what to do next.
 *
 * ## Logging
 *
 * Each `approve()` and `agent()` call inside the loop logs its own
 * `step:*` lifecycle pair via the injected logger.  The primitive does
 * not add extra log entries of its own.
 */

/**
 * Build the revision prompt including the full current document.
 *
 * Every turn the complete doc is passed so the agent has full context
 * even if the session was rebuilt from scratch.
 *
 * @param {string} doc      – current full document
 * @param {string} feedback – human's natural-language revision request
 * @returns {string}
 */
function revisePrompt(doc, feedback) {
  return `Current document:
---
${doc}
---

Revision request: ${feedback}

Revise the document according to the request above.  Return the complete revised document.`;
}

/**
 * createReviseWithHuman — DI factory.
 *
 * @param {object} deps
 * @param {(ctx, opts) => Promise<string>} deps.agent
 * @param {(ctx, opts) => Promise<object>}  deps.approve
 * @returns {(ctx, draft, opts?) => Promise<string>}
 */
export function createReviseWithHuman({ agent, approve, logger: _logger }) {
  /**
   * reviseWithHuman(ctx, draft, opts) — human-in-the-loop revision loop.
   *
   * @param {object} ctx        – pure-data context (must have .runId)
   * @param {string} draft      – initial document to revise
   * @param {object} [opts]     – passed through to agent() unchanged
   *                              (profile/agent/model/effort/write/
   *                              systemPrompt/signal). `reuse` is forced
   *                              true and `prompt` is built per turn.
   * @returns {Promise<string>} final (or last) document
   */
  async function reviseWithHuman(ctx, draft, opts = {}) {
    if (typeof draft !== "string" || !draft) {
      throw new Error("reviseWithHuman: draft is required (non-empty string)");
    }

    const { signal } = opts;
    let doc = draft;

    while (true) {
      // ── Present to human ──────────────────────────────────────────
      const decision = await approve(ctx, {
        content: doc,
        signal,
      });

      if (decision.accepted || decision.aborted) {
        return doc;
      }

      // ── Revise via agent ──────────────────────────────────────────
      const feedback = decision.feedback;
      const prompt = revisePrompt(doc, feedback);

      // opts 原样透传(profile/agent/model/effort/write/systemPrompt/signal),
      // reuse 强制 true、prompt 用本轮构建的。agent 自己解析 profile + signal。
      // 默认 agent 由调用方/profile 决定,缺省时 agent.mjs 的 validateAgentArgs
      // 会要求 agent 名——与 agent/agentLoop 一致。
      const callOpts = { ...opts, prompt, reuse: true };
      try {
        // reuse:true keeps the session alive across turns (optimisation).
        // Every prompt includes the full doc so correctness does NOT
        // depend on session memory.
        doc = await agent(ctx, callOpts);
      } catch (_err) {
        // Session may have dropped — the failed agent() call already
        // removed it from the reuse pool and closed it.  Retry with a
        // fresh session; the full doc is in the prompt so the new
        // session has everything it needs.
        doc = await agent(ctx, callOpts);
      }
    }
  }

  return reviseWithHuman;
}

/**
 * createApprove — factory for the `approve()` human-approval primitive.
 *
 * Accepts injected `io` (stdin/stdout) and `logger` so the primitive
 * is testable with fakes and never accesses live process globals
 * directly.
 *
 * ## Event-driven design (non-blocking by contract)
 *
 * `approve()` reads input through `io.question(prompt, { signal })` —
 * an **event-driven** API backed by a shared, single-owner readline.
 * Only one question can be pending at a time; concurrent readers
 * (CLI or another approve call) MUST wait.  This prevents input-routing
 * conflicts where the same line is consumed by two readers.
 *
 * While waiting, other I/O (deltas, timers, network) continues to be
 * processed — the event loop is never blocked.
 *
 * ## Abort token propagation
 *
 * `opts.signal` accepts an `AbortSignal`.  When the signal is aborted
 * (either before `approve()` is called or while it is waiting):
 *
 *   1. If a question is pending, it is cancelled (rejects with AbortError).
 *   2. The promise resolves with `{ aborted: true }`.
 *
 * The abort is **cooperative** — it does not throw, kill the process,
 * or terminate other in-flight work.  Callers MUST check the
 * `aborted` field in the result and propagate the abort decision
 * upward (e.g. return early, skip remaining steps, let `defer`
 * cleanup run).
 *
 * If `signal` is omitted, `approve()` waits indefinitely until the
 * user provides a line or the process exits.
 *
 * ## Acceptance contract
 *
 * User input is trimmed.  Matching is **case-insensitive**.
 *
 *   Accepted:  "accept", "y", "yes", "ok", "approve"
 *   Aborted:   "" (empty line), "/abort"  (case-insensitive)
 *   Feedback:  anything else → returned verbatim as `feedback`
 *
 * The caller receives exactly one of:
 *   - `{ accepted: true }`
 *   - `{ aborted: true }`
 *   - `{ accepted: false, feedback: "<…>" }`
 */

const ACCEPT_WORDS = new Set(["accept", "y", "yes", "ok", "approve"]);

export function createApprove({ io, logger, getSignal, getReplay }) {
  /**
   * approve(ctx, opts) — present content to a human, wait for decision.
   *
   * Writes `opts.content` to `io.stdout`, then reads one line via
   * `io.question(prompt, { signal })`.  Returns a structured result —
   * see module-level docs for the acceptance contract.
   *
   * @param {object} ctx           – pure-data context (must have .runId)
   * @param {object} opts
   * @param {string} [opts.content] – content to present for review
   * @param {string} [opts.prompt]  – prompt text (default: "(accept / feedback / /abort): ")
   * @param {AbortSignal} [opts.signal] – abort token
   * @returns {Promise<{accepted?:boolean, aborted?:boolean, feedback?:string}>}
   */
  async function approve(ctx, opts = {}) {
    const {
      content,
      prompt = "(accept / feedback / /abort): ",
    } = opts;

    // ── resume 重放(§4.12-1):命中按 logged 决定重建结果,不重新呈现/不重新问 ──
    const rep = getReplay?.(ctx.runId, { node: "approve", input: content != null ? String(content) : "" });
    if (rep?.hit) {
      if (rep.entry?.aborted) return { aborted: true };
      if (rep.entry?.accepted) return { accepted: true };
      return { accepted: false, feedback: rep.output ?? "" };
    }

    const signal = opts.signal ?? getSignal?.(ctx.runId);   // §4.7-3: run-level fallback

    // ── Present content ────────────────────────────────────────────
    if (content != null) {
      io.stdout.write(String(content) + "\n");
    }

    // ── Read one line via shared io.question ───────────────────────
    // Race against signal so that even io.question implementations that
    // don't honour the signal option are still interruptible.
    let line;
    try {
      const ask = io.question(prompt, { signal });
      if (signal) {
        // Wrap ask so the abort listener is always removed (raceAbort pattern).
        // {once:true} alone only removes the listener when it fires; if ask
        // settles first the listener would leak.  Explicit removeEventListener
        // in both resolution branches prevents accumulation across REPL sessions.
        line = await new Promise((resolve, reject) => {
          if (signal.aborted) {
            ask.catch(() => {});   // suppress unhandled rejection from ask
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            return;
          }
          const handler = () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          signal.addEventListener("abort", handler, { once: true });
          ask.then(
            (v) => { signal.removeEventListener("abort", handler); resolve(v); },
            (e) => { signal.removeEventListener("abort", handler); reject(e); },
          );
        });
      } else {
        line = await ask;
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        const result = { aborted: true };
        // Log (best-effort)
        await logger.logStep(ctx, {
          node: "approve",
          type: "approve",
          attempt: 1,
          input: content != null ? String(content) : "",
          output: "/abort",
          meta: { accepted: false, aborted: true },
        }).catch(() => {});
        return result;
      }
      throw err;
    }

    // ── Classify the response ─────────────────────────────────────
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    let result;
    if (lower === "" || lower === "/abort") {
      result = { aborted: true };
    } else if (ACCEPT_WORDS.has(lower)) {
      result = { accepted: true };
    } else {
      result = { accepted: false, feedback: trimmed };
    }

    // ── Log (best-effort — decision already made) ──────────────────
    // input  = content under review (aligns with agent: input=prompt)
    // output = the human's decision
    const decision = result.feedback ?? (result.accepted ? "accept" : "/abort");
    const meta = {
      accepted: result.accepted ?? false,
      aborted: result.aborted ?? false,
    };
    await logger.logStep(ctx, {
      node: "approve",
      type: "approve",
      attempt: 1,
      input: content != null ? String(content) : "",
      output: decision,
      meta,
    }).catch(() => {});

    return result;
  }

  return approve;
}

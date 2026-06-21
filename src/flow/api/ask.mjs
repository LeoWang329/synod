/**
 * createAsk — `ask()` 原语:自由问答取人答。
 *
 * 返回人打的原始整行(trim);**不做 accept/abort/feedback 分类**——这是与
 * `approve` 的关键区别。`approve` 把 "ok"/"yes"/空行 当成 accept/abort,对自由问答
 * 是坑;`ask` 把它们当普通答案原样返回。
 *
 *   空行          → ""(有效空答,不当 abort)
 *   "/spec" 等命令 → 原样返回,由调用方解释
 *   abort(signal) → null
 *
 * 工程对齐 `approve`(见 ./approve.mjs):共享单所有者 io.question、resume 重放、
 * headless 退出码 5、写 step 日志、DI factory。
 */
import { writeCheckpoint, awaitingHumanError } from "../checkpoint.mjs";
import { shortHash } from "../logger.mjs";

export function createAsk({ io, logger, getSignal, getReplay, headless = false, events, runsRoot, onApprovalNeeded }) {
  /**
   * ask(ctx, opts) — present a question, return the human's raw line.
   *
   * @param {object} ctx              – pure-data context (must have .runId)
   * @param {object} opts
   * @param {string} [opts.question]  – question presented to the human
   * @param {string} [opts.prompt]    – input prompt (default "> ")
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<string|null>}  the trimmed line, or null on abort
   */
  async function ask(ctx, opts = {}) {
    const { question, prompt = "> " } = opts;
    const q = question != null ? String(question) : "";

    // ── resume 重放:命中即回放,不重新提问 ──
    const rep = getReplay?.(ctx.runId, { node: "ask", input: q });
    if (rep?.hit) {
      if (rep.entry?.aborted) return null;
      return rep.output ?? "";
    }

    // ── headless:不等 stdin,打印 + 写断点 + 退出码 5 ──
    if (headless) {
      if (q) io.stdout.write(q + "\n");
      io.stdout.write("[synod] awaiting human input — run is paused.\n");
      if (runsRoot) {
        try {
          writeCheckpoint(runsRoot, ctx.runId, {
            status: "awaiting-approval",
            stoppedAt: { node: "ask", type: "ask", inputHash: shortHash(q) },
            pending: { content: q },
          });
        } catch { /* 写失败不阻断退出 */ }
      }
      try { events?.emit("approvalNeeded", { runId: ctx.runId, node: "ask", content: q }); } catch {}
      try { onApprovalNeeded?.(ctx); } catch {}
      throw awaitingHumanError({ runId: ctx.runId, node: "ask" });
    }

    const signal = opts.signal ?? getSignal?.(ctx.runId);
    if (q) io.stdout.write(q + "\n");

    let line;
    try {
      const askP = io.question(prompt, { signal });
      if (signal) {
        // 包一层,保证 abort 监听在两个分支都被移除(防 REPL 跨会话累积)。
        line = await new Promise((resolve, reject) => {
          if (signal.aborted) {
            askP.catch(() => {});
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            return;
          }
          const h = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          signal.addEventListener("abort", h, { once: true });
          askP.then(
            (v) => { signal.removeEventListener("abort", h); resolve(v); },
            (e) => { signal.removeEventListener("abort", h); reject(e); },
          );
        });
      } else {
        line = await askP;
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        await logger.logStep(ctx, {
          node: "ask", type: "ask", attempt: 1, input: q, output: "", meta: { aborted: true },
        }).catch(() => {});
        return null;
      }
      throw err;
    }

    const answer = line.trim();
    await logger.logStep(ctx, {
      node: "ask", type: "ask", attempt: 1, input: q, output: answer, meta: { aborted: false },
    }).catch(() => {});
    return answer;
  }

  return ask;
}

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * createBash — factory for the `bash()` primitive.
 *
 * Accepts injected logger so the primitive can write step log entries.
 */
export function createBash({ logger }) {
  /**
   * bash(ctx, cmd, { cwd? }) — run a shell command.
   *
   * Returns { stdout, stderr, code }.  Never throws on command failure
   * (non-zero exit is returned, not thrown).
   *
   * Success-path logStep is LOUD — if artifact write fails the error
   * propagates (not disguised as a command failure).
   *
   * Failure-path log is best-effort (command error takes priority).
   *
   * @param {object} ctx    – pure-data context
   * @param {string} cmd    – shell command string
   * @param {object} [opts]
   * @param {string} [opts.cwd] – working directory (default: ctx.cwd)
   * @returns {Promise<{stdout:string, stderr:string, code:number}>}
   */
  async function bash(ctx, cmd, { cwd } = {}) {
    // ── 1. Execute the command ─────────────────────────────────────
    let stdout;
    let stderr;
    let code;

    try {
      const r = await execAsync(cmd, {
        cwd: cwd ?? ctx.cwd,
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = r.stdout;
      stderr = r.stderr;
      code = 0;
    } catch (err) {
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message;
      code = err.code ?? 1;
    }

    // ── 2. Write step log ──────────────────────────────────────────
    // Success: loud — artifact write failures must surface.
    // Failure: best-effort — command error takes priority.
    //
    // TODO: large stderr should also use artifact separation.
    // Currently truncated to avoid bloating the JSONL line.
    const STDOUT_TRUNCATE = 1000; // FIXME: use threshold from logger
    const meta = { code };
    if (stderr && stderr.length > STDOUT_TRUNCATE) {
      meta.stderr = stderr.slice(0, STDOUT_TRUNCATE) +
        `… (${stderr.length} bytes total)`;
    } else if (stderr) {
      meta.stderr = stderr;
    }

    if (code === 0) {
      // Success path: logStep is LOUD — must not be silently swallowed
      await logger.logStep(ctx, {
        node: "bash",
        type: "bash",
        attempt: 1,
        output: stdout,
        input: cmd,
        meta,
      });
      return { stdout: stdout.trimEnd(), stderr, code: 0 };
    } else {
      // Failure path: log is best-effort, return result structure
      try {
        await logger.logStep(ctx, {
          node: "bash",
          type: "bash",
          attempt: 1,
          input: cmd,
          output: stdout,
          meta,
        });
      } catch {
        // Intentionally suppress — command error takes priority
      }
      return { stdout: stdout.trimEnd(), stderr, code };
    }
  }

  return bash;
}

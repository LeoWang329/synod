import { randomUUID } from "node:crypto";

/**
 * Characters threshold above which `output` (and `input`) are diverted to
 * artifact files rather than being inlined in the JSONL log line.
 *
 * Exported so tests can assert boundary behavior without hard-coding
 * the value.
 */
export const OUTPUT_INLINE_THRESHOLD = 200;

const VALID_SESSION_EVENTS = new Set(["session:open", "session:close"]);

const ARTIFACT_DIR = "artifacts";
const LOG_PATH = "run.log.jsonl";

/**
 * createLogger — JSONL step-lifecycle logger with large-output artifact
 * separation and session lifecycle events.
 *
 * Injected dependencies:
 *  - fs:  { writeFile(path, content), appendFile(path, content) }
 *  - clock: () => number   (milliseconds-since-epoch timestamp)
 *
 * Every `logStep` call writes two JSONL lines:
 *  1. step:started
 *  2. step:succeeded  (or step:failed when `error` is present)
 *
 * Large `output` / `input` strings (length > OUTPUT_INLINE_THRESHOLD) are
 * stored as artifacts; the JSONL line carries an `outputRef` / `inputRef`
 * pointer instead of the full text.
 *
 * `logSession` writes a single JSONL line for session open/close events.
 */
export function createLogger({ fs, clock }) {
  async function writeJSONL(obj) {
    await fs.appendFile(LOG_PATH, JSON.stringify(obj) + "\n");
  }

  /**

/** Fields that meta must NOT overwrite. */
const RESERVED_META_KEYS = new Set([
  "event", "runId", "stepId", "node", "type", "attempt",
  "ts", "input", "inputRef", "output", "outputRef", "error",
]);

/**
 * Recursively validate that `value` is pure JSON-safe data.
 * Rejects: function, symbol, undefined, bigint, NaN/Infinity,
 * non-plain objects (Date, Map, Set, RegExp, etc.), circular refs.
 */
function validatePureData(value, path, visited = new WeakSet()) {
  if (value === null) return;
  const t = typeof value;
  if (t === "function") throw new Error(`logStep: meta${path}: functions are not allowed`);
  if (t === "symbol") throw new Error(`logStep: meta${path}: symbols are not allowed`);
  if (t === "undefined") throw new Error(`logStep: meta${path}: undefined is not allowed`);
  if (t === "bigint") throw new Error(`logStep: meta${path}: bigint is not allowed`);
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error(`logStep: meta${path}: non-finite number is not allowed`);
    return;
  }
  if (t === "string" || t === "boolean") return;

  if (visited.has(value)) throw new Error(`logStep: meta${path}: circular reference detected`);
  visited.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validatePureData(value[i], `${path}[${i}]`, visited);
    }
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const ctor = value.constructor?.name ?? "unknown";
    throw new Error(`logStep: meta${path}: non-plain object (${ctor}) is not allowed`);
  }

  for (const key of Object.keys(value)) {
    validatePureData(value[key], `${path}.${key}`, visited);
  }
}

/** Validate meta: no reserved fields, all values pure data. */
function validateMeta(meta) {
  for (const key of Object.keys(meta)) {
    if (RESERVED_META_KEYS.has(key)) {
      throw new Error(`logStep: meta.${key} is a reserved field`);
    }
  }
  validatePureData(meta, "");
}

  /**
   * Write an `output`-like value (output or input) to artifact if large,
   * returning { ref, str }.
   */
  async function disposeLargeString(stepId, prefix, value) {
    let ref;
    let str;
    if (value !== undefined && value !== null) {
      str = typeof value === "string" ? value : JSON.stringify(value);
      if (str.length > OUTPUT_INLINE_THRESHOLD) {
        ref = `${ARTIFACT_DIR}/${stepId}.${prefix}.txt`;
        await fs.writeFile(ref, str);
      }
    }
    return { ref, str };
  }

  /**
   * logStep — record a step lifecycle (started + succeeded/failed).
   *
   * @param {object} opts
   * @param {string} [opts.input]   – prompt / input text (may be large)
   * @param {string} [opts.output]  – response text (may be large)
   * @param {object} [opts.meta]    – small plain-data object merged into entry
   */
  async function logStep(
    ctx,
    { node, type, attempt = 1, output, error, input, meta },
  ) {
    // ── Validate required fields before writing anything ──────────
    if (!ctx || typeof ctx.runId !== "string" || !ctx.runId) {
      throw new Error("logStep: ctx.runId is required (non-empty string)");
    }
    if (typeof node !== "string" || !node) {
      throw new Error("logStep: node is required (non-empty string)");
    }
    if (typeof type !== "string" || !type) {
      throw new Error("logStep: type is required (non-empty string)");
    }
    if (
      typeof attempt !== "number" ||
      !Number.isInteger(attempt) ||
      attempt < 1
    ) {
      throw new Error(
        `logStep: attempt must be a positive integer, got ${attempt}`,
      );
    }
    if (meta !== undefined) {
      if (meta === null || typeof meta !== "object") {
        throw new Error("logStep: meta must be a plain object");
      }
      validateMeta(meta);
    }

    const stepId = randomUUID();
    const ts = clock();

    // ── step:started ──────────────────────────────────────────────
    const startedEntry = {
      event: "step:started",
      runId: ctx.runId,
      stepId,
      node,
      type,
      attempt,
      ts,
    };
    if (ctx.parentRunId) startedEntry.parentRunId = ctx.parentRunId;
    await writeJSONL(startedEntry);

    // ── Dispose large input / output to artifacts ─────────────────
    const inputDisposition = await disposeLargeString(
      stepId,
      "input",
      input,
    );
    const outputDisposition = await disposeLargeString(
      stepId,
      "output",
      output,
    );

    // ── step:succeeded | step:failed ──────────────────────────────
    const event = error ? "step:failed" : "step:succeeded";
    const entry = {
      event,
      runId: ctx.runId,
      stepId,
      node,
      type,
      attempt,
      ts,
    };
    if (ctx.parentRunId) entry.parentRunId = ctx.parentRunId;

    if (inputDisposition.ref) {
      entry.inputRef = inputDisposition.ref;
    } else if (input !== undefined && input !== null) {
      entry.input = inputDisposition.str;
    }

    if (outputDisposition.ref) {
      entry.outputRef = outputDisposition.ref;
    } else if (output !== undefined && output !== null) {
      entry.output = outputDisposition.str;
    }

    if (error) {
      entry.error =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : String(error);
    }

    if (meta !== undefined) {
      Object.assign(entry, meta);
    }

    await writeJSONL(entry);
  }

  /**
   * logSession — record a session lifecycle event.
   *
   * `event` must be "session:open" or "session:close" (throws otherwise).
   */
  async function logSession(ctx, { event, sessionId, agent, model, reused }) {
    // ── Validate required fields before writing anything ──────────
    if (!ctx || typeof ctx.runId !== "string" || !ctx.runId) {
      throw new Error(
        "logSession: ctx.runId is required (non-empty string)",
      );
    }
    if (!VALID_SESSION_EVENTS.has(event)) {
      throw new Error(
        `logSession: invalid event "${event}", expected "session:open" or "session:close"`,
      );
    }
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(
        "logSession: sessionId is required (non-empty string)",
      );
    }
    if (typeof agent !== "string" || !agent) {
      throw new Error("logSession: agent is required (non-empty string)");
    }
    if (model !== undefined && model !== null) {
      if (typeof model !== "string" || !model) {
        throw new Error(
          `logSession: model must be a non-empty string or null, got ${typeof model}`,
        );
      }
    }
    if (reused !== undefined && typeof reused !== "boolean") {
      throw new Error(
        `logSession: reused must be a boolean, got ${typeof reused}`,
      );
    }

    const entry = {
      event,
      runId: ctx.runId,
      sessionId,
      agent,
      model: model ?? null,
      reused: reused ?? false,
      ts: clock(),
    };
    if (ctx.parentRunId) entry.parentRunId = ctx.parentRunId;
    await writeJSONL(entry);
  }

  return { logStep, logSession, writeJSONL };
}

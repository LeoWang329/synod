import { randomUUID } from "node:crypto";

/**
 * Recursively validate that `value` is pure JSON-safe data.
 *
 * Rejects: function, symbol, undefined, bigint, NaN/Infinity,
 * non-plain objects (Date, Map, Set, RegExp, etc.), and circular references.
 *
 * @param {unknown} value
 * @param {string} path  – dotted path for error messages
 * @param {WeakSet} visited – tracks seen objects to detect cycles
 * @throws {Error} on any violation, with the offending path
 */
function validatePureData(value, path = "input", visited = new WeakSet()) {
  if (value === null) return;

  const t = typeof value;

  if (t === "function") {
    throw new Error(`${path}: functions are not allowed`);
  }
  if (t === "symbol") {
    throw new Error(`${path}: symbols are not allowed`);
  }
  if (t === "undefined") {
    throw new Error(`${path}: undefined is not allowed`);
  }
  if (t === "bigint") {
    throw new Error(`${path}: bigint is not allowed`);
  }
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `${path}: non-finite number (${value}) is not allowed`,
      );
    }
    return;
  }
  if (t === "string" || t === "boolean") return;

  // ── object ───────────────────────────────────────────────────────
  if (visited.has(value)) {
    throw new Error(`${path}: circular reference detected`);
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validatePureData(value[i], `${path}[${i}]`, visited);
    }
    return;
  }

  // Must be a plain object (prototype is Object.prototype or null)
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const ctor = value.constructor?.name ?? "unknown";
    throw new Error(`${path}: non-plain object (${ctor}) is not allowed`);
  }

  for (const key of Object.keys(value)) {
    validatePureData(value[key], `${path}.${key}`, visited);
  }
}

/**
 * createCtx — pure-data context factory.
 *
 * Every field is JSON-serializable (no functions, no live objects).
 * Input is recursively validated and deep-cloned so caller mutations
 * cannot corrupt the ctx.
 */
export function createCtx({ runId, cwd, input } = {}) {
  if (runId !== undefined && typeof runId !== "string") {
    throw new Error(
      `createCtx: runId must be a string, got ${typeof runId}`,
    );
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error(
      `createCtx: cwd must be a string, got ${typeof cwd}`,
    );
  }

  const safeInput = input ?? {};
  validatePureData(safeInput);

  // Deep-clone via JSON round-trip (validation already proved it's safe)
  const clonedInput = JSON.parse(JSON.stringify(safeInput));

  return {
    runId: runId ?? randomUUID(),
    cwd: cwd ?? process.cwd(),
    input: clonedInput,
    /** Ephemeral blackboard — key/value store for nodes to share data. */
    data: {},
    /** File path registry. */
    files: {},
    /** Configuration knobs. */
    config: {},
  };
}

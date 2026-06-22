import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, extname, sep, relative } from "node:path";

/** The only module that flow files are allowed to statically import. */
const ALLOWED_IMPORT = "synod/flow";

/** @returns true if `p` exists and is a regular file. */
async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

/** @returns true if `c` is a JS identifier character. */
function isIdent(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") || c === "_" || c === "$";
}

/**
 * State-machine lexical scanner for static import / re-export specifiers.
 *
 * Scans character-by-character with state transitions, skipping
 * comments and string/template literals so they never produce
 * false-positive matches.
 *
 * States: 0=normal, 1=lineComment, 2=blockComment,
 *         3=singleQuote, 4=doubleQuote, 5=template
 *
 * In state 0, when we see `import` (with word boundaries), we
 * classify it:
 *   - `import(`       → dynamic import, skip
 *   - `import.meta`   → skip
 *   - otherwise       → static import → extract specifier
 *
 * Likewise, `export … from "spec"` and `export * from "spec"`
 * are static re-exports and subject to the same whitelist check.
 *
 * ## Known limitation: regex literals
 *
 * A regex literal containing import-like text such as
 * `const r = /import {x} from "node:fs"/;` will be mis-parsed as
 * a static import.  Distinguishing regex from division requires
 * tracking the previous meaningful token — a classic parser
 * challenge not worth the complexity for a non-security lint.
 * Flows SHOULD avoid this pattern.
 *
 * @param {string} source
 */
function scanImports(source) {
  const len = source.length;
  let i = 0;
  let state = 0; // normal

  function peek(n = 0) { return i + n < len ? source[i + n] : ""; }
  function advance(n = 1) { i += n; }

  /** Skip whitespace and line terminators. */
  function skipSpaces() {
    while (i < len && (source[i] === " " || source[i] === "\t" ||
      source[i] === "\n" || source[i] === "\r")) i++;
  }

  /**
   * Skip whitespace, line comments, and block comments.
   * Used before reading a specifier string so that
   * `import /* c *‍/ "spec"` is handled correctly.
   */
  function skipTrivia() {
    while (i < len) {
      const c = source[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c === "/" && peek(1) === "/") {
        i += 2;
        while (i < len && source[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && peek(1) === "*") {
        i += 2;
        while (i < len && !(source[i] === "*" && peek(1) === "/")) i++;
        if (i < len) i += 2;
        continue;
      }
      break;
    }
  }

  /** Check word boundary before current position. */
  function wordBefore() {
    return i === 0 || !isIdent(source[i - 1]);
  }
  /** Check word boundary after the keyword ending at i + offset. */
  function wordAfter(offset = 0) {
    const end = i + offset;
    return end >= len || !isIdent(source[end]);
  }

  // ── String / template helpers (used by main loop + extractSpec) ──

  /** Skip a single/double-quoted string (state 3/4). */
  function skipString(quote) {
    advance(); // skip opening quote
    while (i < len) {
      if (source[i] === "\\") { advance(2); continue; }
      if (source[i] === quote) { advance(); return; }
      advance();
    }
  }

  /**
   * Skip a template literal (state 5).  Handles ${…} expressions
   * with brace-depth tracking and recursive template scanning.
   */
  function skipTemplate() {
    advance(); // skip opening backtick
    while (i < len) {
      if (source[i] === "\\") { advance(2); continue; }

      // End of template
      if (source[i] === "`") { advance(); return; }

      // Expression start: ${ … }
      if (source[i] === "$" && peek(1) === "{") {
        advance(2); // skip ${
        skipExpression();
        // skipExpression consumed up to matching }
        continue;
      }

      advance();
    }
  }

  /**
   * Skip a `${...}` expression body until the matching `}`.
   * Tracks brace depth so nested objects/arrows don't confuse.
   * Inside the expression we also need to skip strings, comments,
   * and nested templates so their content isn't misinterpreted.
   */
  function skipExpression() {
    let depth = 1; // we already consumed the opening {
    while (i < len && depth > 0) {
      const c = source[i];

      // Line comment
      if (c === "/" && peek(1) === "/") {
        advance(2);
        while (i < len && source[i] !== "\n") advance();
        continue;
      }
      // Block comment
      if (c === "/" && peek(1) === "*") {
        advance(2);
        while (i < len && !(source[i] === "*" && peek(1) === "/")) advance();
        if (i < len) advance(2); // skip */
        continue;
      }
      // Single-quoted string
      if (c === "'") { skipString("'"); continue; }
      // Double-quoted string
      if (c === '"') { skipString('"'); continue; }
      // Nested template literal
      if (c === "`") { skipTemplate(); continue; }
      // Opening brace (nested object / arrow body / etc.)
      if (c === "{") { depth++; advance(); continue; }
      if (c === "}") { depth--; advance(); continue; }

      advance();
    }
  }

  /**
   * Read a string literal and return its content (without quotes).
   * Used for specifier extraction.
   */
  function readSpecString(quote) {
    advance(); // skip opening
    const start = i;
    while (i < len) {
      if (source[i] === "\\") { advance(2); continue; }
      if (source[i] === quote) {
        const val = source.slice(start, i);
        advance(); // skip closing
        return val;
      }
      advance();
    }
    return source.slice(start, i);
  }

  /**
   * After identifying a static import at position (i = right after
   * the `import` keyword), extract its specifier.
   *
   * Tracks brace depth so `import { from as f } from "bad"` correctly
   * matches the second `from` (depth=0) rather than the first `from`
   * inside the named-import block.
   */
  function extractSpec() {
    skipTrivia();

    // Dynamic: import(…)
    if (peek() === "(") return;

    // import.meta
    if (peek() === ".") return;

    // Side-effect import: import "spec"  or  import 'spec'
    if (peek() === '"' || peek() === "'") {
      const spec = readSpecString(source[i]);
      if (spec !== ALLOWED_IMPORT) {
        throw new Error(
          `import "${spec}" is not allowed — flows may only import "${ALLOWED_IMPORT}"`,
        );
      }
      return;
    }

    // Named/default/namespace: import … from "spec"
    // Scan through the clause body tracking brace depth,
    // looking for `from` keyword at depth 0.
    let depth = 0;
    while (i < len) {
      const c = source[i];

      // Skip strings inside the clause (shouldn't normally appear,
      // but be robust — e.g. type annotations).
      if (c === "'") { skipString("'"); continue; }
      if (c === '"') { skipString('"'); continue; }
      if (c === "`") { skipTemplate(); continue; }

      // Track brace depth
      if (c === "{") { depth++; advance(); continue; }
      if (c === "}") { depth--; advance(); continue; }

      // Line / block comments in clause
      if (c === "/" && peek(1) === "/") {
        advance(2);
        while (i < len && source[i] !== "\n") advance();
        continue;
      }
      if (c === "/" && peek(1) === "*") {
        advance(2);
        while (i < len && !(source[i] === "*" && peek(1) === "/")) advance();
        if (i < len) advance(2);
        continue;
      }

      if (depth === 0 && c === "f" && source.startsWith("from", i)) {
        if (wordBefore() && wordAfter(4)) {
          advance(4); // skip "from"
          skipTrivia();
          if (peek() === '"' || peek() === "'") {
            const spec = readSpecString(source[i]);
            if (spec !== ALLOWED_IMPORT) {
              throw new Error(
                `import "${spec}" is not allowed — flows may only import "${ALLOWED_IMPORT}"`,
              );
            }
            return;
          }
          // Not a quoted string after `from` — keep scanning
          continue;
        }
      }

      // Skip whitespace
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        advance();
        continue;
      }

      if (isIdent(c) || c === "*" || c === ",") {
        advance();
        continue;
      }

      // Anything else — advance past it
      advance();
    }
  }

  /**
   * After identifying `export` keyword (i positioned right after it),
   * check whether this is a static re-export with `from "spec"`.
   *
   * `export {x} from "spec"` and `export * from "spec"` are checked.
   * `export const/function/class/…` and `export default` are skipped.
   *
   * Scans ONLY within the current export statement:
   * - `;` at depth 0 → statement ended, stop
   * - `}` at depth 0 followed by non-`from` trivia → local export, stop
   */
  function extractExportSpec() {
    skipTrivia();

    // export default … → skip (no from involved)
    if (source.startsWith("default", i)) {
      const after = i + 7;
      if (after >= len || !isIdent(source[after])) return;
    }

    // export const/let/var/function/class/async/type/interface → declaration, skip
    const declKeywords = ["const", "let", "var", "function", "class", "async", "type", "interface"];
    for (const kw of declKeywords) {
      if (source.startsWith(kw, i)) {
        const after = i + kw.length;
        if (after >= len || !isIdent(source[after])) return;
      }
    }

    // export { … } or export * — look for `from` keyword
    // Stop at `;` (depth 0) or `}`(depth 0) with non-`from` next token.
    let depth = 0;
    while (i < len) {
      const c = source[i];

      if (c === "'") { skipString("'"); continue; }
      if (c === '"') { skipString('"'); continue; }
      if (c === "`") { skipTemplate(); continue; }

      // Statement terminator at depth 0 — local export, no `from`
      if (depth === 0 && c === ";") { advance(); return; }

      if (c === "{") { depth++; advance(); continue; }
      if (c === "}") {
        depth--;
        advance();
        // After closing brace at depth 0: look ahead for `from`.
        // If nothing relevant follows, this is a local export — stop.
        if (depth === 0) {
          skipTrivia();
          // Check for `from` keyword
          if (source.startsWith("from", i)) {
            if (wordBefore() && wordAfter(4)) {
              advance(4);
              skipTrivia();
              if (peek() === '"' || peek() === "'") {
                const spec = readSpecString(source[i]);
                if (spec !== ALLOWED_IMPORT) {
                  throw new Error(
                    `import/export "${spec}" is not allowed — only "${ALLOWED_IMPORT}" may be statically imported/re-exported`,
                  );
                }
                return;
              }
              // `from` found but not followed by a specifier — keep going
              continue;
            }
          }
          // No `from` after `}` — local export, stop
          return;
        }
        continue;
      }

      if (c === "/" && peek(1) === "/") {
        advance(2);
        while (i < len && source[i] !== "\n") advance();
        continue;
      }
      if (c === "/" && peek(1) === "*") {
        advance(2);
        while (i < len && !(source[i] === "*" && peek(1) === "/")) advance();
        if (i < len) advance(2);
        continue;
      }

      if (depth === 0 && c === "f" && source.startsWith("from", i)) {
        if (wordBefore() && wordAfter(4)) {
          advance(4);
          skipTrivia();
          if (peek() === '"' || peek() === "'") {
            const spec = readSpecString(source[i]);
            if (spec !== ALLOWED_IMPORT) {
              throw new Error(
                `import/export "${spec}" is not allowed — only "${ALLOWED_IMPORT}" may be statically imported/re-exported`,
              );
            }
            return;
          }
        }
      }

      if (c === " " || c === "\t" || c === "\n" || c === "\r") { advance(); continue; }
      if (isIdent(c) || c === "*" || c === ",") { advance(); continue; }
      advance();
    }
  }

  // ── Main scan loop ────────────────────────────────────────────────
  while (i < len) {
    const c = source[i];

    switch (state) {
      case 0: { // normal
        // Line comment start
        if (c === "/" && peek(1) === "/") { state = 1; advance(2); continue; }
        // Block comment start
        if (c === "/" && peek(1) === "*") { state = 2; advance(2); continue; }
        // Single-quote string
        if (c === "'") { skipString("'"); continue; }
        // Double-quote string
        if (c === '"') { skipString('"'); continue; }
        // Template literal
        if (c === "`") { skipTemplate(); continue; }

        // Check for `import` keyword (word boundary before + after)
        if (source.startsWith("import", i)) {
          if (wordBefore() && wordAfter(6)) {
            advance(6); // skip "import"
            extractSpec();
            // extractSpec may have thrown; if not, continue scanning
            continue;
          }
        }

        // Check for `export` keyword (static re-export with `from`)
        if (source.startsWith("export", i)) {
          if (wordBefore() && wordAfter(6)) {
            advance(6); // skip "export"
            extractExportSpec();
            continue;
          }
        }

        advance();
        break;
      }

      case 1: // lineComment
        if (c === "\n") { state = 0; }
        advance();
        break;

      case 2: // blockComment
        if (c === "*" && peek(1) === "/") { state = 0; advance(2); }
        else advance();
        break;

      // States 3-5 are handled inline by skipString/skipTemplate above
      default:
        advance();
    }
  }
}

/**
 * Discover and validate all flow files in a directory.
 *
 * Validation order (lint-first, before execution):
 *  1. Read source, lint imports (state-machine scanner, no module execution)
 *  2. Only if lint passes → dynamically import the module
 *  3. Validate meta.description and run export
 *
 * @param {string} dir   – absolute path to scan (e.g. workflows/)
 * @returns {Promise<Array<{name: string, meta: object, run: Function, path: string}>>}
 */
export async function discoverFlows(rootDir) {
  const flows = [];
  const errors = [];

  /** Lint → import → validate one .mjs flow; register under `name`. */
  async function processFile(absPath, name) {
    const url = pathToFileURL(absPath).href;
    try {
      const source = await readFile(absPath, "utf-8");
      scanImports(source);
      const mod = await import(url);
      if (!mod.meta || typeof mod.meta.description !== "string" || !mod.meta.description.trim()) {
        throw new Error("must export meta.description (non-empty string)");
      }
      if (typeof mod.run !== "function") {
        throw new Error("must export async function run(ctx, input)");
      }
      flows.push({ name, meta: mod.meta, run: mod.run, path: absPath });
    } catch (err) {
      // P2-16:单个坏 flow 不再炸整列表——降级为 errors 条目,调用方决定是否警告。
      errors.push({ name, error: err.message });
    }
  }

  /**
   * Recursively walk `dir`, registering every *.mjs flow.
   * Flow name = path relative to rootDir, "/"-separated, minus ".mjs".
   * A "<sub>/index.mjs" registers under the directory name "<sub>"
   * (directory entry-point convention), so `/flow <sub>` runs the suite.
   * node_modules / dot-dirs never hold authored flows → skipped.
   */
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile() || extname(entry.name) !== ".mjs") continue;
      const rel = relative(rootDir, abs).split(sep).join("/");
      const name = rel.slice(0, -4).replace(/\/index$/, "");
      await processFile(abs, name);
    }
  }

  await walk(rootDir);
  return { flows, errors };
}

/**
 * Load and validate a single flow file by reference string.
 *
 * `ref` is resolved relative to `workflowsRoot`:
 *   - `"./child"`   → `workflowsRoot/child.mjs`
 *   - `"child"`     → `workflowsRoot/child.mjs`
 *   - `"sub/path"`  → `workflowsRoot/sub/path.mjs`
 *
 * The `.mjs` extension is appended automatically when absent.
 *
 * Validation follows the same pipeline as `discoverFlows`:
 *  1. Read source, lint imports
 *  2. Dynamic import
 *  3. Validate meta.description and run export
 *
 * @param {string} workflowsRoot – absolute path to the workflows directory
 * @param {string} ref           – flow reference (path relative to workflowsRoot)
 * @returns {Promise<{name: string, meta: object, run: Function, path: string}>}
 */
export async function loadFlow(workflowsRoot, ref) {
  // Resolve ref relative to workflowsRoot, strip leading ./ if present
  const cleanRef = ref.replace(/^\.\//, "");

  // Reject absolute paths — they bypass workflowsRoot containment
  if (cleanRef.startsWith("/")) {
    throw new Error(
      `loadFlow: absolute paths are not allowed — ref "${ref}" must be relative to workflowsRoot`,
    );
  }

  // Resolve to a file: prefer "<ref>.mjs"; fall back to the directory
  // entry-point "<ref>/index.mjs" so `runWorkflow(ctx, "superpowers")` and
  // `/flow superpowers` hit workflows/superpowers/index.mjs.
  let withExt;
  if (cleanRef.endsWith(".mjs")) {
    withExt = cleanRef;
  } else if (await isFile(resolve(workflowsRoot, `${cleanRef}.mjs`))) {
    withExt = `${cleanRef}.mjs`;
  } else if (await isFile(resolve(workflowsRoot, `${cleanRef}/index.mjs`))) {
    withExt = `${cleanRef}/index.mjs`;
  } else {
    withExt = `${cleanRef}.mjs`; // neither exists → readFile below reports not-found
  }
  const absPath = resolve(workflowsRoot, withExt);

  // Path-escape guard: resolved path must stay inside workflowsRoot
  const normalizedRoot = workflowsRoot.endsWith(sep)
    ? workflowsRoot
    : workflowsRoot + sep;
  if (absPath !== workflowsRoot && !absPath.startsWith(normalizedRoot)) {
    throw new Error(
      `loadFlow: path escape detected — "${ref}" resolves outside workflowsRoot (${absPath})`,
    );
  }

  // ── Realpath guard: reject symlinks that escape workflowsRoot ──
  // String containment (above) catches ../ and absolute paths fast.
  // realpath catches symlinks: a link inside root that points outside
  // would pass the string check but its canonical path is outside.
  let realRoot;
  try {
    realRoot = await realpath(workflowsRoot);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `loadFlow: workflowsRoot does not exist: ${workflowsRoot}`,
      );
    }
    throw err;
  }

  let realTarget;
  try {
    realTarget = await realpath(absPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // File doesn't exist — not a path escape.  readFile below will
    // surface a proper "not found" error.
  }

  if (realTarget !== undefined) {
    const realNormRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realTarget !== realRoot && !realTarget.startsWith(realNormRoot)) {
      throw new Error(
        `loadFlow: path escape detected — "${ref}" resolves to ${realTarget} which is outside workflowsRoot (${realRoot})`,
      );
    }
  }

  // Flow name = ref path minus .mjs; directory entry-point "<d>/index" → "<d>".
  const name = withExt.slice(0, -4).replace(/\/index$/, "");

  // ── 1. Read source + lint BEFORE any module execution ──────────
  const url = pathToFileURL(absPath).href;
  const source = await readFile(absPath, "utf-8");
  try {
    scanImports(source);
  } catch (lintErr) {
    throw new Error(`Flow "${name}": ${lintErr.message}`);
  }

  // ── 2. Lint passed — safe to import ────────────────────────────
  let mod;
  try {
    mod = await import(url);
  } catch (err) {
    throw new Error(
      `Flow "${name}": failed to load — ${err.message}`,
      { cause: err },
    );
  }

  // ── 3. Validate meta ───────────────────────────────────────────
  if (!mod.meta || typeof mod.meta.description !== "string" ||
    !mod.meta.description.trim()) {
    throw new Error(
      `Flow "${name}": must export meta.description (non-empty string)`,
    );
  }

  // ── 4. Validate run ────────────────────────────────────────────
  if (typeof mod.run !== "function") {
    throw new Error(
      `Flow "${name}": must export async function run(ctx, input)`,
    );
  }

  return { name, meta: mod.meta, run: mod.run, path: absPath };
}

// synod/src/control-marker.mjs — Control marker parser for agent orchestration.
//
// ## Grammar
//
// Agent control commands are carried in **labeled fenced blocks**:
//
//   ```synod <nonce>
//   {"cmd":"open","agent":"omp","task":"write hello"}
//   {"cmd":"send","to":"omp#1","msg":"what next?"}
//   ```
//
// ## Why fenced blocks?
//
// 1. **Critical FP#3 defense**: a bare `@@synod` line is structurally
//    indistinguishable from an agent quoting the marker syntax in prose.
//    A fenced block, by contrast, is a deliberate structural choice — an agent
//    casually mentioning syntax won't accidentally open one.
// 2. The fenced form is natural for multi-command turns and trivially
//    distinguishable from example code (outer regular fences take priority).
// 3. CommonMark fence rules (type + length tracking, 0-3 leading space
//    allowance for regular fences) prevent accidental closure from inner
//    ``` / ~~~ content.
//
// Rules:
// - Opener: 0-3 leading spaces, then 3+ backticks, then `synod <nonce>` as
//   the info string (after leading whitespace stripping from info).  Tilde
//   fences (~) are NOT control fences — only backtick.
// - Closer: 0-3 leading spaces, then same number of backticks (or more),
//   followed by whitespace only.
// - **Control fence opener MUST be at column 0** (no leading whitespace).
//   This prevents a control fence from accidentally firing when it appears
//   as content inside an indented regular fence (CommonMark allows regular
//   fences at up to 3 spaces of indent; control fences are stricter).
// - Body: each non-empty line is a single-line JSON command object.
// - `@@synod <nonce> {json}` bare lines are DEAD — they NEVER produce commands
//   regardless of nonce correctness.
//
// ## Residual risk (honest)
//
// If an agent is given the REAL nonce AND deliberately wraps a control fence
// around dummy JSON as a demonstration, it WILL trigger — this is a secret
// leakage / protocol boundary, not a grammar defect.  Analogous to: if you
// paste a real API key into a code block labelled as "example", the key is
// still real.  There is no grammatical way to distinguish "sincere control
// fence" from "insincere control fence using the real nonce" — the nonce IS
// the authorization.  This is accepted; same posture as "import whitelist is
// lint, not a security boundary."
//
// ## Command Schema
//
// ### open — Open a new agent session and enqueue a task.
//   {cmd: "open", agent: string, model?: string, task: string}
//
// ### send — Send a message to an existing agent session.
//   {cmd: "send", to: string, msg: string}
//
// ## Return Value
//
// extractControlCommands(text, { nonce }) → { commands: [...], warnings: [...] }
//
// - commands: Array of parsed command objects, in order of appearance,
//   deduplicated (identical JSON strings appear only once).
// - warnings: Array of {line, marker, reason} for lines that failed to parse
//   but did not halt processing.
//
// ## Nonce
//
// If { nonce } is provided, only control fences whose info string is exactly
// `synod <nonce>` are recognized.  If omitted, no control fences are
// recognized at all (defense in depth).

/**
 * Scan a complete turn text for control fences and return parsed commands.
 *
 * @param {string} text — Complete turn text (not a bare delta).
 * @param {object} [opts]
 * @param {string} [opts.nonce] — Per-turn authorization nonce.  If omitted,
 *   no control fences are recognized.
 * @returns {{ commands: object[], warnings: Array<{line: number, marker: string, reason: string}> }}
 */
export function extractControlCommands(text, { nonce } = {}) {
  if (!nonce) {
    return { commands: [], warnings: [] };
  }

  // Normalize line endings and strip BOM.
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = normalized.split("\n");
  const commands = [];
  const warnings = [];
  const seen = new Set();

  const expectedInfo = `synod ${nonce}`;

  let i = 0;
  while (i < lines.length) {
    const opener = parseFenceLine(lines[i]);
    if (!opener) {
      i++;
      continue;
    }

    // Control fence: backtick-only, column 0 (no indent), info string exact.
    const isControl =
      opener.char === "`" && opener.indent === 0 && opener.infoString === expectedInfo;

    if (isControl) {
      // Find closer.
      const closer = findCloser(lines, i + 1, opener.char, opener.count);

      if (closer > i) {
        // Parse body lines (i+1 .. closer-1).
        for (let j = i + 1; j < closer; j++) {
          const raw = lines[j];
          const trimmed = raw.trim();
          if (!trimmed) continue;

          // Deduplicate by the trimmed JSON line.
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);

          let obj;
          try {
            obj = JSON.parse(trimmed);
          } catch (err) {
            warnings.push({
              line: j + 1,
              marker: raw,
              reason: `invalid JSON: ${err.message}`,
            });
            continue;
          }

          const valErr = validateCommand(obj);
          if (valErr) {
            warnings.push({
              line: j + 1,
              marker: raw,
              reason: valErr,
            });
            continue;
          }

          commands.push(obj);
        }
      }
      // Skip past the closer (or past the opener if unclosed).
      i = closer > i ? closer + 1 : i + 1;
    } else {
      // Regular fence — skip to closer, body is ignored entirely.
      const closer = findCloser(lines, i + 1, opener.char, opener.count);
      i = closer > i ? closer + 1 : lines.length;
    }
  }

  return { commands, warnings };
}

/**
 * Parse a potential fence line (CommonMark rules: 0-3 leading spaces allowed).
 * @param {string} line
 * @returns {{ char: string, count: number, indent: number, infoString: string } | null}
 *   char       — fence character ('`' or '~')
 *   count      — consecutive count (must be ≥ 3)
 *   indent     — number of leading spaces (0-3)
 *   infoString — everything after the fence chars, trimmed
 */
function parseFenceLine(line) {
  // Count leading spaces (CommonMark: up to 3 allowed; 4+ is indented code).
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent++;
    else break;
  }
  if (indent > 3) return null; // indented code block, not a fence

  const c = line[indent];
  if (c !== "`" && c !== "~") return null;

  let count = 0;
  for (let i = indent; i < line.length; i++) {
    if (line[i] === c) count++;
    else break;
  }
  if (count < 3) return null;

  const infoString = line.slice(indent + count).trim();
  return { char: c, count, indent, infoString };
}

/**
 * Check whether a line is a valid closer for a fence of given type + count.
 *
 * @param {string} line
 * @param {string} char — fence character
 * @param {number} minCount — opener's backtick/tilde count
 * @returns {boolean}
 */
function isFenceCloser(line, char, minCount) {
  // Skip up to 3 leading spaces (CommonMark).
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent++;
    else break;
  }
  if (indent > 3) return false;

  let count = 0;
  for (let i = indent; i < line.length; i++) {
    if (line[i] === char) count++;
    else break;
  }
  if (count < minCount) return false;
  // Rest of line must be whitespace only (CommonMark).
  for (let i = indent + count; i < line.length; i++) {
    if (line[i] !== " " && line[i] !== "\t") return false;
  }
  return true;
}
/**
 * Find the closer for a fence starting after `startLine`.
 *
 * @param {string[]} lines
 * @param {number} startLine — index to start searching
 * @param {string} char
 * @param {number} minCount
 * @returns {number} line index of closer, or -1 if unclosed
 */
function findCloser(lines, startLine, char, minCount) {
  for (let j = startLine; j < lines.length; j++) {
    if (isFenceCloser(lines[j], char, minCount)) return j;
  }
  return -1;
}

// ── Command validation ───────────────────────────────────────────────────

const VALID_CMDS = new Set(["open", "send"]);

/**
 * Validate a parsed JSON object as a control command.
 *
 * @param {any} obj
 * @returns {string | null} error message, or null if valid
 */
function validateCommand(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    return "marker JSON must be a plain object";

  if (!obj.cmd)
    return "marker missing required 'cmd' field";

  if (!VALID_CMDS.has(obj.cmd))
    return `unknown cmd '${obj.cmd}'`;

  if (obj.cmd === "open") {
    if (!obj.agent || typeof obj.agent !== "string")
      return "'open' command requires string 'agent' field";
    if (!obj.task || typeof obj.task !== "string")
      return "'open' command requires string 'task' field";
  }

  if (obj.cmd === "send") {
    if (!obj.to || typeof obj.to !== "string")
      return "'send' command requires string 'to' field";
    if (!obj.msg || typeof obj.msg !== "string")
      return "'send' command requires string 'msg' field";
  }

  return null;
}

// synod/src/control-fence.mjs — Control fence parser (nonce-free, A1).
//
// Extracts REPL command lines from ```synod ``` fenced blocks in
// complete turn text.  Self-contained: includes its own CommonMark
// fence parser (parseFenceLine / isFenceCloser / findCloser), copied
// from control-marker.mjs.
//
// Exports:
//   extractFenceCommands(turnText) → { lines: string[], warnings: Array<...> }
//
// ## Grammar
//
//   Opener: column-0, 3+ backticks, info string exactly "synod" (after trim).
//   Closer: 0-3 leading spaces, same-or-more backticks, trailing whitespace only.
//   Body:   each non-empty line is a REPL command string (trimmed, deduplicated).
//
// ## R1 first-line gate
//
// The first non-empty line of the body must start with '/' or '@' at column 0
// (before trimming).  If it doesn't, the entire block is discarded with a warning.
// This prevents agent prose/commentary from being taken as commands.
//
// ## Nonce removal
//
// No nonce parameter.  Control fences are recognized when infoString === "synod".
// The nonce-based handshake (control-marker.mjs / control-wire.mjs) is severed
// here; A2 will thread an authorization mechanism if needed.

// ── CommonMark fence parser (copied from control-marker.mjs) ───────────────

/**
 * Parse a potential fence line (CommonMark rules: 0-3 leading spaces allowed).
 * @param {string} line
 * @returns {{ char: string, count: number, indent: number, infoString: string } | null}
 */
function parseFenceLine(line) {
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
 * Rest of line after fence chars must be whitespace only (CommonMark).
 */
function isFenceCloser(line, char, minCount) {
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
  for (let i = indent + count; i < line.length; i++) {
    if (line[i] !== " " && line[i] !== "\t") return false;
  }
  return true;
}

/**
 * Find closer for a fence starting after `startLine`.
 * @returns {number} line index of closer, or -1 if unclosed
 */
function findCloser(lines, startLine, char, minCount) {
  for (let j = startLine; j < lines.length; j++) {
    if (isFenceCloser(lines[j], char, minCount)) return j;
  }
  return -1;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Extract REPL command lines from ```synod ``` fenced blocks in complete turn text.
 *
 * @param {string} text — Complete turn text (not a bare delta).
 * @returns {{ lines: string[], warnings: Array<{line: number, marker: string, reason: string}> }}
 */
export function extractFenceCommands(text) {
  // Normalize line endings and strip BOM (same as control-marker).
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = [];
  const warnings = [];
  const seen = new Set();

  const rawLines = normalized.split("\n");

  let i = 0;
  while (i < rawLines.length) {
    const opener = parseFenceLine(rawLines[i]);
    if (!opener) {
      i++;
      continue;
    }

    // Control fence: backtick-only, column 0 (indent===0), info exactly "synod".
    // indent===0 is stricter than CommonMark's 0-3 for regular fences —
    // control fences must be at column 0 to avoid accidental triggering
    // inside indented outer regular fences.
    const isControl =
      opener.char === "`" &&
      opener.indent === 0 &&
      opener.infoString === "synod";

    if (isControl) {
      const closer = findCloser(rawLines, i + 1, opener.char, opener.count);

      if (closer > i) {
        // ── R1 first-line gate ──────────────────────────────────────
        // Find first non-empty line in body.  Use the RAW line
        // (with CRLF already stripped, but NOT trimmed) to check
        // that it starts with '/' or '@' at column 0.
        let firstLine = null;
        for (let j = i + 1; j < closer; j++) {
          if (rawLines[j].trim() !== "") {
            firstLine = rawLines[j];
            break;
          }
        }

        if (firstLine === null) {
          // Body all whitespace — no commands.
          // Fall through to skip past closer.
        } else if (firstLine[0] !== "/" && firstLine[0] !== "@") {
          // R1 gate failed — first non-empty line does not start with / or @.
          // Discard entire block.
          warnings.push({
            line: i + 1,
            marker: rawLines[i],
            reason: `首行非顶格命令: body first non-empty line must start with "/" or "@" at column 0, got "${firstLine.trim().slice(0, 40)}"`,
          });
        } else {
          // R1 passed — extract all non-empty trimmed lines.
          for (let j = i + 1; j < closer; j++) {
            const trimmed = rawLines[j].trim();
            if (!trimmed) continue;

            // Deduplicate by trimmed string, preserving first occurrence.
            if (seen.has(trimmed)) continue;
            seen.add(trimmed);

            lines.push(trimmed);
          }
        }
      }
      // Skip past closer (or past opener if unclosed).
      i = closer > i ? closer + 1 : i + 1;
    } else {
      // Regular fence — skip to closer, body is ignored entirely.
      const closer = findCloser(rawLines, i + 1, opener.char, opener.count);
      i = closer > i ? closer + 1 : rawLines.length;
    }
  }

  return { lines, warnings };
}

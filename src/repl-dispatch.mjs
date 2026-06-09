// synod/src/repl-dispatch.mjs — Extract REPL dispatch from cli.mjs onLine closure.
//
// Exports:
//   createReplDispatch({ sm, registry, stdout, stderr, defaultAgent })
//     → dispatch(line, { source = "human" } = {}) : { redraw: boolean, exit?: boolean }
//                                                      | Promise<{ redraw: boolean }>
//   parseOpenArgs(tokens) → { agent?, model?, effort?, write?, error? }
//
// dispatch() mirrors cli.mjs:357–496 exactly, replacing writePrompt()/closeRl() with
// return values { redraw, exit? }.  Only "human" source is implemented — "agent-fence"
// is reserved for A2.
//
// **All dispatch paths are synchronous except /open** (which must await sm.open()).
// This is intentional: /exit must run synchronously within the readline 'line' callback
// so that repl.closeRl() sets exitRequested=true before the next piped line fires.
// The onLine wrapper in cli.mjs checks `typeof r.then === "function"` for the /open path.
//
// Redraw truth table (A0 spec):
//   - /exit, /quit → { exit: true }      (no redraw)
//   - All other / commands → { redraw: true }
//   - @label (no space) → { redraw: true }    (stderr usage)
//   - @label (empty msg) → { redraw: true }
//   - @label msg (enqueue false) → { redraw: true }
//   - @label msg (enqueue success) → { redraw: false }
//   - Normal line (enqueue false) → { redraw: true }
//   - Normal line (enqueue success) → { redraw: false }

import { parseRelay } from "./relay.mjs";
import { AGENTS } from "./session-manager.mjs";

/**
 * Parse "/open --agent x --model y ..." into an options object.
 * Moved from cli.mjs lines 139–171.
 *
 * @param {string[]} tokens — already-split arguments (e.g. ["--agent","codex","--model","mini"])
 * @returns {{ agent?:string, model?:string, effort?:string, write?:boolean, error?:string }}
 */
export function parseOpenArgs(tokens) {
  const opts = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    switch (tok) {
      case "--agent":
      case "--model":
      case "--effort": {
        const v = tokens[++i];
        if (v === undefined || v.startsWith("--")) {
          return { error: `${tok} requires a value` };
        }
        if (tok === "--agent") {
          if (!AGENTS.includes(v)) {
            return { error: `--agent must be one of ${AGENTS.join(", ")} (got "${v}")` };
          }
          opts.agent = v;
        } else if (tok === "--model") {
          opts.model = v;
        } else {
          opts.effort = v;
        }
        break;
      }
      case "--write":
        opts.write = true;
        break;
      default:
        return { error: `Unknown option: ${tok}` };
    }
  }
  return opts;
}

/**
 * Create a dispatch function that processes REPL input lines.
 *
 * @param {object} deps
 * @param {object} deps.sm — session manager (must expose open, enqueue, use, list, _sessions)
 * @param {object} deps.registry — relay registry (must expose add, remove, list)
 * @param {{ write(s: string): void }} deps.stdout
 * @param {{ write(s: string): void }} deps.stderr
 * @param {string} deps.defaultAgent — agent name to use when /open doesn't specify --agent
 * @returns {function} dispatch(line, { source? } = {}) →
 *   { redraw: boolean, exit?: boolean } | Promise<{ redraw: boolean }>
 */
export function createReplDispatch({ sm, registry, stdout, stderr, defaultAgent }) {
  /**
   * Dispatch a single trimmed non-empty REPL line.
   *
   * All paths return synchronously ({redraw, exit?}) except /open which returns
   * a Promise<{redraw}>.  This keeps /exit synchronous so readline's piped-mode
   * line guard (exitRequested) works within the same tick.
   *
   * @param {string} line — already-trimmed non-empty command string
   * @param {{ source?: string }} [opts]
   * @param {"human"} [opts.source="human"] — source discriminator (only "human" implemented)
   * @returns {{ redraw: boolean, exit?: boolean } | Promise<{ redraw: boolean }>}
   */
  function dispatch(line, { source = "human" } = {}) {
    // ── / commands ────────────────────────────────────────────────
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);

      if (cmd === "/exit" || cmd === "/quit") {
        return { exit: true };
      }

      if (cmd === "/sessions") {
        sm.list();
        return { redraw: true };
      }

      if (cmd === "/relay") {
        const spec = rest.join(" ");
        const parsed = parseRelay(spec);
        if (parsed.error) {
          stderr.write(`${parsed.error}\n`);
          return { redraw: true };
        }
        if (!sm._sessions.has(parsed.from)) {
          stderr.write(`No session "${parsed.from}"\n`);
          return { redraw: true };
        }
        if (!sm._sessions.has(parsed.to)) {
          stderr.write(`No session "${parsed.to}"\n`);
          return { redraw: true };
        }
        try {
          registry.add(parsed.from, parsed.to);
          stdout.write(`Relay added: ${parsed.from} -> ${parsed.to}\n`);
        } catch (err) {
          stderr.write(`${err.message}\n`);
        }
        return { redraw: true };
      }

      if (cmd === "/unrelay") {
        const spec = rest.join(" ");
        const parsed = parseRelay(spec);
        if (parsed.error) {
          stderr.write(`${parsed.error}\n`);
        } else {
          registry.remove(parsed.from, parsed.to);
          stdout.write(`Relay removed: ${parsed.from} -> ${parsed.to}\n`);
        }
        return { redraw: true };
      }

      if (cmd === "/relays") {
        const rules = registry.list();
        if (rules.length === 0) {
          stdout.write("No active relay rules.\n");
        } else {
          stdout.write("Active relays:\n");
          for (const r of rules) {
            stdout.write(`  ${r.from} -> ${r.to}\n`);
          }
        }
        return { redraw: true };
      }

      if (cmd === "/use") {
        const target = rest[0];
        if (!target) {
          stderr.write("Usage: /use <label>\n");
        } else {
          const switched = sm.use(target);
          if (switched) stdout.write(`Switched to ${target}\n`);
        }
        return { redraw: true };
      }

      if (cmd === "/open") {
        const opts = parseOpenArgs(rest);
        if (opts.error) {
          stderr.write(`${opts.error}\n`);
          return { redraw: true };
        }

        const agent = opts.agent || defaultAgent;

        // Only async path: sm.open() returns a Promise.  Return a Promise
        // chain so the caller can hook redraw after session creation completes,
        // but the rest of the dispatch stays synchronous.
        return sm.open({
          agent,
          model: opts.model,
          effort: opts.effort,
          write: opts.write,
          announce: "interactive",
        }).then((label) => {
          if (!label) {
            // sm.open already wrote the error to stderr; just redraw prompt
          }
          return { redraw: true };
        });
      }

      // Unknown / command
      stderr.write(`Unknown command: ${cmd}\n`);
      return { redraw: true };
    }

    // ── @ directed messages ───────────────────────────────────────
    if (line.startsWith("@")) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) {
        stderr.write("Usage: @<label> <message> or @all <message>\n");
        return { redraw: true };
      }
      const target = line.slice(1, spaceIdx);
      const msg = line.slice(spaceIdx + 1).trim();
      if (!msg) {
        return { redraw: true };
      }

      const ok = sm.enqueue({ target, msg });
      if (ok === false) return { redraw: true };
      return { redraw: false };
    }

    // ── Normal line → current session ─────────────────────────────
    const ok = sm.enqueue({ msg: line });
    if (ok === false) return { redraw: true };
    return { redraw: false };
  }

  return dispatch;
}

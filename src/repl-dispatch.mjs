// synod/src/repl-dispatch.mjs — Extract REPL dispatch from cli.mjs onLine closure.
//
// Exports:
//   createReplDispatch({ sm, registry, stdout, stderr, defaultAgent, guardrails? })
//     → dispatch(line, { source?, depth? } = {})
//         source "human":
//            → { redraw: boolean, exit?: boolean } | Promise<{ redraw: boolean }>
//         source "agent-fence":
//            → { ok: boolean, label?: string, reason?: string }
//               | Promise<{ ok: boolean, label?: string, reason?: string }>
//   parseOpenArgs(tokens) → { agent?, model?, effort?, write?, error? }
//
// ## source: "human" (unchanged from A0)
//
// All paths return synchronously except /open.  This keeps /exit synchronous
// so readline's exitRequested guard works within the same tick.
//
// ## source: "agent-fence" (A2)
//
// Only /open, @specific-label, and /relay are allowed.  Everything else is
// rejected with {ok:false, reason}.  Guardrails (maxSessions, maxDepth,
// allowedAgents, allowedModels, allowWrite) apply to /open only.
// dispatch itself does not write streams — rejections/results go through
// return values.  (sm.open may still emit session-layer diagnostics to
// stderr on backend failure, same as human /open; that is not a dispatch
// write — see the /open branch note.)
//
// @all is explicitly disallowed (R4) — agent-fence messages must target
// a specific session label.

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

// ── Guardrails (migrated from control-dispatch._guard, adapted for /open opts) ─

function guardOpen({ agent, model, write }, depth, sm, g) {
  if (sm._sessions.size >= g.maxSessions) {
    return `max sessions (${g.maxSessions}) reached`;
  }
  if (depth >= g.maxDepth) {
    return `max depth (${g.maxDepth}) reached (current: ${depth})`;
  }
  if (g.allowedAgents && !g.allowedAgents.includes(agent)) {
    return `agent '${agent}' not in whitelist`;
  }
  if (model && g.allowedModels && !g.allowedModels.includes(model)) {
    return `model '${model}' not in whitelist`;
  }
  if (write === true && !g.allowWrite) {
    return "write requested but allowWrite is false";
  }
  return null;
}

// ── createReplDispatch ───────────────────────────────────────────────────

/**
 * Create a dispatch function that processes REPL input lines.
 *
 * @param {object} deps
 * @param {object} deps.sm
 * @param {object} deps.registry
 * @param {{ write(s: string): void }} deps.stdout
 * @param {{ write(s: string): void }} deps.stderr
 * @param {string} deps.defaultAgent
 * @param {object} [deps.guardrails] — only used for source "agent-fence"
 * @param {number} [deps.guardrails.maxSessions=Infinity]
 * @param {number} [deps.guardrails.maxDepth=Infinity]
 * @param {string[]} [deps.guardrails.allowedAgents=null]
 * @param {string[]} [deps.guardrails.allowedModels=null]
 * @param {boolean} [deps.guardrails.allowWrite=false]
 * @returns {function}
 */
export function createReplDispatch({ sm, registry, stdout, stderr, defaultAgent, guardrails }) {
  const g = {
    maxSessions: Infinity,
    maxDepth: Infinity,
    allowedAgents: null,
    allowedModels: null,
    allowWrite: false,
    ...guardrails,
  };

  /**
   * Dispatch a single trimmed non-empty REPL line.
   *
   * @param {string} line
   * @param {{ source?: string, depth?: number }} [opts]
   * @param {"human"|"agent-fence"} [opts.source="human"]
   * @param {number} [opts.depth=0] — current nesting depth (agent-fence only)
   * @returns {object|Promise<object>} return shape depends on source
   */
  function dispatch(line, { source = "human", depth = 0 } = {}) {
    if (source === "agent-fence") {
      return dispatchAgentFence(line, depth);
    }

    // ── Human path (unchanged) ─────────────────────────────────────
    return dispatchHuman(line);
  }

  // ── Human dispatch ─────────────────────────────────────────────────────

  function dispatchHuman(line) {
    // ── / commands ────────────────────────────────────────────────
    if (line.startsWith("/")) {
      return dispatchHumanSlash(line);
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

  function dispatchHumanSlash(line) {
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

      // Only async path in human mode.
      return sm.open({
        agent,
        model: opts.model,
        effort: opts.effort,
        write: opts.write,
        announce: "interactive",
      }).then(() => ({ redraw: true }));
    }

    // Unknown / command
    stderr.write(`Unknown command: ${cmd}\n`);
    return { redraw: true };
  }

  // ── Agent-fence dispatch ───────────────────────────────────────────────

  function dispatchAgentFence(line, depth) {
    // ── / commands ────────────────────────────────────────────────
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);

      if (cmd === "/open") {
        const opts = parseOpenArgs(rest);
        if (opts.error) {
          return { ok: false, reason: opts.error };
        }

        const agent = opts.agent || defaultAgent;

        // Guardrails check
        const guardErr = guardOpen(
          { agent, model: opts.model, write: opts.write },
          depth, sm, g,
        );
        if (guardErr) {
          return { ok: false, reason: guardErr };
        }

        // NOTE: dispatch itself writes no streams here.  If sm.open fails
        // (backend unavailable / start error), session-manager writes a
        // diagnostic to stderr — this is the same as human-mode /open, not
        // specific to agent-fence.  A3's wire layer should log the returned
        // reason (this branch returns {ok:false}) without duplicating the
        // session-layer stderr message.
        // Only async path in agent-fence mode.
        return sm.open({
          agent,
          model: opts.model,
          effort: opts.effort,
          write: opts.write,
          announce: false,
        }).then((label) => {
          if (!label) {
            return { ok: false, reason: "open failed" };
          }
          return { ok: true, label };
        });
      }

      if (cmd === "/relay") {
        const spec = rest.join(" ");
        const parsed = parseRelay(spec);
        if (parsed.error) {
          return { ok: false, reason: parsed.error };
        }
        if (!sm._sessions.has(parsed.from)) {
          return { ok: false, reason: `No session "${parsed.from}"` };
        }
        if (!sm._sessions.has(parsed.to)) {
          return { ok: false, reason: `No session "${parsed.to}"` };
        }
        try {
          registry.add(parsed.from, parsed.to);
        } catch (err) {
          return { ok: false, reason: err.message };
        }
        return { ok: true };
      }

      // All other / commands rejected (zero side-effect)
      return { ok: false, reason: `command not allowed in agent-fence: ${cmd}` };
    }

    // ── @ directed messages ───────────────────────────────────────
    if (line.startsWith("@")) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) {
        return { ok: false, reason: "missing message: @<label> <message>" };
      }
      const target = line.slice(1, spaceIdx);

      // Missing target label (e.g. "@ hi" → target="" → would route to current session)
      if (!target) {
        return { ok: false, reason: "missing target label" };
      }

      // R4: @all is not allowed in agent-fence
      if (target === "all") {
        return { ok: false, reason: "@all not allowed in agent-fence" };
      }

      const msg = line.slice(spaceIdx + 1).trim();
      if (!msg) {
        return { ok: false, reason: "empty message" };
      }

      const ok = sm.enqueue({ target, msg });
      if (ok === false) {
        return { ok: false, reason: `enqueue failed for target "${target}"` };
      }
      return { ok: true };
    }

    // ── Plain text (not a command) ────────────────────────────────
    return { ok: false, reason: "not a command" };
  }

  return dispatch;
}

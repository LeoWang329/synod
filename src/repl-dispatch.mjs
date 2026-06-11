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
// All paths return synchronously except /open and /flow (both return a
// Promise).  This keeps /exit synchronous so readline's exitRequested guard
// works within the same tick.
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

/**
 * Parse "/open --agent x --model y ..." into an options object.
 * Moved from cli.mjs lines 139–171.
 *
 * @param {string[]} tokens — already-split arguments (e.g. ["--agent","codex","--model","mini"])
 * @returns {{ profile?:string, agent?:string, model?:string, effort?:string, write?:boolean, error?:string }}
 */
export function parseOpenArgs(tokens) {
  const opts = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (i === 0 && tok.startsWith("+")) {
      const name = tok.slice(1);
      if (!name) return { error: "usage: /open +<profile> [overrides]" };
      opts.profile = name;
      continue;
    }
    switch (tok) {
      case "--agent":
      case "--model":
      case "--effort": {
        const v = tokens[++i];
        if (v === undefined || v.startsWith("--")) {
          return { error: `${tok} requires a value` };
        }
        if (tok === "--agent") {
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
      case "--mesh":
      case "--no-mesh": {
        // Tri-state: undefined (inherit session default) | true | false.
        // Conflicting flags in one command are rejected rather than last-wins,
        // so the caller gets explicit feedback instead of a silent surprise.
        const val = tok === "--mesh";
        if (opts.mesh !== undefined && opts.mesh !== val) {
          return { error: "--mesh and --no-mesh are mutually exclusive" };
        }
        opts.mesh = val;
        break;
      }
      default:
        return { error: `Unknown option: ${tok}` };
    }
  }
  return opts;
}

// ── Guardrails (migrated from control-dispatch._guard, adapted for /open opts) ─

// NOTE on mesh: there is deliberately no guard for `--mesh`/`--no-mesh` here.
// mesh confers no new wire authority — the host-side fence parser+dispatcher
// (wireControl) scans every child's turn text regardless of mesh, so a mesh-off
// child can still emit a dispatchable fence; mesh=true only controls whether the
// child is *told* the protocol via prompt injection.  The real risks — spawn
// amplification (fork-bomb) and write access — are bounded by maxDepth +
// maxSessions + allowWrite below, none of which mesh can bypass.  Gating mesh
// escalation would therefore be theater, not defense.
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
 * @param {(argv: string[]) => Promise<number>} [deps.runFlow] — flow-engine
 *   entry (flow.mjs main bound to this REPL's streams/backend/cwd).  Human-only;
 *   used by the /flow command.  If omitted, /flow reports it is unavailable.
 * @param {{ agents?: object }} [deps.config] — loaded synod config; agents map
 *   named profiles for `/open +<profile>`.  Defaults to no profiles.
 * @returns {function}
 */
export function createReplDispatch({ sm, registry, stdout, stderr, defaultAgent, guardrails, runFlow, config = { agents: {} } }) {
  const g = {
    maxSessions: Infinity,
    maxDepth: Infinity,
    allowedAgents: null,
    allowedModels: null,
    allowWrite: false,
    ...guardrails,
  };

  // Resolve a parsed /open opts object: if it names a +profile, look the profile
  // up in config.agents and merge (inline flags win over profile fields).  The
  // returned opts are what guardrails + sm.open see — so a profile cannot bypass
  // allowWrite/allowedAgents/allowedModels (the caller guards the RESOLVED opts).
  function resolveOpenOpts(opts) {
    if (!opts.profile) return { opts };
    const p = config?.agents?.[opts.profile];
    if (!p) return { error: `unknown profile "${opts.profile}"` };
    return {
      opts: {
        agent: opts.agent ?? p.backend,
        model: opts.model ?? p.model,
        effort: opts.effort ?? p.effort,
        write: opts.write ?? p.write,
        mesh: opts.mesh ?? p.mesh,
        systemPrompt: p.role,
      },
    };
  }

  const _runFlow = runFlow || (async () => {
    stderr.write("flow runner not available\n");
    return 1;
  });

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
      const parsed = parseOpenArgs(rest);
      if (parsed.error) {
        stderr.write(`${parsed.error}\n`);
        return { redraw: true };
      }
      const resolved = resolveOpenOpts(parsed);
      if (resolved.error) {
        stderr.write(`${resolved.error}\n`);
        return { redraw: true };
      }
      const o = resolved.opts;

      // Only async path in human mode.
      return sm.open({
        agent: o.agent || defaultAgent,
        model: o.model,
        effort: o.effort,
        write: o.write,
        mesh: o.mesh, // undefined → sm falls back to session default
        systemPrompt: o.systemPrompt,
        announce: "interactive",
      }).then(() => ({ redraw: true }));
    }

    if (cmd === "/flow") {
      // Everything after "/flow ": "<name> [input verbatim]".  Re-parse from
      // the raw line (not the whitespace-split `rest`) so JSON/string input
      // keeps its internal spacing.
      const afterCmd = line.slice(cmd.length).trim();
      if (!afterCmd) {
        // No name → list available flows (flow.mjs --list, pure, no agent).
        return _runFlow(["--list"]).then(() => ({ redraw: true }), () => ({ redraw: true }));
      }
      const m = afterCmd.match(/^(\S+)\s*([\s\S]*)$/);
      const name = m[1];
      const input = m[2];
      const argv = input ? ["--progress", "--", name, input] : ["--progress", name];
      stdout.write(`Running flow "${name}"...\n`);
      // flow.mjs main() prints the JSON result / errors to our streams itself.
      return _runFlow(argv).then(() => ({ redraw: true }), () => ({ redraw: true }));
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
        const parsed = parseOpenArgs(rest);
        if (parsed.error) {
          return { ok: false, reason: parsed.error };
        }
        const resolved = resolveOpenOpts(parsed);
        if (resolved.error) {
          return { ok: false, reason: resolved.error };
        }
        const o = resolved.opts;

        const agent = o.agent || defaultAgent;

        // Guardrails check the RESOLVED opts — a profile with write:true must be
        // rejected when allowWrite:false (a profile cannot bypass the fence).
        const guardErr = guardOpen(
          { agent, model: o.model, write: o.write },
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
          model: o.model,
          effort: o.effort,
          write: o.write,
          mesh: o.mesh, // undefined → sm falls back to session default
          systemPrompt: o.systemPrompt,
          announce: false,
          setCurrent: false,            // P1-9:fence 子会话不抢 human 当前会话
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

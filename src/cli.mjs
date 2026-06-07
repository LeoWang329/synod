#!/usr/bin/env node
// synod/src/cli.mjs — Multi-session streaming CLI.
//
// T3: extended from T2 single-session to multi-session with non-blocking sends,
// per-session line buffers (label-prefixed, newline-split), REPL routing
// (/open, /use, /sessions, @label, @all), --task non-interactive mode,
// and SIGINT cleanup.  Single-session flow is a natural subset of the same
// code paths.

import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { doctor, openBackend as realOpenBackend } from "./backend.mjs";
import { createSessionManager, createLineBuffer, checkAgentAvailable, AGENTS } from "./session-manager.mjs";
import { parseRelay, createRelayRegistry } from "./relay.mjs";

// ── CLI parsing ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    agent: "omp",
    model: undefined,
    effort: undefined,
    write: false,
    tasks: [],
    _unknown: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    switch (tok) {
      case "--agent": {
        const v = argv[++i];
        if (!v || v.startsWith("--")) {
          out._unknown = `${tok} requires a value (${AGENTS.join("|")})`;
          return out;
        }
        if (!AGENTS.includes(v)) {
          out._unknown = `--agent value must be one of ${AGENTS.join(", ")} (got "${v}")`;
          return out;
        }
        out.agent = v;
        break;
      }
      case "--model": {
        const v = argv[++i];
        if (!v || v.startsWith("--")) {
          out._unknown = `${tok} requires a value`;
          return out;
        }
        out.model = v;
        break;
      }
      case "--effort": {
        const v = argv[++i];
        if (!v || v.startsWith("--")) {
          out._unknown = `${tok} requires a value`;
          return out;
        }
        out.effort = v;
        break;
      }
      case "--write":
        out.write = true;
        break;
      case "--task": {
        const v = argv[++i];
        if (!v || v.startsWith("--")) {
          out._unknown = `${tok} requires a value (e.g. --task omp:"hello world")`;
          return out;
        }
        const colonIdx = v.indexOf(":");
        if (colonIdx === -1) {
          out._unknown = `${tok} value must contain ":" (e.g. --task omp:"hello")`;
          return out;
        }
        const agent = v.slice(0, colonIdx);
        const prompt = v.slice(colonIdx + 1);
        if (!AGENTS.includes(agent)) {
          out._unknown = `--task agent must be one of ${AGENTS.join(", ")} (got "${agent}")`;
          return out;
        }
        if (!prompt.trim()) {
          out._unknown = `--task prompt must not be empty`;
          return out;
        }
        out.tasks.push({ agent, prompt: prompt.trim() });
        break;
      }
      case "--help":
      case "-h":
        out._help = true;
        break;
      default:
        out._unknown = `unrecognized argument: ${tok}`;
        return out;
    }
  }
  return out;
}

function printHelp(stdout = process.stdout) {
  stdout.write(
    [
      "synod — streaming CLI (multi-session)",
      "",
      "Usage:",
      "  node src/cli.mjs [options]              Interactive REPL",
      "  node src/cli.mjs --task <agent>:<msg>   Non-interactive (repeatable)",
      "",
      "Options:",
      "  --agent <omp|codex>   Agent backend (default: omp)",
      "  --model <M>           Model id (e.g. minimax-code-cn/MiniMax-M3)",
      "  --effort <E>          Reasoning effort (omp, e.g. high/xhigh)",
      "  --write               Allow file writes (default: read-only)",
      "  --task <agent>:<msg>  Run task non-interactively (repeatable)",
      "  -h, --help            Show this help",
      "",
      "REPL commands:",
      "  /open [--agent A] [--model M] [--effort E] [--write]   New session",
      "  /use <label>          Switch current session",
      "  /sessions             List all sessions",
      "  @<label> <msg>        Send to a session",
      "  @all <msg>            Broadcast to all sessions",
      "  /relay <from>-><to>   Forward source turn text to target",
      "  /unrelay <from>-><to> Remove a relay rule",
      "  /relays               List active relay rules",
      "  /exit, /quit          Close all sessions and quit",
      "  Ctrl-D (EOF)          Same as /exit",
      "",
    ].join("\n"),
  );
}

/** Parse "/open --agent x --model y ..." into an options object.
 *  @param {string[]} tokens — already-split arguments (e.g. ["--agent","codex","--model","mini"])
 *  @returns {{ agent?:string, model?:string, effort?:string, write?:boolean, error?:string }}
 */
function parseOpenArgs(tokens) {
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

// ── REPL ─────────────────────────────────────────────────────────────
function createRepl({ prompt, onLine, onClose, stdin = process.stdin, stdout = process.stdout }) {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY ?? false,
  });
  // Start paused so piped input isn't consumed before sessions are ready.
  rl.pause();
  let exitRequested = false;
  let closed = false;

  rl.on("line", (line) => {
    if (exitRequested) return;
    const text = line.trim();
    if (!text) {
      stdout.write(prompt);
      return;
    }
    void onLine(text);
  });

  rl.on("close", () => {
    if (closed) return;
    closed = true;
    void onClose();
  });

  return {
    resume() { rl.resume(); },
    writePrompt() {
      if (!exitRequested && !closed) stdout.write(prompt);
    },
    closeRl() {
      exitRequested = true;
      rl.close();
    },
  };
}

// ── Non-interactive task runner ──────────────────────────────────────
async function runTasks(tasks, report, baseOpts, { openBackend, stdout = process.stdout, stderr = process.stderr } = {}) {
  // Pre-check all agents (before opening sessions, so return 3 vs 4 is distinct)
  for (const task of tasks) {
    if (!checkAgentAvailable(task.agent, report, stderr)) return 3;
  }

  const sm = createSessionManager({
    openBackend, stdout, stderr, report,
    cwd: baseOpts.cwd,
    defaults: { model: baseOpts.model, effort: baseOpts.effort, write: baseOpts.write },
    onIdle: () => {}, // no prompt redraw in non-interactive mode
  });

  // Wire module-level SIGINT to these sessions
  gSessions = sm._sessions;

  try {
    // Open sessions sequentially
    const taskMap = new Map(); // label → task
    for (const task of tasks) {
      const label = await sm.open({ agent: task.agent, announce: "task" });
      if (!label) {
        sm.closeAll();
        return 4;
      }
      taskMap.set(label, task);
    }

    // Enqueue all tasks via per-session send queues (serial within session, parallel across)
    const sendResults = [];
    for (const [label, task] of taskMap) {
      const p = sm.enqueue({ target: label, msg: task.prompt });
      if (p) sendResults.push({ label, promise: p });
    }

    // Drain all queues (waits for every turn to complete)
    await sm.drainAll();

    // Flush any remaining buffered text
    sm.flushAll();

    // Collect per-task results
    const settled = await Promise.allSettled(sendResults.map((r) => r.promise));
    const taskResults = sendResults.map((r, i) => ({
      label: r.label,
      ok: settled[i].status === "fulfilled",
      reason: settled[i].status === "rejected" ? (settled[i].reason?.message ?? String(settled[i].reason)) : null,
    }));

    // Summary
    const anyFailed = taskResults.some((r) => !r.ok);
    stdout.write("\n── Summary ──\n");
    for (const [label, info] of sm.entries()) {
      const sum = info.session.summary();
      const res = await info.session.result();
      const preview = (res.text || "").slice(0, 200).replace(/\n/g, " ");
      const tr = taskResults.find((r) => r.label === label);
      const outcome = tr?.ok !== false ? "" : " [FAILED]";
      stdout.write(
        `[${label}] ${sum.agent} | ${sum.model || "default"} | effort=${sum.effort || "default"} | ${sum.status}${outcome}\n`,
      );
      if (preview) stdout.write(`  ${preview}\n`);
      if (tr?.reason) stdout.write(`  error: ${tr.reason}\n`);
    }

    return anyFailed ? 1 : 0;

  } finally {
    sm.closeAll();
    gSessions = null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main({
  openBackend = realOpenBackend,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  argv = process.argv,
} = {}) {
  const args = parseArgs(argv.slice(2));
  if (args._help) {
    printHelp(stdout);
    return 0;
  }
  if (args._unknown) {
    stderr.write(`synod: ${args._unknown}\n`);
    stderr.write('Run "node src/cli.mjs --help" for usage.\n');
    return 2;
  }

  const report = doctor();
  const cwd = path.resolve(process.cwd());

  // ── Non-interactive ────────────────────────────────────────────────
  if (args.tasks.length > 0) {
    return runTasks(args.tasks, report, { model: args.model, effort: args.effort, write: args.write, cwd }, { openBackend, stdout, stderr });
  }

  // ── Interactive mode ───────────────────────────────────────────────

  // ── Exit gate ──────────────────────────────────────────────────────
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  // Create repl reference first so onIdle callback can reference repl.writePrompt
  let repl;

  // ── Relay registry (two-phase: created before sm, enqueue wired after) ──
  let _smForRelay = null;
  const registry = createRelayRegistry((to, msg) => {
    if (_smForRelay) _smForRelay.enqueue({ target: to, msg });
  });

  const sm = createSessionManager({
    openBackend, stdout, stderr, report, cwd,
    defaults: { model: args.model, effort: args.effort, write: args.write },
    onIdle: (label) => {
      if (repl && label === sm.currentLabel) repl.writePrompt();
    },
    errorLeadingNewline: true,
    onTurnComplete: (label, result) => registry.onTurnComplete(label, result.text),
  });
  _smForRelay = sm;

  // Wire module-level SIGINT handler to these sessions
  gSessions = sm._sessions;

  // ── REPL dispatch ──────────────────────────────────────────────────
  repl = createRepl({
    prompt: "> ",
    stdin,
    stdout,
    onLine: async (line) => {
      // ── / commands ────────────────────────────────────────────────
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.split(/\s+/);

        if (cmd === "/exit" || cmd === "/quit") {
          repl.closeRl();
          return;
        }

        if (cmd === "/sessions") {
          sm.list();
          repl.writePrompt();
          return;
        }

        if (cmd === "/relay") {
          const spec = rest.join(" ");
          const parsed = parseRelay(spec);
          if (parsed.error) {
            stderr.write(`${parsed.error}\n`);
            repl.writePrompt();
            return;
          }
          // Validate both labels exist
          if (!sm._sessions.has(parsed.from)) {
            stderr.write(`No session "${parsed.from}"\n`);
            repl.writePrompt();
            return;
          }
          if (!sm._sessions.has(parsed.to)) {
            stderr.write(`No session "${parsed.to}"\n`);
            repl.writePrompt();
            return;
          }
          try {
            registry.add(parsed.from, parsed.to);
            stdout.write(`Relay added: ${parsed.from} -> ${parsed.to}\n`);
          } catch (err) {
            stderr.write(`${err.message}\n`);
          }
          repl.writePrompt();
          return;
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
          repl.writePrompt();
          return;
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
          repl.writePrompt();
          return;
        }

        if (cmd === "/use") {
          const target = rest[0];
          if (!target) {
            stderr.write("Usage: /use <label>\n");
          } else {
            const switched = sm.use(target);
            if (switched) stdout.write(`Switched to ${target}\n`);
          }
          repl.writePrompt();
          return;
        }

        if (cmd === "/open") {
          const opts = parseOpenArgs(rest);
          if (opts.error) {
            stderr.write(`${opts.error}\n`);
            repl.writePrompt();
            return;
          }

          const agent = opts.agent || args.agent;

          const label = await sm.open({
            agent,
            model: opts.model,
            effort: opts.effort,
            write: opts.write,
            announce: "interactive",
          });
          if (!label) {
            // sm.open already wrote the error to stderr; just redraw prompt
          }
          repl.writePrompt();
          return;
        }

        stderr.write(`Unknown command: ${cmd}\n`);
        repl.writePrompt();
        return;
      }

      // ── @ directed messages ───────────────────────────────────────
      if (line.startsWith("@")) {
        const spaceIdx = line.indexOf(" ");
        if (spaceIdx === -1) {
          stderr.write("Usage: @<label> <message> or @all <message>\n");
          repl.writePrompt();
          return;
        }
        const target = line.slice(1, spaceIdx);
        const msg = line.slice(spaceIdx + 1).trim();
        if (!msg) {
          repl.writePrompt();
          return;
        }

        const ok = sm.enqueue({ target, msg });
        if (ok === false) repl.writePrompt();
        // Don't redraw prompt — streaming output follows asynchronously;
        // the status handler will redraw when the turn finishes.
        return;
      }

      // ── Normal line → current session ─────────────────────────────
      const ok = sm.enqueue({ msg: line });
      if (ok === false) repl.writePrompt();
      // Don't redraw prompt — status handler will when turn finishes.
    },

    onClose: async () => {
      let exitCode = 0;
      try {
        await sm.drainAll();
      } catch (err) {
        exitCode = 1;
        stderr.write(`synod: ${err.stack || err.message}\n`);
      } finally {
        // Clean up relay rules for all sessions being closed
        for (const [label] of sm._sessions) {
          registry.removeForLabel(label);
        }
        // Flush any trailing buffered text
        sm.flushAll();
        sm.closeAll();
        gSessions = null;
        resolveExit(exitCode);
      }
    },
  });

  // ── Open default session ───────────────────────────────────────────
  // Created *after* repl so the status handler can reference repl.writePrompt.
  const defaultLabel = await sm.open({ agent: args.agent, announce: false });
  if (!defaultLabel) return 3;

  repl.resume();
  repl.writePrompt();

  return await exitPromise;
}

let gSessions = null;

// ── Run guard: only execute main + register handlers when this file is the entry point ──
const _isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (_isMain) {
  // ── Module-level SIGINT ──────────────────────────────────────────────
  let gSigintCount = 0;

  process.on("SIGINT", () => {
    gSigintCount += 1;

    const sessions = gSessions;
    if (!sessions || sessions.size === 0) {
      process.exit(0);
      return;
    }

    if (gSigintCount > 1) {
      process.stderr.write("\nForce exiting...\n");
      // closeAllSessions moved to session-manager; inline the logic
      for (const [, info] of sessions) {
        try { info.session.close(); } catch {}
      }
      process.exit(1);
    }

    process.stderr.write("\nInterrupted. Cleaning up...\n");

    (async () => {
      const ABORT_TIMEOUT_MS = 3000;
      const abortPromises = [];
      for (const [, info] of sessions) {
        abortPromises.push(
          Promise.race([
            (async () => { try { await info.session.abort(); } catch {} })(),
            new Promise((r) => setTimeout(r, ABORT_TIMEOUT_MS)),
          ]),
        );
      }
      try {
        await Promise.all(abortPromises);
      } catch {}
      for (const [, info] of sessions) {
        try { info.session.close(); } catch {}
      }
      process.exit(0);
    })();
  });

  // ── Error handlers ───────────────────────────────────────────────────
  process.on("uncaughtException", (err) => {
    process.stderr.write(`synod: uncaught: ${err.stack || err.message}\n`);
    process.exit(1);
  });

  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`synod: fatal: ${err.stack || err.message}\n`);
      process.exit(1);
    });
}

export { main, parseArgs, createLineBuffer, parseOpenArgs, AGENTS };

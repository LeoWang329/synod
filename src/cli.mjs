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
import { doctor, openBackend } from "./backend.mjs";

// ── CLI parsing ──────────────────────────────────────────────────────
const AGENTS = ["omp", "codex"];

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

function printHelp() {
  process.stdout.write(
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
      "  /exit, /quit          Close all sessions and quit",
      "  Ctrl-D (EOF)          Same as /exit",
      "",
    ].join("\n"),
  );
}

// ── Doctor gate ──────────────────────────────────────────────────────
function envHint(agent) {
  return agent === "omp" ? "OMP_BIN" : "CODEX_BIN";
}

function checkAgentAvailable(agent, report) {
  const entry = report[agent];
  if (!entry) {
    process.stderr.write(
      `synod: unknown agent "${agent}". Available: ${AGENTS.join(", ")}.\n`,
    );
    return false;
  }
  if (entry.available) return true;
  process.stderr.write(
    [
      `synod: agent "${agent}" is not available.`,
      `  - probed: ${process.env[envHint(agent)] || agent}`,
      `  - install it, or point ${envHint(agent)} at the real binary.`,
      "",
    ].join("\n"),
  );
  return false;
}

// ── Session helpers ──────────────────────────────────────────────────
const agentCounters = { omp: 0, codex: 0 };

function allocLabel(agent) {
  agentCounters[agent] = (agentCounters[agent] || 0) + 1;
  return `${agent}#${agentCounters[agent]}`;
}

/**
 * Create a line buffer that accumulates deltas and emits complete lines
 * prefixed with [label].  Incomplete trailing text stays in the buffer
 * until flush() is called (on idle).
 */
function createLineBuffer(label) {
  let buf = "";
  return {
    feed(chunk) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = /** @type {string} */ (lines.pop());
      for (const line of lines) {
        process.stdout.write(`[${label}] ${line}\n`);
      }
    },
    flush() {
      if (buf.length > 0) {
        process.stdout.write(`[${label}] ${buf}\n`);
        buf = "";
      }
    },
  };
}

async function openSession({ agent, model, effort, write, cwd, report }) {
  if (!checkAgentAvailable(agent, report)) return null;
  try {
    return await openBackend({ agent, cwd, write, model, effort });
  } catch (err) {
    process.stderr.write(`synod: failed to open ${agent} session: ${err.message}\n`);
    return null;
  }
}


/**
 * Per-session FIFO send queue: ensures turns within a single session are
 * serialised (each turn completes before the next starts), while different
 * sessions still run in parallel.  Uses send(wait:true) so the backend's
 * own turn-started / waitIdle gating protects against stale idle windows.
 */
function createSendQueue(session) {
  let chain = Promise.resolve();
  return {
    /** Enqueue a message; returns a Promise that resolves when the turn
     *  completes (or rejects on send error).  The chain itself survives
     *  rejections so later messages still get sent. */
    enqueue(msg) {
      const task = chain.then(() => session.send(msg, { wait: true }));
      chain = task.catch(() => {});
      return task;
    },
    /** Resolves when every queued send has settled (success or error). */
    drain() { return chain; },
  };
}


function closeAllSessions(sessions) {
  for (const [, info] of sessions) {
    try { info.session.close(); } catch {}
  }
}

function listSessions(sessions, currentLabel) {
  process.stdout.write("\n");
  for (const [label, info] of sessions) {
    const marker = label === currentLabel ? "*" : " ";
    const sum = info.session.summary();
    process.stdout.write(
      ` ${marker} ${label}  ${sum.agent}  ${sum.model || "default"}  ${sum.status}\n`,
    );
  }
  process.stdout.write("\n");
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
function createRepl({ prompt, onLine, onClose }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });
  // Start paused so piped input isn't consumed before sessions are ready.
  rl.pause();
  let exitRequested = false;
  let closed = false;

  rl.on("line", (line) => {
    if (exitRequested) return;
    const text = line.trim();
    if (!text) {
      process.stdout.write(prompt);
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
      if (!exitRequested && !closed) process.stdout.write(prompt);
    },
    closeRl() {
      exitRequested = true;
      rl.close();
    },
  };
}

// ── Non-interactive task runner ──────────────────────────────────────
async function runTasks(tasks, report, baseOpts) {
  const sessions = new Map(); // label → { session, agent, lineBuf, task }

  // Pre-check all agents
  for (const task of tasks) {
    if (!checkAgentAvailable(task.agent, report)) return 3;
  }

  // Wire module-level SIGINT to these sessions
  gSessions = sessions;

  try {
    // Open sessions sequentially
    for (const task of tasks) {
      const label = allocLabel(task.agent);
      process.stderr.write(`Opening ${label} (${task.agent})...\n`);
      const session = await openSession({
        agent: task.agent,
        model: baseOpts.model,
        effort: baseOpts.effort,
        write: baseOpts.write,
        cwd: baseOpts.cwd,
        report,
      });
      if (!session) {
        closeAllSessions(sessions);
        return 4;
      }

      const lineBuf = createLineBuffer(label);
      session.on("delta", (chunk) => lineBuf.feed(chunk));
      session.on("error", (err) => {
        process.stderr.write(`[${label} error] ${err.message}\n`);
      });
      session.on("status", ({ status }) => {
        if (status === "idle") lineBuf.flush();
      });

      sessions.set(label, { session, agent: task.agent, lineBuf, task, sendQueue: createSendQueue(session) });
    }

    // Enqueue all tasks via per-session send queues (serial within session, parallel across)
    const sendResults = [];
    for (const [label, info] of sessions) {
      const p = info.sendQueue.enqueue(info.task.prompt);
      sendResults.push({ label, promise: p });
      p.catch((err) => {
        process.stderr.write(`[${label} send error] ${err.message}\n`);
      });
    }

    // Drain all queues (waits for every turn to complete)
    const drains = [];
    for (const [, info] of sessions) {
      drains.push(info.sendQueue.drain());
    }
    await Promise.all(drains);

    // Flush any remaining buffered text
    for (const [, info] of sessions) {
      info.lineBuf.flush();
    }

    // Collect per-task results
    const settled = await Promise.allSettled(sendResults.map((r) => r.promise));
    const taskResults = sendResults.map((r, i) => ({
      label: r.label,
      ok: settled[i].status === "fulfilled",
      reason: settled[i].status === "rejected" ? (settled[i].reason?.message ?? String(settled[i].reason)) : null,
    }));

    // Summary
    const anyFailed = taskResults.some((r) => !r.ok);
    process.stdout.write("\n── Summary ──\n");
    for (const [label, info] of sessions) {
      const sum = info.session.summary();
      const res = await info.session.result();
      const preview = (res.text || "").slice(0, 200).replace(/\n/g, " ");
      const tr = taskResults.find((r) => r.label === label);
      const outcome = tr?.ok !== false ? "" : " [FAILED]";
      process.stdout.write(
        `[${label}] ${sum.agent} | ${sum.model || "default"} | ${sum.status}${outcome}\n`,
      );
      if (preview) process.stdout.write(`  ${preview}\n`);
      if (tr?.reason) process.stdout.write(`  error: ${tr.reason}\n`);
    }

    return anyFailed ? 1 : 0;

  } finally {
    closeAllSessions(sessions);
    gSessions = null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._help) {
    printHelp();
    return 0;
  }
  if (args._unknown) {
    process.stderr.write(`synod: ${args._unknown}\n`);
    process.stderr.write('Run "node src/cli.mjs --help" for usage.\n');
    return 2;
  }

  const report = doctor();
  const cwd = path.resolve(process.cwd());

  // ── Non-interactive ────────────────────────────────────────────────
  if (args.tasks.length > 0) {
    return runTasks(args.tasks, report, { model: args.model, effort: args.effort, write: args.write, cwd });
  }

  // ── Interactive mode ───────────────────────────────────────────────
  const sessions = new Map(); // label → { session, agent, model, effort, lineBuf }
  let currentLabel = null;

  // Wire module-level SIGINT handler to these sessions
  gSessions = sessions;

  // ── Exit gate ──────────────────────────────────────────────────────
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  // ── REPL dispatch ──────────────────────────────────────────────────
  const repl = createRepl({
    prompt: "> ",
    onLine: async (line) => {
      // ── / commands ────────────────────────────────────────────────
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.split(/\s+/);

        if (cmd === "/exit" || cmd === "/quit") {
          repl.closeRl();
          return;
        }

        if (cmd === "/sessions") {
          listSessions(sessions, currentLabel);
          repl.writePrompt();
          return;
        }

        if (cmd === "/use") {
          const target = rest[0];
          if (!target) {
            process.stderr.write("Usage: /use <label>\n");
          } else if (sessions.has(target)) {
            currentLabel = target;
            process.stdout.write(`Switched to ${target}\n`);
          } else {
            process.stderr.write(`No session "${target}"\n`);
          }
          repl.writePrompt();
          return;
        }

        if (cmd === "/open") {
          const opts = parseOpenArgs(rest);
          if (opts.error) {
            process.stderr.write(`${opts.error}\n`);
            repl.writePrompt();
            return;
          }

          const agent = opts.agent || args.agent;

          if (!AGENTS.includes(agent)) {
            process.stderr.write(`Unknown agent: ${agent}\n`);
            repl.writePrompt();
            return;
          }
          if (!checkAgentAvailable(agent, report)) {
            repl.writePrompt();
            return;
          }

          const label = allocLabel(agent);
          process.stdout.write(`Opening ${label} (${agent})...\n`);

          const session = await openSession({
            agent,
            model: opts.model ?? args.model,
            effort: opts.effort ?? args.effort,
            write: opts.write ?? args.write,
            cwd,
            report,
          });
          if (!session) {
            repl.writePrompt();
            return;
          }

          const lineBuf = createLineBuffer(label);
          session.on("delta", (chunk) => lineBuf.feed(chunk));
          session.on("error", (err) => {
            process.stderr.write(`\n[${label} error] ${err.message}\n`);
          });
          // Status handler: flush on idle, redraw prompt if current.
          session.on("status", ({ status }) => {
            if (status === "idle") {
              lineBuf.flush();
              if (label === currentLabel) repl.writePrompt();
            }
          });

          sessions.set(label, {
            session,
            agent,
            model: opts.model ?? args.model,
            effort: opts.effort ?? args.effort,
            lineBuf,
            sendQueue: createSendQueue(session),
          });
          currentLabel = label;
          process.stdout.write(`Opened ${label} (${agent})\n`);
          repl.writePrompt();
          return;
        }

        process.stderr.write(`Unknown command: ${cmd}\n`);
        repl.writePrompt();
        return;
      }

      // ── @ directed messages ───────────────────────────────────────
      if (line.startsWith("@")) {
        const spaceIdx = line.indexOf(" ");
        if (spaceIdx === -1) {
          process.stderr.write("Usage: @<label> <message> or @all <message>\n");
          repl.writePrompt();
          return;
        }
        const target = line.slice(1, spaceIdx);
        const msg = line.slice(spaceIdx + 1).trim();
        if (!msg) {
          repl.writePrompt();
          return;
        }

        if (target === "all") {
          for (const [label, info] of sessions) {
            info.sendQueue.enqueue(msg).catch((err) => {
              process.stderr.write(`\n[${label} send error] ${err.message}\n`);
            });
          }
        } else {
          const info = sessions.get(target);
          if (!info) {
            process.stderr.write(`No session "${target}"\n`);
            repl.writePrompt();
            return;
          }
          info.sendQueue.enqueue(msg).catch((err) => {
            process.stderr.write(`\n[${target} send error] ${err.message}\n`);
          });
        }
        // Don't redraw prompt — streaming output follows asynchronously;
        // the status handler will redraw when the turn finishes.
        return;
      }

      // ── Normal line → current session ─────────────────────────────
      const info = sessions.get(currentLabel);
      if (!info) {
        process.stderr.write("No current session. Use /open to create one.\n");
        repl.writePrompt();
        return;
      }
      info.sendQueue.enqueue(line).catch((err) => {
        process.stderr.write(`\n[${currentLabel} send error] ${err.message}\n`);
      });
      // Don't redraw prompt — status handler will when turn finishes.
    },

    onClose: async () => {
      // Drain every session's send queue (waits for all queued turns to complete)
      for (const [, info] of sessions) {
        try { await info.sendQueue.drain(); } catch {}
      }
      // Flush any trailing buffered text
      for (const [, info] of sessions) {
        info.lineBuf.flush();
      }
      closeAllSessions(sessions);
      gSessions = null;
      resolveExit(0);
    },
  });

  // ── Open default session ───────────────────────────────────────────
  // Created *after* repl so the status handler can reference repl.writePrompt.
  const defaultLabel = allocLabel(args.agent);
  {
    const session = await openSession({
      agent: args.agent,
      model: args.model,
      effort: args.effort,
      write: args.write,
      cwd,
      report,
    });
    if (!session) return 3;

    const lineBuf = createLineBuffer(defaultLabel);
    session.on("delta", (chunk) => lineBuf.feed(chunk));
    session.on("error", (err) => {
      process.stderr.write(`\n[${defaultLabel} error] ${err.message}\n`);
    });
    session.on("status", ({ status }) => {
      if (status === "idle") {
        lineBuf.flush();
        if (defaultLabel === currentLabel) repl.writePrompt();
      }
    });

    sessions.set(defaultLabel, {
      session,
      agent: args.agent,
      model: args.model,
      effort: args.effort,
      lineBuf,
      sendQueue: createSendQueue(session),
    });
    currentLabel = defaultLabel;
  }
  repl.resume();
  repl.writePrompt();

  return await exitPromise;
}

// ── Module-level SIGINT ──────────────────────────────────────────────
let gSessions = null;
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
    // Best-effort close before forced exit (no waiting)
    closeAllSessions(sessions);
    process.exit(1);
  }

  process.stderr.write("\nInterrupted. Cleaning up...\n");

  // Async cleanup: abort all concurrently (each with a timeout),
  // then unconditionally close all sessions before exiting.
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
    } catch {} // shouldn't happen with the timeout guard, but belt-and-suspenders
    closeAllSessions(sessions);
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

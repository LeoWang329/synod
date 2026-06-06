#!/usr/bin/env node
// synod/src/cli.mjs — Streaming CLI (single-session MVP).
//
// T3 will extend this file into a multi-session router; we deliberately keep
// the surface narrow here (one session, one REPL loop) so the T3 pass can swap
// the per-session state for a Map<label, session> without rewriting parsing or
// I/O plumbing.

import path from "node:path";
import readline from "node:readline";
import { doctor, openBackend } from "./backend.mjs";

// ── CLI parsing ──────────────────────────────────────────────────────
// Zero-dep arg parser. We keep flags and their values in declaration order so
// the unknown-flag error message points at the offending token verbatim.
const AGENTS = ["omp", "codex"];

function parseArgs(argv) {
  const out = {
    agent: "omp",
    model: undefined,
    effort: undefined,
    write: false,
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
      "synod — streaming CLI (single-session MVP)",
      "",
      "Usage: node src/cli.mjs [options]",
      "",
      "Options:",
      "  --agent <omp|codex>   Agent backend (default: omp)",
      "  --model <M>           Model id (provider-qualified, e.g. minimax-code-cn/MiniMax-M3)",
      "  --effort <E>          Reasoning effort (omp, e.g. high/xhigh)",
      "  --write               Allow file writes (default: read-only)",
      "  -h, --help            Show this help",
      "",
      "REPL commands:",
      "  /exit                 Close the session and quit",
      "  Ctrl-D (EOF)          Same as /exit",
      "",
    ].join("\n"),
  );
}

// ── Doctor gate ──────────────────────────────────────────────────────
// F1/A4: refuse to even try opening a session when the agent is missing.
// We echo the exact env var the user can set, plus the path we probed, so
// the failure is actionable in one read.
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

// ── REPL loop ────────────────────────────────────────────────────────
// One readline, one session, one drainer. Lines are enqueued (never dropped
// while a turn is in flight); a single async drainer pulls them one at a
// time and waits for status→idle before pulling the next. EOF (rl 'close')
// sets a "drain then exit" flag so queued lines still get answered, but
// no new lines are accepted after rl closes. /exit and /quit are routed
// through the same shutdown path: they never tear down a streaming turn.
function createRepl({ prompt, onLine, onClose }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });
  const queue = [];
  let draining = false;
  let exitRequested = false;
  let eofSeen = false;
  let onCloseInvoked = false;

  const fireCloseOnce = () => {
    if (onCloseInvoked) return;
    onCloseInvoked = true;
    void onClose();
  };

  const writePrompt = () => {
    if (queue.length === 0 && !draining) process.stdout.write(prompt);
  };

  // Start the drainer (idempotent). Pulls one line at a time, awaits onLine
  // (which dispatches the turn and resolves when status→idle), then loops.
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const line = queue.shift();
        if (line === "/exit" || line === "/quit") {
          // Drop anything queued after an explicit exit; let the caller
          // shut down the session once the current turn is idle.
          queue.length = 0;
          exitRequested = true;
          fireCloseOnce();
          return;
        }
        await onLine(line);
        // After each turn: if exit was requested mid-drain, stop.
        if (exitRequested) return;
      }
      // Queue empty. If EOF already arrived, fold it into a shutdown now.
      if (eofSeen) fireCloseOnce();
    } finally {
      draining = false;
    }
  };

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      // Blank line: just redraw the prompt if we're idle.
      if (queue.length === 0 && !draining) process.stdout.write(prompt);
      return;
    }
    queue.push(text);
    void drain();
  });

  // Single canonical EOF path. Fires on Ctrl-D, piped stdin end, and when
 // we explicitly rl.close() from the exit path — in every case we want to
 // drain queued lines, then let the caller close the session and exit.
  rl.on("close", () => {
    eofSeen = true;
    void drain();
    // If the drainer had nothing to do (queue empty, no turn in flight),
    // drain() will call fireCloseOnce() synchronously-ish; otherwise it
    // fires after the last queued turn returns to idle.
    if (queue.length === 0 && !draining) fireCloseOnce();
  });

  return {
    enqueueExit() {
      queue.push("/exit");
      void drain();
    },
    writePrompt,
    closeRl() {
      rl.close();
    },
  };
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
  if (!checkAgentAvailable(args.agent, report)) return 3;

  let session;
  try {
    session = await openBackend({
      agent: args.agent,
      cwd: path.resolve(process.cwd()),
      write: args.write,
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
    });
  } catch (err) {
    process.stderr.write(`synod: failed to open ${args.agent} session: ${err.message}\n`);
    return 4;
  }

  // F3: stream deltas to stdout, errors to stderr without crashing the process.
  session.on("delta", (chunk) => process.stdout.write(chunk));
  session.on("error", (err) => {
    process.stderr.write(`\n[session error] ${err.message}\n`);
  });

  // ── Turn-done signal ────────────────────────────────────────────────
  // session.send(..., { wait: true }) is the primary serialization point:
  // it blocks until the proc's state() reports idle and the queued-message
  // count is zero, so by the time it returns every delta for the turn has
  // been emitted. turnDone is a belt-and-suspenders second channel: the
  // status listener resolves it on the first idle event after a turn
  // starts, in case a late delta arrives after waitIdle would have
  // released (a real race we observed with the streaming CLI).
  let resolveTurn = null;
  const newTurnPromise = () =>
    new Promise((resolve) => {
      resolveTurn = resolve;
    });

  // Main resolution: closed exactly once, by the canonical shutdown path.
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let sessionClosed = false;
  const closeSession = () => {
    if (sessionClosed) return;
    sessionClosed = true;
    try {
      session.close();
    } catch {}
  };

  // F3/A3: drive prompt redraws and the turn-done signal from status.
  session.on("status", ({ status, isStreaming }) => {
    if (status === "idle" && !isStreaming) {
      process.stdout.write("\n");
      repl.writePrompt();
      const r = resolveTurn;
      resolveTurn = null;
      r?.();
    } else if (status === "failed" || status === "closed") {
      process.stdout.write(`\n[session ${status}]\n`);
      // If a turn was in flight, unblock it so the drainer can finish
      // (or the shutdown path can proceed).
      const r = resolveTurn;
      resolveTurn = null;
      r?.();
    }
  });

  const repl = createRepl({
    prompt: "> ",
    onLine: async (line) => {
      let turnDone;
      try {
        turnDone = newTurnPromise();
        // wait: true makes session.send resolve only when the turn fully
        // returns to idle (via waitIdle polling state). This is what
        // serializes turns in the drainer: each await onLine is
        // "send, then wait for the answer to land, including any
        // deltas emitted during the turn".
        await session.send(line, { wait: true });
      } catch (err) {
        process.stderr.write(`\n[send error] ${err.message}\n`);
        // Unblock the drainer even when send threw (session might be
        // already closed and no status event will fire).
        const r = resolveTurn;
        resolveTurn = null;
        r?.();
        return;
      }
      // Belt-and-suspenders: also wait for the explicit idle status event
      // so a late delta emitted after turn_end still lands before we
      // pull the next line. turnDone is resolved by the status listener
      // on the first idle after this turn's send; if it was already
      // resolved (e.g. waitIdle returned first), this is a no-op.
      await turnDone;
    },
    onClose: async () => {
      // Single graceful shutdown path. If a turn is in flight, it has
      // already been dispatched via session.send and will return to idle
      // on its own — we just need to wait for the status→idle event the
      // listener above uses to resolve resolveTurn. If we're already
      // idle, this resolves on the next microtask.
      if (resolveTurn) {
        await new Promise((r) => {
          const prev = resolveTurn;
          resolveTurn = () => {
            prev();
            r();
          };
        });
      }
      closeSession();
      resolveExit(0);
    },
  });

  repl.writePrompt();

  return await exitPromise;
}

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

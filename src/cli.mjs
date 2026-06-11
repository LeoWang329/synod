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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { doctor, openBackend as realOpenBackend } from "./backend.mjs";
import { createSessionManager, createLineBuffer, checkAgentAvailable } from "./session-manager.mjs";
import { backendNames } from "./backends/registry.mjs";
import { createRelayRegistry } from "./relay.mjs";
import { wireControl } from "./control-wire.mjs";
import { createReplDispatch, parseOpenArgs } from "./repl-dispatch.mjs";
import { loadConfig, registerConfigBackends } from "./config.mjs";
import { main as flowMain } from "./flow.mjs";
import { installShutdownHandlers, closeAllLiveSessionsSync } from "./shutdown.mjs";

// ── CLI parsing ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    agent: "omp",
    model: undefined,
    effort: undefined,
    write: false,
    mesh: undefined, // tri-state: undefined → fall back to SYNOD_MESH env (see main())
    tasks: [],
    reap: false,
    _unknown: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    switch (tok) {
      case "--agent": {
        const v = argv[++i];
        if (!v || v.startsWith("--")) {
          out._unknown = `${tok} requires a value`;
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
      case "--reap":
        out.reap = true;
        break;
      case "--mesh":
        // Mirror parseOpenArgs: reject a conflicting flag, allow idempotent repeat.
        if (out.mesh === false) {
          out._unknown = "--mesh and --no-mesh are mutually exclusive";
          return out;
        }
        out.mesh = true;
        break;
      case "--no-mesh":
        if (out.mesh === true) {
          out._unknown = "--mesh and --no-mesh are mutually exclusive";
          return out;
        }
        out.mesh = false;
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

/**
 * Read mesh flag from environment.  Only "1" and "true" are truthy.
 * @param {object} env — typically process.env or an overridden map
 * @returns {boolean}
 */
export function meshFromEnv(env) {
  const v = env.SYNOD_MESH;
  return v === "1" || v === "true";
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
      "  --reap                Kill orphaned agent processes from crashed runs, then exit",
      "  --task <agent>:<msg>  Run task non-interactively (repeatable)",
      "  --mesh                Inject orchestration skill into spawned agents (default: off)",
      "  --no-mesh             Force mesh off, overriding the SYNOD_MESH env var",
      "  -h, --help            Show this help",
      "",
      "REPL commands:",
      "  /open [--agent A] [--model M] [--effort E] [--write] [--mesh|--no-mesh]   New session",
      "  /use <label>          Switch current session",
      "  /sessions             List all sessions",
      "  @<label> <msg>        Send to a session",
      "  @all <msg>            Broadcast to all sessions",
      "  /relay <from>-><to>   Forward source turn text to target",
      "  /unrelay <from>-><to> Remove a relay rule",
      "  /relays               List active relay rules",
      "  /flow [<name> [input]] Run a workflow (omit name to list available)",
      "  /exit, /quit          Close all sessions and quit",
      "  Ctrl-D (EOF)          Same as /exit",
      "",
    ].join("\n"),
  );
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
    defaults: { model: baseOpts.model, effort: baseOpts.effort, write: baseOpts.write, mesh: baseOpts.mesh },
    onIdle: () => {}, // no prompt redraw in non-interactive mode
  });

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
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main({
  openBackend = realOpenBackend,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  argv = process.argv,
  env = process.env,
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

  if (args.reap) {
    const { reapOrphans } = await import("./pid-registry.mjs");
    const r = reapOrphans({ stderr });
    stdout.write(
      `reap: scanned ${r.scanned}, reaped ${r.reaped.length}, skipped ${r.skipped.length}` +
      `${r.unsupported ? " (win32: unsupported)" : ""}\n`,
    );
    return 0;
  }

  // Load layered config (~/.synod/config.mjs + ./synod.config.mjs) and register
  // its backends BEFORE doctor(), so config-declared backends are first-class
  // (visible to doctor + --agent validation).  fail-fast on config errors.
  let config;
  try {
    config = await loadConfig({ cwd: path.resolve(process.cwd()), home: env.SYNOD_HOME || undefined });
    await registerConfigBackends(config);
  } catch (err) {
    stderr.write(`synod: ${err.message}\n`);
    return 2;
  }

  const report = doctor();
  const names = backendNames();
  if (!names.includes(args.agent)) {
    stderr.write(`synod: --agent must be one of ${names.join(", ")} (got "${args.agent}")\n`);
    return 2;
  }
  for (const t of args.tasks) {
    if (!names.includes(t.agent)) {
      stderr.write(`synod: --task agent must be one of ${names.join(", ")} (got "${t.agent}")\n`);
      return 2;
    }
  }
  const cwd = path.resolve(process.cwd());
  // Precedence: explicit --mesh/--no-mesh (true/false) > SYNOD_MESH env > off.
  // `??` (not `||`) so an explicit --no-mesh (false) overrides the env instead
  // of falling through to it.
  const mesh = args.mesh ?? meshFromEnv(env);

  // ── Non-interactive ────────────────────────────────────────────────
  if (args.tasks.length > 0) {
    return runTasks(args.tasks, report, { model: args.model, effort: args.effort, write: args.write, mesh, cwd }, { openBackend, stdout, stderr });
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

  // ── Control channel (two-phase: composed onTurnComplete set after sm exists) ──
  let _composedOnTurnComplete = null;

  const sm = createSessionManager({
    openBackend, stdout, stderr, report, cwd,
    defaults: { model: args.model, effort: args.effort, write: args.write, mesh },
    onIdle: (label) => {
      if (repl && label === sm.currentLabel) repl.writePrompt();
    },
    errorLeadingNewline: true,
    onTurnComplete: (label, result) => {
      if (_composedOnTurnComplete) _composedOnTurnComplete(label, result);
    },
  });
  _smForRelay = sm;

  // ── Flow engine bridge (human-only /flow command) ──────────────────────
  // Resolve flows from the synod package's workflows/ dir (not the launch cwd),
  // so /flow works regardless of where synod was started; agents still run in
  // `cwd`.  Track in-flight runs so onClose can await them — a flow dropped on
  // /exit would orphan its agent sessions (violates the no-residue invariant).
  const flowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
  const _pendingFlows = new Set();
  const runFlow = (flowArgv) => {
    const p = flowMain({ argv: flowArgv, stdout, stderr, openBackend, workflowsRoot: flowsRoot, cwd });
    _pendingFlows.add(p);
    p.finally(() => _pendingFlows.delete(p)).catch(() => {});
    return p;
  };

  // ── REPL dispatch (created before wireControl so it can be passed in) ──
  const dispatch = createReplDispatch({
    sm, registry, stdout, stderr,
    defaultAgent: args.agent,
    guardrails: { maxSessions: 10, maxDepth: 3, allowWrite: false },
    runFlow,
    config,
  });

  const { onTurnComplete: composedOnTurnComplete } = wireControl({
    sm, registry, stderr, dispatch,
  });
  _composedOnTurnComplete = composedOnTurnComplete;
  repl = createRepl({
    prompt: "> ",
    stdin,
    stdout,
    // onLine is synchronous: dispatch() returns synchronously for all commands
    // except /open (which returns a Promise).  Keeping /exit synchronous is
    // critical for piped stdin — closeRl() must run before the next 'line' event.
    onLine: (line) => {
      const r = dispatch(line, { source: "human" });
      if (r && typeof r.then === "function") {
        r.then((res) => { if (res.redraw) repl.writePrompt(); });
      } else if (r.exit) {
        repl.closeRl();
      } else if (r.redraw) {
        repl.writePrompt();
      }
    },

    onClose: async () => {
      let exitCode = 0;
      try {
        // Let any in-flight /flow runs finish first so they tear down their own
        // agent sessions (otherwise /exit would orphan them).
        if (_pendingFlows.size > 0) {
          await Promise.allSettled([..._pendingFlows]);
        }
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

// ── Run guard: only execute main + register handlers when this file is the entry point ──
// realpath both sides so symlinked installs (npm link / npm i -g) still match:
// the bin shim passes the *link* path as argv[1] while Node resolves import.meta.url
// to the *real* path — comparing raw strings would silently skip main().
function isEntrypoint(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(metaUrl);
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    return self === path.resolve(entry);
  }
}
const _isMain = isEntrypoint(import.meta.url);

if (_isMain) {
  installShutdownHandlers({ interactiveSigint: true });
  // 启动顺扫:收割上次崩溃残留的孤儿(尽力而为,绝不阻断启动)。
  // 显式 `--reap` 命令例外:那条路径在 main() 里独占收割并打印准确摘要,
  // 此处再扫会抢先把孤儿收掉、令命令摘要失真为 reaped=0。
  if (!process.argv.includes("--reap")) {
    import("./pid-registry.mjs")
      .then(({ reapOrphans }) => { try { reapOrphans({ stderr: process.stderr }); } catch {} })
      .catch(() => {});
  }

  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`synod: fatal: ${err.stack || err.message}\n`);
      closeAllLiveSessionsSync();
      process.exit(1);
    });
}

export { main, parseArgs, createLineBuffer, parseOpenArgs };

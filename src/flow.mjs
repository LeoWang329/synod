#!/usr/bin/env node
/**
 * src/flow.mjs — Flow engine CLI entry point.
 *
 * Usage:
 *   node src/flow.mjs <name> [input]    Run a flow by name.
 *   node src/flow.mjs --list            List available flows.
 *   node src/flow.mjs --help            Print this help.
 *
 * Options:
 *   --workflows <path>   Workflows directory (default: ./workflows).
 *   --list               List flow names and descriptions (no agent needed).
 *   --progress           Stream agent deltas to stdout (also SYNOD_PROGRESS=1).
 *
 * Input is parsed as JSON if possible, otherwise kept as a raw string.
 * When no input is given, the flow receives `undefined`.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./flow/runtime.mjs";
import { discoverFlows, loadFlow } from "./flow/loader.mjs";
import { runFlow } from "./flow/runner.mjs";
import { writeCheckpoint, isAwaitingHuman } from "./flow/checkpoint.mjs";
import { openBackend } from "./backend.mjs";
import { installShutdownHandlers, closeAllLiveSessionsSync } from "./shutdown.mjs";
import { createRunWorkspace, scanResidualWorktrees } from "./run-workspace.mjs";

// ── CLI parsing ──────────────────────────────────────────────────────────

/**
 * parseFlowArgs(argv) — pure function, no side effects.
 *
 * @param {string[]} argv — typically process.argv.slice(2)
 * @returns {{
 *   list: boolean,
 *   name: string | null,
 *   input: string | null,
 *   workflowsRoot: string | null,
 *   _help: boolean,
 *   _error: string | null,
 * }}
 */
export function parseFlowArgs(argv) {
  const out = {
    list: false,
    progress: false,
    headless: false,
    name: null,
    input: null,
    workflowsRoot: null,
    _help: false,
    _error: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--list":
        out.list = true;
        break;
      case "--progress":
        out.progress = true;
        break;
      case "--headless":
        out.headless = true;
        break;
      case "--workflows": {
        const v = argv[++i];
        if (!v || v.startsWith("--")) {
          out._error = "--workflows requires a path";
          return out;
        }
        out.workflowsRoot = v;
        break;
      }
      case "--": {
        // P2-45:`--` 之后全部按位置参数(name, input),不再做 flag 匹配——
        // 让 input 为 --list/--workflows 等也能原样传给 flow。
        for (i += 1; i < argv.length; i += 1) {
          const t = argv[i];
          if (out.name === null) out.name = t;
          else if (out.input === null) out.input = t;
          else { out._error = `unexpected argument: ${t}`; return out; }
        }
        return out;
      }
      case "--help":
      case "-h":
        out._help = true;
        break;
      default: {
        if (tok.startsWith("-") && out.name === null) {
          out._error = `unrecognized option: ${tok}`;
          return out;
        }
        if (out.name === null) {
          out.name = tok;
        } else if (out.input === null) {
          out.input = tok;
        } else {
          out._error = `unexpected argument: ${tok}`;
          return out;
        }
      }
    }
  }

  return out;
}
function printHelp(stdout) {
  stdout.write(
    "Usage: node src/flow.mjs <name> [input]\n" +
    "       node src/flow.mjs --list\n" +
    "\n" +
    "Options:\n" +
    "  --workflows <path>  Workflows directory (default: ./workflows).\n" +
    "  --list              List flow names and descriptions (pure, no agent).\n" +
    "  --progress          Stream agent deltas to stdout with [agent:model] prefix.\n" +
    "                      Also enabled by SYNOD_PROGRESS=1.\n" +
    "  --help, -h          Print this help.\n" +
    "\n" +
    "Input is JSON-parsed if valid; otherwise treated as a raw string.\n" +
    "When no input is given, the flow receives undefined.\n",
  );
}

// ── Progress sink ─────────────────────────────────────────────────────────

/**
 * Create the default stdout progress sink.
 *
 * Writes to stdout with `[agent:model]` prefix, one prefix per line.  No line
 * buffering (qa-loop is serial; YAGNI).  `opening`/`start` break any dangling
 * line so each agent's turn begins fresh (matters on reuse, where no `opening`
 * fires).  `end` is silent.
 *
 * @param {NodeJS.WritableStream} stdout
 * @returns {{ emit: (event: object) => void }}
 */
export function createDefaultProgressSink(stdout) {
  let atLineStart = true;
  // Close a dangling (newline-less) line from the previous agent so the next
  // one starts on its own prefixed line.  No-op if already at line start.
  const freshLine = () => {
    if (!atLineStart) {
      stdout.write("\n");
      atLineStart = true;
    }
  };
  return {
    emit(event) {
      const label = event.model ? `${event.agent}:${event.model}` : event.agent;
      if (event.type === "opening") {
        freshLine();
        stdout.write(`[${label}] opening...\n`);
        atLineStart = true;
      } else if (event.type === "start") {
        // Fires on EVERY send (incl. reuse, where no "opening" runs).  Just
        // break a dangling line; the prefix is written lazily by first delta.
        freshLine();
      } else if (event.type === "delta" && event.text) {
        const t = event.text;
        let out = "";
        let i = 0;
        while (i < t.length) {
          if (atLineStart) {
            out += `[${label}] `;
            atLineStart = false;
          }
          const nl = t.indexOf("\n", i);
          if (nl === -1) {
            out += t.slice(i);
            break;
          }
          out += t.slice(i, nl + 1);
          atLineStart = true;
          i = nl + 1;
        }
        if (out) stdout.write(out);
      }
    },
  };
}

// ── Input parsing ────────────────────────────────────────────────────────

/**
 * Parse user-supplied input string.
 * Tries JSON.parse; falls back to raw string if that fails.
 * Returns undefined for null/undefined input.
 *
 * @param {string | null | undefined} raw
 * @returns {*} parsed value or raw string
 */
function parseInput(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// per-run latest 指针:POSIX 用 symlink `latest`→<runId>;win32 symlink 常无权限,
// 显式降级写 latest.txt(纯文本指针),不静默坏。
async function writeLatestPointer(runsRoot, runId) {
  const { symlink, unlink, writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(runsRoot, { recursive: true }).catch(() => {});
  const link = resolve(runsRoot, "latest");
  try {
    await unlink(link).catch(() => {});
    await symlink(runId, link, "dir");
  } catch {
    await writeFile(resolve(runsRoot, "latest.txt"), runId + "\n");
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * main(opts) — injectable entry point.
 *
 * All dependencies are injectable so the function is testable without
 * spawning a real process or hitting real backends.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]            — CLI args (default: process.argv.slice(2))
 * @param {object} [opts.stdout]            — writable stream (default: process.stdout)
 * @param {object} [opts.stderr]            — writable stream (default: process.stderr)
 * @param {Function} [opts.openBackend]     — backend factory (default: real openBackend)
 * @param {string} [opts.workflowsRoot]     — default workflows dir (default: ./workflows)
 * @param {string} [opts.cwd]               — working directory (default: process.cwd())
 * @param {object} [opts.config]            — pre-loaded+registered config; when given,
 *                                            skip loadConfig/registerConfigBackends
 *                                            (caller already registered, e.g. REPL /flow)
 * @returns {Promise<number>} exit code (0, 1, or 2)
 */
export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  openBackend: ob = openBackend,
  workflowsRoot: defaultRoot = resolve(process.cwd(), "workflows"),
  cwd = process.cwd(),
  config: injectedConfig,
  // Shared I/O + run-level abort, injected by the REPL (cli.mjs /flow) so flow
  // approve()/question() route through the single InputRouter and a CLI Ctrl-C
  // can cancel the run.  Standalone flow.mjs leaves these undefined → runtime
  // falls back to defaultIo() (its own readline) and no external signal.
  io: injectedIo,
  signal: externalSignal,
  // Inject real fs by default; tests pass a noop/in-memory sink
  fs: realFs = { writeFile, appendFile, mkdir },
  runsRoot: runsRootOpt,
  // resume: { runId, input, steps } — injected by `synod resume` / REPL /resume
  resume,
  headless: injectedHeadless,
} = {}) {
  const args = parseFlowArgs(argv);
  const headless = injectedHeadless ?? args.headless;

  if (args._error) {
    stderr.write(`Error: ${args._error}\n`);
    return 2;
  }

  if (args._help) {
    printHelp(stdout);
    return 0;
  }

  const root = args.workflowsRoot ? resolve(cwd, args.workflowsRoot) : defaultRoot;

  // Load config (needed by both --list and run for config.flows; injectedConfig
  // bypasses load). When a caller (e.g. cli.mjs REPL /flow) already loaded +
  // registered the config in this process, it injects `config` so we must NOT
  // register again (registerConfigBackends throws on already-registered names).
  // registerConfigBackends is deferred to the run path: --list must stay
  // "pure, no agent" — importing a (possibly broken) module backend just to
  // list flow names would violate that contract.
  let config = injectedConfig;
  let _needsRegister = false;
  if (!config) {
    try {
      const { loadConfig } = await import("./config.mjs");
      config = await loadConfig({ cwd, home: process.env.SYNOD_HOME || undefined });
      _needsRegister = true;
    } catch (err) {
      stderr.write(`Error: ${err.message}\n`);
      return 1;
    }
  }

  // ── --list ─────────────────────────────────────────────────────────
  if (args.list) {
    // Scan both the default/overridden root and any config.flows directories.
    // First occurrence of a name wins (root takes priority over config.flows).
    const searchRoots = [root, ...((config && config.flows) || [])];
    const allFlows = [];
    const allErrors = [];
    const seen = new Set();
    for (const r of searchRoots) {
      let result;
      try { result = await discoverFlows(r); }
      catch (err) { stderr.write(`Error: failed to discover flows in ${r}: ${err.message}\n`); return 1; }
      for (const f of result.flows) {
        if (!seen.has(f.name)) { seen.add(f.name); allFlows.push(f); }
      }
      for (const e of result.errors) allErrors.push(e);
    }
    for (const f of allFlows) stdout.write(`${f.name}: ${f.meta.description}\n`);
    for (const e of allErrors) stderr.write(`warning: flow "${e.name}" skipped: ${e.error}\n`);
    return 0;
  }

  // Run path only: register config-declared backends now. Deferred from above so
  // that --list stays pure (a broken module backend must not break listing).
  if (_needsRegister) {
    try {
      const { registerConfigBackends } = await import("./config.mjs");
      await registerConfigBackends(config);
    } catch (err) {
      stderr.write(`Error: ${err.message}\n`);
      return 1;
    }
  }

  // ── <name> ─────────────────────────────────────────────────────────
  if (!args.name) {
    stderr.write("Error: flow name required (or use --list to see available flows)\n");
    return 2;
  }

  const flowInput = resume ? resume.input : parseInput(args.input);

  // ── Progress sink ───────────────────────────────────────────────────
  const progressEnabled = args.progress || process.env.SYNOD_PROGRESS === "1";
  const progressSink = progressEnabled ? createDefaultProgressSink(stdout) : undefined;

  // per-run 目录由 logger 的 ensureRunDir 负责;不再在 cwd 建 artifacts。
  // SYNOD_HOME 对齐:cli.mjs --runs 也用 SYNOD_HOME,两者必须一致(A3)。
  const runsRoot = runsRootOpt ?? resolve(process.env.SYNOD_HOME || os.homedir(), ".synod", "runs");

  const worktreesRoot = resolve(os.homedir(), ".synod", "worktrees");
  const runWorkspace = createRunWorkspace({ cwd, worktreesRoot, runsRoot });

  // Build runtime with real dependencies
  let runtime;
  try {
    runtime = createRuntime({
      openBackend: ob,
      workflowsRoot: root,
      clock: () => Date.now(),
      fs: realFs,
      progress: progressSink,
      config,
      io: injectedIo,             // REPL injects the shared router io; standalone → defaultIo()
      signal: externalSignal,     // CLI Ctrl-C link; standalone → undefined
      runsRoot,
      headless,
      replay: resume ? { runId: resume.runId, steps: resume.steps } : undefined,
      runWorkspace,
    });
  } catch (err) {
    stderr.write(`Error: failed to create runtime: ${err.message}\n`);
    return 1;
  }

  // P2-26:run 路径直接 loadFlow(命中即用,不再 discoverFlows 执行所有 flow 顶层代码)。
  // 搜索顺序:--workflows/默认 root → config.flows 指定的各目录。
  const searchRoots = [root, ...((config && config.flows) || [])];
  let flow = null;
  for (const r of searchRoots) {
    try { flow = await loadFlow(r, args.name); break; } catch { /* 下一个目录 */ }
  }
  if (!flow) {
    stderr.write(`Error: flow "${args.name}" not found in ${searchRoots.join(", ")}\n`);
    return 1;
  }

  // Create context and run
  const ctx = runtime.createCtx(flowInput, { cwd, runId: resume?.runId });
  await writeLatestPointer(runsRoot, ctx.runId).catch(() => {});
  // Write initial `running` checkpoint so the run is discoverable even after a hard kill
  try { writeCheckpoint(runsRoot, ctx.runId, { flowName: args.name, input: flowInput, cwd, status: "running" }); } catch { /* best-effort */ }
  let result, runErr;
  try {
    result = await runFlow(runtime, flow, ctx, flowInput);
  } catch (err) {
    runErr = err;
  }

  // ── RunWorkspace 收尾:合回起始分支,冲突留人并打印清单 ──
  const wsr = await runtime.finalizeWorkspaces(ctx);
  if (wsr.merged?.length) {
    stdout.write(`\n[workspace] merged: ${wsr.merged.join(", ")}\n`);
  }
  if (wsr.conflicts?.length) {
    stderr.write(`\n[workspace] ${wsr.conflicts.length} conflict(s) left for you:\n`);
    for (const c of wsr.conflicts) {
      stderr.write(`  - branch ${c.branch}\n    worktree: ${c.path}\n    files: ${c.files.join(", ") || "(see git status)"}\n`);
    }
  }
  const wtRecords = (runWorkspace.list?.(ctx.runId) ?? []).map((w) => ({ name: w.name, branch: w.branch, path: w.path }));

  if (runErr) {
    if (isAwaitingHuman(runErr)) {
      try { writeCheckpoint(runsRoot, ctx.runId, { worktrees: wtRecords }); } catch {}
      stderr.write(`Awaiting human at run ${ctx.runId}. Resume: synod resume ${ctx.runId}\n`);
      return runErr.exitCode;
    }
    try {
      writeCheckpoint(runsRoot, ctx.runId, {
        status: "failed", error: runErr.message,
        stoppedAt: { node: runErr.node ?? null, type: null, inputHash: null },
        worktrees: wtRecords,
      });
    } catch {}
    stderr.write(`Error: flow "${args.name}" failed: ${runErr.message}\n`);
    return 1;
  }
  try { writeCheckpoint(runsRoot, ctx.runId, { status: "done", worktrees: wtRecords }); } catch {}
  if (result !== undefined) {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  return 0;
}

// ── Run guard ────────────────────────────────────────────────────────────
// realpath both sides so symlinked installs (npm link / npm i -g) still match —
// see src/cli.mjs isEntrypoint() for the full rationale.
function isEntrypoint(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(metaUrl);
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    return self === resolve(entry);
  }
}
const _isMain = isEntrypoint(import.meta.url);

if (_isMain) {
  installShutdownHandlers({ interactiveSigint: false });
  main()
    .then((code) => {
      // P2-43:正常退出也兜底——fire-and-forget 的非 reuse agent() 子进程
      // 不会被 process.exit 砍成孤儿(幂等,常态 no-op)。
      closeAllLiveSessionsSync();
      process.exit(code ?? 0);
    })
    .catch((err) => {
      console.error("Fatal:", err);
      closeAllLiveSessionsSync();
      process.exit(2);
    });
}

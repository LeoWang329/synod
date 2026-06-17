#!/usr/bin/env node
// synod/src/cli.mjs — Multi-session streaming CLI.
//
// T3: extended from T2 single-session to multi-session with non-blocking sends,
// per-session line buffers (label-prefixed, newline-split), REPL routing
// (/open, /use, /sessions, @label, @all), --task non-interactive mode,
// and SIGINT cleanup.  Single-session flow is a natural subset of the same
// code paths.

import path from "node:path";
import os from "node:os";
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
import { prepareResume } from "./flow/replay.mjs";
import { createInputRouter } from "./input-router.mjs";
import { enabled } from "./ui/ansi.mjs";
import { renderPrompt } from "./ui/prompt.mjs";
import { relayBanner } from "./ui/decorations.mjs";
import { installShutdownHandlers, closeAllLiveSessionsSync, gracefulShutdown } from "./shutdown.mjs";
import { scanResidualWorktrees } from "./run-workspace.mjs";
import { discoverFlows } from "./flow/loader.mjs";
import { makeCompleter } from "./ui/completer.mjs";
import { loadHistory, appendHistory, historyPath } from "./ui/history.mjs";

// ── CLI parsing ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    agent: "omp",
    model: undefined,
    effort: undefined,
    write: false,
    mesh: undefined, // tri-state: undefined → fall back to SYNOD_MESH env (see main())
    noTui: false,
    tasks: [],
    reap: false,
    runs: false,
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
      case "--runs":
        out.runs = true;
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
      case "--no-tui":
        out.noTui = true;
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
/**
 * 退出矩阵模式判定(P2-44):仅交互 REPL 用 interactiveSigint(一次优雅 exit(0)/
 * 二次强杀);--task 非交互模式被 SIGINT 打断须 exit(130),脚本/CI 才能区分中断。
 */
export function shutdownModeForArgv(argv) {
  return { interactiveSigint: !argv.includes("--task") };
}

export function meshFromEnv(env) {
  const v = env.SYNOD_MESH;
  return v === "1" || v === "true";
}

// 是否进入全屏 TUI:stdin 与 stdout 都须是 TTY(管道喂入/输出重定向都退回行 REPL);
// 非 --task、未 --no-tui、无 SYNOD_NO_TUI。
export function shouldUseTui(stdin, stdout, args, env) {
  if (!stdin || !stdin.isTTY || !stdout || !stdout.isTTY) return false;
  if (args.tasks && args.tasks.length > 0) return false;
  if (args.noTui) return false;
  if (env && (env.SYNOD_NO_TUI === "1" || env.SYNOD_NO_TUI === "true")) return false;
  return true;
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
      "  --runs                List recent flow runs, then exit",
      "  --task <agent>:<msg>  Run task non-interactively (repeatable)",
      "  --mesh                Inject orchestration skill into spawned agents (default: off)",
      "  --no-mesh             Force mesh off, overriding the SYNOD_MESH env var",
      "  --no-tui              Disable the full-screen TUI (use the line REPL)",
      "  -h, --help            Show this help",
      "",
      "REPL commands:",
      "  /open [--agent A] [--model M] [--effort E] [--write] [--mesh|--no-mesh]   New session",
      "  /use <label>          Switch current session",
      "  /sessions             List all sessions",
      "  @<label> <msg>        Send to a session",
      "  @all <msg>            Broadcast to all sessions",
      "  /relay <from>-><to>   Auto-forward source turn text to target (standing rule)",
      "  /unrelay <from>-><to> Remove a relay rule",
      "  /relays               List active relay rules",
      "  /forward <from>-><to> [note]  One-shot manual forward of source's last turn (with note)",
      "  /flow [<name> [input]] Run a workflow (omit name to list available)",
      "  /resume <runId>       Resume a previously failed/interrupted flow run",
      "  /exit, /quit          Close all sessions and quit",
      "  Ctrl-D (EOF)          Same as /exit",
      "",
    ].join("\n"),
  );
}


/**
 * 残留 synod worktree 启动提示(§4.11 崩溃残留治理)。纯函数,便于单测。
 * 只读建议——绝不替用户删除可能含未保存工作的 worktree。
 */
export function residualWorktreeNotice(residual) {
  if (!residual || residual.length === 0) return "";
  const lines = [
    `synod: ${residual.length} residual synod worktree(s) from a previous run:`,
  ];
  for (const w of residual) {
    lines.push(`  - ${w.path}  (branch ${w.branch})`);
  }
  lines.push(`  inspect, then clean with: git worktree remove <path> && git branch -D <branch>`);
  return lines.join("\n") + "\n";
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

// 退出排水(line REPL 与 TUI 共用):有界不动点排空在飞 turn / control fence / relay 级联,
// 再清 relay 规则、flush、closeAll。drainControl/活动计数由调用方传入。
async function drainAndClose({ sm, registry, drainControl, controlActivity }) {
  try {
    for (let round = 0; round < 5; round += 1) {
      const beforeLoad = sm.sessionLoad, beforeAct = controlActivity();
      await sm.drainAll(); await drainControl();
      await sm.drainAll(); await drainControl();
      if (sm.sessionLoad === beforeLoad && controlActivity() === beforeAct) break;
    }
  } finally {
    // 即使 drainAll 抛也务必清 relay、flush、关全部会话(对齐老 onClose 的 finally)。
    for (const [label] of sm._sessions) registry.removeForLabel(label);
    sm.flushAll(); sm.closeAll();
  }
}

// ── resume subcommand ─────────────────────────────────────────────────
async function resumeCommand(runId, { openBackend, stdout, stderr, workflowsRoot, env }) {
  const runsRoot = path.resolve(env.SYNOD_HOME || os.homedir(), ".synod", "runs");
  let r;
  try {
    r = await prepareResume(runsRoot, runId);
  } catch (err) {
    stderr.write(`synod resume: ${err.message}\n`);
    return 1;
  }
  const flowsRoot = workflowsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
  return flowMain({
    argv: [r.flowName],
    stdout, stderr, openBackend,
    workflowsRoot: flowsRoot,
    cwd: r.cwd,
    runsRoot,
    resume: { runId: r.runId, input: r.input, steps: r.steps },
  });
}

// ── Main ─────────────────────────────────────────────────────────────
async function main({
  openBackend = realOpenBackend,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  argv = process.argv,
  env = process.env,
  // /flow resolves flows from the synod package's workflows/ dir by default;
  // injectable so integration tests can point it at a temp project dir.
  workflowsRoot,
} = {}) {
  const rawArgv = argv.slice(2);

  // ── synod resume <runId> ───────────────────────────────────────────
  if (rawArgv[0] === "resume") {
    const runId = rawArgv[1];
    if (!runId) {
      stderr.write("usage: synod resume <runId>\n");
      return 2;
    }
    return resumeCommand(runId, { openBackend, stdout, stderr, workflowsRoot, env });
  }

  const args = parseArgs(rawArgv);
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

  if (args.runs) {
    const { listRuns } = await import("./runs.mjs");
    const root = path.resolve(env.SYNOD_HOME || os.homedir(), ".synod", "runs");
    const runs = listRuns(root);
    if (!runs.length) { stdout.write("No runs.\n"); return 0; }
    for (const r of runs) {
      const when = r.startedAt ? new Date(r.startedAt).toISOString() : "?";
      const status = r.status === "failed" && r.failedNode ? `failed@${r.failedNode}` : r.status;
      const wt = r.worktrees && r.worktrees.length ? `  worktrees=${r.worktrees.length}` : "";
      stdout.write(`${r.runId}  ${when}  ${status}${wt}\n`);
    }
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

  const report = await doctor();
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

  // ── TUI 分支(stdin+stdout 皆 TTY 默认进;捕获流隔离全屏)────────────────────
  if (shouldUseTui(stdin, stdout, args, env)) {
    const flowsRootTui = workflowsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
    const { startTui } = await import("./ui/tui/index.mjs");
    const { createStore } = await import("./ui/tui/store.mjs");
    const { makeCaptureStream } = await import("./ui/tui/capture.mjs");

    const store = createStore();
    const { createFlowTui } = await import("./ui/tui/flow-tui.mjs");
    const flowTui = createFlowTui({ store, openBackend, workflowsRoot: flowsRootTui, cwd, config, env, defaultAgent: args.agent, mesh });
    const cap = makeCaptureStream((line) => store.pushSystem(line));

    let smTui, composed;
    const registry = createRelayRegistry((to, msg, meta) => {
      if (meta) store.pushSystem(`[relay ${meta.from}→${to}] ${meta.chars} chars`);
      smTui.enqueue({ target: to, msg });
    });
    smTui = createSessionManager({
      openBackend, stdout: cap, stderr: cap, report, cwd,
      defaults: { model: args.model, effort: args.effort, write: args.write, mesh },
      onIdle: () => {}, renderOutput: false,
      onSessionOpen: (label, session) => {
        const info = smTui._sessions.get(label);
        store.attachSession(label, session, info.agent, { model: info.model, effort: info.effort });
      },
      onTurnComplete: (label, result) => { if (composed) composed(label, result); },
      relays: () => registry.list(), env,
    });
    let _dropDepthTui = () => {};
    const dispatchTui = createReplDispatch({
      sm: smTui, registry, stdout: cap, stderr: cap, defaultAgent: args.agent,
      guardrails: { maxSessions: 10, maxDepth: 3, allowWrite: false }, config,
      runFlow: flowTui.runFlow, resumeFlow: flowTui.resumeFlow, flowStatus: flowTui.flowStatus,
      onCloseLabel: (label) => _dropDepthTui(label),
    });
    const wired = wireControl({
      sm: smTui, registry, stderr: cap, dispatch: dispatchTui,
      // C:编排意图喂进 store。gate「会话仍在」——fence task 是 fire-and-forget,可能在
      // originator 已被 dropSession 之后才回调;不 gate 会 late-append 重建一个 orphan
      // fences[label](该会话已不在 sessions/order,FocusPane 永不渲染、也永不再清)。
      onFence: (label, fence) => { if (store.getState().sessions[label]) store.appendFence(label, fence); },
    });
    composed = wired.onTurnComplete;
    _dropDepthTui = wired.dropLabel;
    const drainControl = wired.drainControl, controlActivity = wired.controlActivity;

    // syncFocus 收窄:flow 卡不在 smTui,既不能被当孤儿撤掉,也不能被 setFocus 抢走焦点
    //(flow 卡生命周期由 flow-tui 的 endFlow/dropFlow 自管)。
    const syncFocus = () => {
      const fl = store.getState().focusLabel;
      const fs = fl ? store.getState().sessions[fl] : null;
      if (!fs || fs.kind !== "flow") store.setFocus(smTui.currentLabel);   // 焦点是真会话才跟随 smTui
      for (const l of store.getState().order) {
        const s = store.getState().sessions[l];
        if (s && s.kind === "flow") continue;                              // 跳过 flow 卡
        if (!smTui._sessions.has(l)) store.dropSession(l);
      }
    };
    const onSelect = (label) => {
      const s = store.getState().sessions[label];
      if (s && s.kind === "flow") { store.setFocus(label); return; }       // flow 卡:直接聚焦,不碰 smTui
      if (smTui.use(label)) store.setFocus(label);
    };
    const onCycle = () => {
      store.focusNext();
      const f = store.getState().focusLabel;
      const s = f ? store.getState().sessions[f] : null;
      if (f && s && s.kind !== "flow") smTui.use(f);                        // 只有真会话才同步 smTui current
    };
    const dispatchWrapped = (line, opts) => {
      const source = opts?.source ?? "human";   // default human; don't miss echo when opts omitted
      // /close 落到 flow 卡:flow 卡不在 smTui,普通 /close 走不通 → 关掉续聊会话(若有)+ dropFlow。
      if (source === "human" && /^\/close(\s|$)/.test(line)) {
        const arg = line.slice(6).trim();
        const tl = arg || store.getState().focusLabel;
        const ts = tl ? store.getState().sessions[tl] : null;
        if (ts && ts.kind === "flow") { try { flowTui.closeLive(ts.flowId); } catch { /* */ } store.dropFlow(ts.flowId); syncFocus(); return { redraw: true }; }
      }
      // flow 卡聚焦 + 纯文本 human 行:待答→作答 / 已结束或续聊中→原地续聊(回复续写进同一张卡,不蹦新卡)/
      // flow 原始运行中无待答→拒绝。斜杠/@/$ 命令(含 /flow、/resume)仍走 dispatchTui。
      if (source === "human" && !/^[/@$]/.test(line)) {
        const fl = store.getState().focusLabel;
        const fs = fl ? store.getState().sessions[fl] : null;
        if (fs && fs.kind === "flow") {
          if (fs.pendingQuestion != null) { flowTui.handleHumanLine(fl, line); syncFocus(); return { redraw: true }; }
          if (fs._live || fs.status === "done" || fs.status === "failed") { flowTui.continueInPlace(fl, line); syncFocus(); return { redraw: true }; }
          flowTui.handleHumanLine(fl, line); syncFocus(); return { redraw: true };
        }
      }
      const label = smTui.currentLabel;          // capture target label BEFORE dispatch (currentLabel may change during)
      const r = dispatchTui(line, opts);
      // Only echo a plain-text message that actually enqueued: plain text → {redraw:false} on success,
      // {redraw:true} on failure (no session/busy). Slash/@/$ are commands, not echoed. (repl-dispatch.mjs:230-232)
      if (source === "human" && label && !/^[/@$]/.test(line) && r?.redraw === false) store.pushUser(label, line);
      Promise.resolve(r).finally?.(syncFocus); syncFocus(); return r;
    };

    const flowList = await (async () => { try { return (await discoverFlows(flowsRootTui)).flows?.map((f) => f.name) ?? []; } catch { return []; } })();
    const hintsCtx = {
      labels: () => [...smTui._sessions.keys()], flows: flowList,
      backends: () => backendNames(), profiles: () => Object.keys(config.agents ?? {}),
    };

    try { const n = residualWorktreeNotice(scanResidualWorktrees(cwd)); if (n) store.pushSystem(n.trim()); } catch {}

    const defLabel = await smTui.open({ agent: args.agent, announce: false });
    if (!defLabel) return 3;
    store.setFocus(smTui.currentLabel);

    let tui;
    // Ctrl+C 语义:第一次=打断当前所有会话的 turn(不退出);1.5s 内连按第二次=退出。
    // 超过窗口未连按 → 计数重置,下次按又是一次"打断"。(原实现 bug:第一次就 unmount 退出了。)
    let _interruptCount = 0;
    let _interruptResetTimer = null;
    const onInterrupt = () => {
      _interruptCount += 1;
      if (_interruptCount >= 2) {
        if (_interruptResetTimer) clearTimeout(_interruptResetTimer);
        try { tui.teardown?.(); } catch {}   // 还原终端(alt-screen/光标/鼠标)再硬退出
        closeAllLiveSessionsSync();
        process.exit(1);
        return;
      }
      for (const [, info] of smTui._sessions) {
        try { Promise.resolve(info.session.abort?.()).catch(() => {}); } catch {}
      }
      try { flowTui.abortAll(); } catch {}   // 同时中断在跑的 flow
      store.pushSystem("已打断当前 turn。1.5s 内再按一次 Ctrl+C 退出。");
      if (_interruptResetTimer) clearTimeout(_interruptResetTimer);
      _interruptResetTimer = setTimeout(() => { _interruptCount = 0; _interruptResetTimer = null; }, 1500);
      _interruptResetTimer.unref?.();
    };
    tui = await startTui({ store, dispatch: dispatchWrapped, hintsCtx, mesh, onSelect, onCycle, onInterrupt, stdin, stdout });
    await tui.waitUntilExit();
    try { flowTui.closeAllLive(); } catch { /* */ }   // 关掉续聊会话(flow 卡内接管的真后端)
    await drainAndClose({ sm: smTui, registry, drainControl, controlActivity });
    return 0;
  }

  // ── Interactive mode ───────────────────────────────────────────────

  // ── Exit gate ──────────────────────────────────────────────────────
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  // ── InputRouter (§4.8 single stdin owner, P1-8) ────────────────────────
  // One readline.Interface for the whole process.  The REPL default route runs
  // through router.onLine; flow approve()/question() temporarily claim the next
  // line via router.claim (no second readline → no stdin tug-of-war).  Start
  // paused so piped input isn't consumed before the default session is ready
  // (resumed below, after sm.open).
  let _exiting = false;     // /exit requested or graceful SIGINT in progress
  let _closed = false;      // rl 'close' fired (onClose ran) — guards stray prompts

  // ── Tab completer + history (晚绑定 proxy + TTY-only history) ─────────────
  let _completer = null;
  const completerProxy = (line) => (_completer ? _completer(line) : [[], line]);
  const _home = env.SYNOD_HOME || os.homedir();
  const _histFile = stdin.isTTY ? historyPath(_home) : null;
  const _history = _histFile ? loadHistory(_histFile) : undefined;

  const router = createInputRouter({ stdin, stdout, completer: completerProxy, history: _history });
  router.pause();
  // Prompt redraw, guarded so no stray "> " is written after exit/close
  // (mirrors the old createRepl writePrompt guard).
  const writePrompt = () => { if (!_exiting && !_closed) stdout.write(renderPrompt({ sm, stdout, env })); };

  // ── Relay registry (two-phase: created before sm, enqueue wired after) ──
  const colorOn = enabled(stdout, env);
  let _smForRelay = null;
  const registry = createRelayRegistry((to, msg, meta) => {
    if (!_smForRelay) return;
    if (colorOn && meta) stdout.write(relayBanner(to, meta.from, meta.chars));
    _smForRelay.enqueue({ target: to, msg });
  });

  // ── Control channel (two-phase: composed onTurnComplete set after sm exists) ──
  let _composedOnTurnComplete = null;

  const sm = createSessionManager({
    openBackend, stdout, stderr, report, cwd,
    defaults: { model: args.model, effort: args.effort, write: args.write, mesh },
    onIdle: (label) => {
      if (label === sm.currentLabel) writePrompt();
    },
    errorLeadingNewline: true,
    onTurnComplete: (label, result) => {
      if (_composedOnTurnComplete) _composedOnTurnComplete(label, result);
    },
    relays: () => registry.list(),
    env,
  });
  _smForRelay = sm;

  // ── Flow engine bridge (human-only /flow command) ──────────────────────
  // Resolve flows from the synod package's workflows/ dir (not the launch cwd),
  // so /flow works regardless of where synod was started; agents still run in
  // `cwd`.  Track in-flight runs so onClose can await them — a flow dropped on
  // /exit would orphan its agent sessions (violates the no-residue invariant).
  // Each run gets its own AbortController so a TTY Ctrl-C (router SIGINT first
  // strike) cancels active flows cooperatively.  The flow io is the shared
  // router: approve()/question() claim the next human line (P1-8).
  const flowsRoot = workflowsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");

  // ── 晚绑定 completer:sm 已建、flowsRoot 已知 → 发现 flow 名单后激活 ────────
  {
    let _flowList = [];
    try { _flowList = (await discoverFlows(flowsRoot)).flows ?? []; } catch { _flowList = []; }
    _completer = makeCompleter({ sm, config, flows: _flowList, backendNames });
  }

  const _pendingFlows = new Set();
  const _activeFlows = new Set();   // { ctrl } — Ctrl-C first strike aborts these
  let _flowAbortRequested = false;  // set on first flow-abort strike; cleared when flows drain
  const flowIo = {
    stdout, stdin,
    question: (prompt, { signal } = {}) => router.claim({ prompt, signal }),
  };
  const runFlow = (flowArgv) => {
    const ctrl = new AbortController();
    const handle = { ctrl };
    _activeFlows.add(handle);
    const p = flowMain({
      argv: flowArgv, stdout, stderr, openBackend,
      workflowsRoot: flowsRoot, cwd, config,
      io: flowIo, signal: ctrl.signal,
    });
    _pendingFlows.add(p);
    p.finally(() => {
      _pendingFlows.delete(p);
      _activeFlows.delete(handle);
      // Flows drained → reset the abort-strike flag so the next Ctrl-C at the
      // REPL starts fresh from the first (graceful) strike.
      if (_activeFlows.size === 0) _flowAbortRequested = false;
    }).catch(() => {});
    return p;
  };

  const resumeFlow = async (runId) => {
    const runsRoot = path.resolve(env.SYNOD_HOME || os.homedir(), ".synod", "runs");
    let r;
    try {
      r = await prepareResume(runsRoot, runId);
    } catch (err) {
      stderr.write(`/resume: ${err.message}\n`);
      return;
    }
    const ctrl = new AbortController();
    const handle = { ctrl };
    _activeFlows.add(handle);
    const p = flowMain({
      argv: [r.flowName],
      stdout, stderr, openBackend,
      workflowsRoot: flowsRoot, cwd: r.cwd, config,
      io: flowIo, signal: ctrl.signal,
      runsRoot,
      resume: { runId: r.runId, input: r.input, steps: r.steps },
    });
    _pendingFlows.add(p);
    p.finally(() => {
      _pendingFlows.delete(p);
      _activeFlows.delete(handle);
      if (_activeFlows.size === 0) _flowAbortRequested = false;
    }).catch(() => {});
    return p;
  };

  // ── REPL dispatch (created before wireControl so it can be passed in) ──
  let _dropDepth = () => {};
  const dispatch = createReplDispatch({
    sm, registry, stdout, stderr,
    defaultAgent: args.agent,
    guardrails: { maxSessions: 10, maxDepth: 3, allowWrite: false },
    runFlow,
    resumeFlow,
    config,
    onCloseLabel: (label) => _dropDepth(label),
    flowStatus: () => (_pendingFlows.size > 0 ? `${_pendingFlows.size} running` : "none"),
  });

  const { onTurnComplete: composedOnTurnComplete, drainControl, dropLabel, controlActivity } = wireControl({
    sm, registry, stderr, dispatch,
  });
  _dropDepth = dropLabel;
  _composedOnTurnComplete = composedOnTurnComplete;

  // ── onClose: drain in-flight work, then tear down all sessions ─────────
  // Migrated verbatim from the old createRepl onClose; now driven by the
  // router's rl 'close' event.  Idempotent via the _closed guard.
  async function onClose() {
    if (_closed) return;
    _closed = true;
    let exitCode = 0;
    try {
      // B2: abort any active /flow runs FIRST, before awaiting them.  A flow
      // blocked on approve()/question() (router.claim awaiting a human line that
      // EOF will never deliver) only settles once its run-level signal fires →
      // approve/agent/bash cancel cooperatively → flow resolves.  Without this,
      // the await below would hang forever on Ctrl-D with a pending approve.
      for (const h of _activeFlows) h.ctrl.abort();
      // Let any in-flight /flow runs finish first so they tear down their own
      // agent sessions (otherwise /exit would orphan them).
      if (_pendingFlows.size > 0) {
        await Promise.allSettled([..._pendingFlows]);
      }
      // P1-11 + B4: 有界不动点排空在飞 fence dispatch / 回喂级联,再清 relay、flush、
      // closeAll(全部搬进共享的 drainAndClose,与 TUI 退出路径同源 — 语义不变:
      // relay 清理 / flush / closeAll 仍在其 finally 里,故 drainAll 抛错也照常执行)。
      await drainAndClose({ sm, registry, drainControl, controlActivity });
    } catch (err) {
      exitCode = 1;
      stderr.write(`synod: ${err.stack || err.message}\n`);
    } finally {
      resolveExit(exitCode);
    }
  }
  router.rl.on("close", onClose);

  // ── REPL default route: dispatch each human line ──────────────────────
  // dispatch() is synchronous for every command except /open and /flow (both
  // return a Promise).  Keeping /exit synchronous is critical for piped stdin —
  // router.close() must run before the next buffered 'line' event (the _exiting
  // guard then drops any already-queued lines, as the old exitRequested did).
  router.onLine((line) => {
    if (_exiting) return;
    const text = line.trim();
    if (!text) { writePrompt(); return; }
    if (_histFile) appendHistory(_histFile, text);
    const r = dispatch(text, { source: "human" });
    if (r && typeof r.then === "function") {
      r.then((res) => { if (res.redraw) writePrompt(); });
    } else if (r.exit) {
      _exiting = true;
      router.close();            // → rl 'close' → onClose
    } else if (r.redraw) {
      writePrompt();
    }
  });

  // ── rl SIGINT exit matrix (raw-mode Ctrl-C, P1-28) ────────────────────
  // Only fires in a TTY (readline intercepts Ctrl-C); piped/CI SIGINT is handled
  // by installShutdownHandlers at the process level.  First strike: abort active
  // flows (cooperative cancel) if any, else graceful shutdown; second strike:
  // force exit.  Output strings match shutdown.mjs interactiveSigint.
  let _sigintCount = 0;
  router.onSigint(() => {
    if (_activeFlows.size > 0) {
      if (!_flowAbortRequested) {
        // First strike with active flows: cooperative abort.  We track this on a
        // dedicated flag (NOT _sigintCount) so that once the flow tears down and
        // the user is back at the REPL, the next Ctrl-C starts fresh from the
        // first (graceful) strike.  The flag is cleared when _activeFlows drains.
        _flowAbortRequested = true;
        stderr.write("\nInterrupted. Cleaning up...\n");
        for (const h of _activeFlows) h.ctrl.abort();
        return;
      }
      // Second strike while flows are STILL active despite the abort (wedged /
      // non-cooperative flow) → escalate to force exit so the user is never stuck.
      stderr.write("\nForce exiting...\n");
      closeAllLiveSessionsSync();
      process.exit(1);
      return;
    }
    _sigintCount += 1;
    if (_sigintCount === 1) {
      stderr.write("\nInterrupted. Cleaning up...\n");
      gracefulShutdown().finally(() => { _exiting = true; router.close(); });
    } else {
      stderr.write("\nForce exiting...\n");
      closeAllLiveSessionsSync();
      process.exit(1);
    }
  });

  // ── 启动顺扫残留 synod worktree(上次崩溃遗留),只提示不替删。────────────
  try {
    const residual = scanResidualWorktrees(cwd);
    const notice = residualWorktreeNotice(residual);
    if (notice) stderr.write(notice);
  } catch { /* 非 git 仓库 / git 缺失 → 静默跳过 */ }

  // ── Open default session ───────────────────────────────────────────
  const defaultLabel = await sm.open({ agent: args.agent, announce: false });
  if (!defaultLabel) return 3;

  router.resume();
  writePrompt();

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
  installShutdownHandlers(shutdownModeForArgv(process.argv));
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

// synod/src/backend.mjs — Built-in backend protocol layer
//
// Forked from agent-bridge v0.5.1 (scripts/agent-bridge.mjs, 2947 lines).
// Source: ~/.claude/plugins/cache/agent-bridge/agent-bridge/0.5.1/scripts/agent-bridge.mjs
//
// Symbols carried forward (v0.5.1 line ranges):
//   Constants:        DEFAULT_WAIT_TIMEOUT_MS (13), MAX_EVENTS (14), MAX_TEXT (15),
//                     STATE_ROOT (19), LOG_DIR (20), AGENTS (25–36)
//   Tools:            nowIso (210), makeId (214), assertAgent (218), assertCwd (222),
//                     agentBin (230), appendLog (235), stripAnsi (241), clampText (245),
//                     shellQuote (348), sleep (2926), withTimeout (2930), ensureDirs (205)
//   Session helpers:  compactEvent (270), compactValue (274), extractVisibleTextDelta (311),
//                     extractAssistantText (1256), extractLikelyText (1273)
//   Process tree:     listChildPids (370), terminateProcessTree (400), scheduleForceKill (411)
//                     — win32 branch added for cross-platform support
//   OmpSession:       forked from OmpRpcSession (466–780), renamed
//   CodexSession:     forked from CodexAppServerSession (782–1255), renamed
//   doctor:           forked from doctor (1401), restructured for Synod export
//
// Deliberately omitted:
//   SSE:        sessionEventPayload (317), sendSse (330), broadcastSessionEvent (339)
//   PID record: pidRecordPath (354), writePidRecord (358), removePidRecord (364),
//               processCommand (379), roleMatchesCommand (385), ownerStillRunning (392),
//               cleanupStalePidRecords (424)
//   All daemon/MCP/HTTP/Web UI/CLI facade (1290–2947 except doctor/sleep/withTimeout)
//
// Decoupling (the only intentional logic change):
//   - Both sessions extend EventEmitter
//   - setSessionStatus(this, …) → #setStatus(…) emits 'status'
//   - pushEvent(this, ev) → #emit(ev) emits 'event'
//   - Stream delta emits 'delta' at accumulation points

import { spawn as _defaultSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// ── Constants ────────────────────────────────────────────────────────
// 0.5.1:13–36
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const MAX_TEXT = 400_000;
const STATE_ROOT =
  process.env.AGENT_BRIDGE_STATE_DIR || path.join(os.homedir(), ".agent-bridge");
const LOG_DIR = path.join(STATE_ROOT, "logs");

const AGENTS = {
  omp: {
    label: "Oh My Pi",
    env: "OMP_BIN",
    bin: "omp",
  },
  codex: {
    label: "Codex",
    env: "CODEX_BIN",
    bin: "codex",
  },
};

// ── Tools ────────────────────────────────────────────────────────────
// 0.5.1:205–208 (simplified — PID_DIR removed)
function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 0.5.1:210
function nowIso() {
  return new Date().toISOString();
}

// 0.5.1:214
function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 0.5.1:218
function assertAgent(agent) {
  if (!AGENTS[agent])
    throw new Error(`Unsupported agent "${agent}". Use omp or codex.`);
}

// 0.5.1:222
function assertCwd(cwd) {
  if (!cwd || typeof cwd !== "string") throw new Error("cwd is required.");
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved))
    throw new Error(`cwd does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error(`cwd is not a directory: ${resolved}`);
  return resolved;
}

// 0.5.1:230
function agentBin(agent) {
  const config = AGENTS[agent];
  return process.env[config.env] || config.bin;
}

// 0.5.1:235
function appendLog(file, text) {
  if (!file || !text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text, "utf8");
}

// 0.5.1:241
function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// 0.5.1:245
function clampText(text, max = MAX_TEXT) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

// 0.5.1:348
function shellQuote(value) {
  const s = String(value);
  if (/^[a-zA-Z0-9_./:=,+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// 0.5.1:270
function compactEvent(event) {
  return compactValue(event);
}

// 0.5.1:274
function compactValue(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= 6)
    return Array.isArray(value) ? `[${value.length} items]` : "[object]";
  if (Array.isArray(value))
    return value.map((item) => compactValue(item, depth + 1));

  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = compactValue(child, depth + 1);
  }
  return copy;
}

// 0.5.1:311
function extractVisibleTextDelta(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "status") return "";
  return clampText(extractAssistantText(event), 4000);
}

// 0.5.1:1256
function extractAssistantText(value) {
  if (!value || typeof value !== "object") return "";
  const type = String(value.type || value.role || value.kind || "");
  if (/assistant|message|text|part|delta/i.test(type)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.delta === "string") return value.delta;
  }
  let out = "";
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes("thinking")) continue;
    if (child && typeof child === "object") out += extractAssistantText(child);
    else if (/^(text|content|delta)$/.test(key) && typeof child === "string")
      out += child;
  }
  return out;
}

// 0.5.1:1273
function extractLikelyText(raw) {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) return line;
    try {
      const parsed = JSON.parse(line);
      const text = extractAssistantText(parsed);
      if (text) return text;
    } catch {}
  }
  return "";
}

// ── Process tree ─────────────────────────────────────────────────────
// 0.5.1:370 — with win32 addition
function listChildPids(pid) {
  if (process.platform === "win32") {
    // On Windows, taskkill /T handles the entire tree natively;
    // we don't need to enumerate children individually.
    return [];
  }
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 1);
}

// 0.5.1:400 — with win32 branch
function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8",
      });
      return true;
    } catch {
      return false;
    }
  }

  for (const childPid of listChildPids(pid))
    terminateProcessTree(childPid, signal);
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// 0.5.1:411
function scheduleForceKill(pid, graceMs = 3000) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  const timer = setTimeout(() => {
    try {
      process.kill(pid, 0);
    } catch {
      return; // already exited
    }
    terminateProcessTree(pid, "SIGKILL");
  }, graceMs);
  timer.unref?.();
}

// 0.5.1:2926
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 0.5.1:2930
async function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── OmpSession (forked from OmpRpcSession 0.5.1:466–780) ────────────

class OmpSession extends EventEmitter {
  constructor(options) {
    super();
    this.id = makeId("omp");
    this.agent = "omp";
    this.cwd = assertCwd(options.cwd);
    this.write = Boolean(options.write);
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.status = "starting";
    this.isStreaming = false;
    this.lastAssistantText = "";
    this.lastError = null;
    // Set true once the current turn is observed actually streaming (agent_start /
    // stream deltas / a live isStreaming reading); waitIdle won't accept the idle
    // window that exists *before* a freshly-sent prompt starts.
    this.turnStarted = false;
    this.turnCount = 0;
    this.sessionState = null;
    this.events = [];
    this.pending = new Map();
    this.requestCounter = 0;
    this.logFile = path.join(LOG_DIR, `${this.id}.log`);
    this.proc = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this._spawn = options.spawn;
  }

  async start() {
    const args = ["--mode", "rpc", "--no-title", "--no-extensions", "--no-rules"];
    if (this.model) args.push("--model", this.model);
    if (this.effort) args.push("--thinking", this.effort);
    if (this.write) {
      args.push("--auto-approve", "--approval-mode", "yolo");
    } else {
      args.push(
        "--tools",
        "read,grep,find,lsp,web_search",
        "--approval-mode",
        "yolo",
      );
    }

    appendLog(
      this.logFile,
      `$ ${[agentBin("omp"), ...args.map(shellQuote)].join(" ")}\n`,
    );
    appendLog(
      this.logFile,
      `[agent-bridge] owner pid=${process.pid} ppid=${process.ppid} stdinTTY=${Boolean(process.stdin.isTTY)} stdoutTTY=${Boolean(process.stdout.isTTY)}\n`,
    );
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.proc = this._spawn(agentBin("omp"), args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    appendLog(
      this.logFile,
      `[agent-bridge] spawned OMP pid=${this.proc.pid}\n`,
    );

    this.proc.stdin.on("close", () =>
      appendLog(this.logFile, "[agent-bridge] OMP stdin closed\n"),
    );
    this.proc.stdout.on("close", () =>
      appendLog(this.logFile, "[agent-bridge] OMP stdout closed\n"),
    );
    this.proc.stderr.on("close", () =>
      appendLog(this.logFile, "[agent-bridge] OMP stderr closed\n"),
    );

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      appendLog(this.logFile, text);
      this.lastError = clampText(stripAnsi(text), 4000);
    });

    const rl = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => this.#handleLine(line));

    this.proc.on("error", (err) => {
      this.lastError = err.message;
      this.#setStatus("failed", false, {
        source: "process_error",
        error: err.message,
      });
      this.#emitError(err);
      this.readyReject?.(err);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
    });

    this.proc.on("close", (code, signal) => {
      appendLog(
        this.logFile,
        `[agent-bridge] OMP RPC exited code=${code} signal=${signal || ""}\n`,
      );
      if (this.status === "closed") {
        this.#setStatus("closed", false, {
          source: "process_close",
          code,
          signal,
        });
        return;
      }
      this.lastError =
        code === 0 ? this.lastError : `OMP RPC exited with code ${code}`;
      this.#setStatus(
        code === 0 && this.status !== "failed" ? "closed" : "failed",
        false,
        { source: "process_close", code, signal },
      );
      if (this.status === "failed") this.#emitError(new Error(this.lastError || "OMP RPC exited."));
      this.readyReject?.(
        new Error(this.lastError || "OMP RPC exited before ready."),
      );
      for (const pending of this.pending.values())
        pending.reject(
          new Error(this.lastError || "OMP RPC exited."),
        );
      this.pending.clear();
    });

    await withTimeout(this.readyPromise, 20000, "Timed out waiting for OMP RPC ready.");
    return this;
  }

  // ── internal ──────────────────────────────────────────────────────

  #setStatus(status, isStreaming = this.isStreaming, extra = {}) {
    const nextStreaming = Boolean(isStreaming);
    const changed =
      this.status !== status || this.isStreaming !== nextStreaming;
    this.status = status;
    this.isStreaming = nextStreaming;
    this.updatedAt = nowIso();
    if (changed || extra.force) {
      this.#emit({ type: "status", status, isStreaming: nextStreaming, ...extra });
    }
    if (changed) {
      this.emit("status", { status: this.status, isStreaming: this.isStreaming });
    }
  }

  #emit(event) {
    const record = { at: nowIso(), event };
    this.updatedAt = record.at;
    this.events.push(record);
    while (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit("event", event);
  }

  #emitError(err) {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  #handleLine(line) {
    appendLog(this.logFile, `${line}\n`);
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#emit({ type: "raw", line });
      return;
    }

    this.updatedAt = nowIso();
    if (message.type === "ready") {
      this.#setStatus("idle", false, { source: "ready" });
      this.readyResolve?.();
      return;
    }

    if (
      message.type === "response" &&
      message.id &&
      this.pending.has(message.id)
    ) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.success === false)
        pending.reject(
          new Error(message.error || "OMP RPC command failed."),
        );
      else pending.resolve(message);
      return;
    }

    this.#applyEvent(message);
    this.#emit(compactEvent(message));
  }

  #applyEvent(message) {
    if (message.type === "agent_start" || message.type === "turn_start") {
      this.lastAssistantText = "";
      this.turnStarted = true;
      this.#setStatus("running", true, { source: message.type });
      return;
    }
    if (message.type === "agent_end" || message.type === "turn_end") {
      this.turnCount += 1;
      this.#setStatus("idle", false, { source: message.type });
      return;
    }
    if (message.type === "message_update") {
      const update =
        message.assistantMessageEvent || message.message || message;
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        this.lastAssistantText = clampText(
          this.lastAssistantText + update.delta,
        );
        // Synod: emit stream delta
        this.emit("delta", update.delta);
      }
      if (typeof update?.text === "string") {
        this.lastAssistantText = clampText(update.text);
      }
    }
    if (message.type === "error" || message.type === "extension_error") {
      this.lastError = JSON.stringify(message);
      this.#emitError(new Error(this.lastError));
    }
  }

  // ── public methods ────────────────────────────────────────────────

  request(type, extra = {}) {
    const id = `req_${++this.requestCounter}`;
    const payload = { id, type, ...extra };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  async send(message, options = {}) {
    if (!message || !String(message).trim())
      throw new Error("message is required.");
    if (this.status === "closed")
      throw new Error(`OMP session ${this.id} is closed.`);
    if (!this.proc || this.proc.exitCode !== null)
      throw new Error(`OMP process for ${this.id} is not running.`);
    // Reset before prompting so waitIdle below ignores the pre-streaming idle window
    // (a stale idle reading from before this turn actually starts).
    this.turnStarted = false;
    this.#setStatus("running", true, { source: "send" });
    await this.request("prompt", { message: String(message) });
    if (options.wait) {
      try {
        await this.waitIdle(
          options.timeout_ms || DEFAULT_WAIT_TIMEOUT_MS,
        );
      } catch (err) {
        // On wait timeout the OMP turn is still streaming; abort it so the session is
        // immediately reusable instead of rejecting the next send as "already processing".
        try {
          await this.abort();
        } catch {}
        throw err;
      }
      return await this.result();
    }
    return { accepted: true, session_id: this.id, status: this.status };
  }

  async state() {
    const response = await this.request("get_state");
    this.sessionState = response.data || null;
    if (this.sessionState) {
      this.#setStatus(
        this.sessionState.isStreaming ? "running" : "idle",
        Boolean(this.sessionState.isStreaming),
        { source: "state" },
      );
    }
    return this.sessionState;
  }

  async result() {
    let text = this.lastAssistantText;
    try {
      const response = await this.request("get_last_assistant_text");
      if (response.data && typeof response.data.text === "string")
        text = response.data.text;
    } catch {
      // Keep accumulated stream text when the helper command is unavailable.
    }
    this.lastAssistantText = clampText(text || this.lastAssistantText || "");
    return {
      session: this.summary(),
      text: this.lastAssistantText || null,
      recent_events: this.events.slice(-20),
      log_file: this.logFile,
    };
  }

  async abort() {
    await this.request("abort");
    this.#setStatus("idle", false, { source: "abort" });
    return { aborted: true, session_id: this.id };
  }

  async waitIdle(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(750);
      // If the process died, fail now instead of polling a dead pipe until timeout.
      if (!this.proc || this.proc.exitCode !== null) {
        throw new Error(
          `OMP process for ${this.id} exited (code ${this.proc?.exitCode ?? "?"}) before the turn completed.`,
        );
      }
      try {
        const state = await this.state();
        const idle = !state?.isStreaming && !state?.queuedMessageCount;
        // Only accept idle once THIS turn has actually started, observed via the
        // agent_start event (turnStarted, reset at send). A live isStreaming reading is
        // not used to set turnStarted: it can reflect a prior aborted/queued turn still
        // streaming, which would let waitIdle return the previous turn's text early.
        if (idle && this.turnStarted) return;
      } catch {
        // state() failed. If the process died or the session failed/closed mid-poll, that
        // is a real error — don't let "turnStarted && !isStreaming" report it as a clean idle
        // (the close handler clears isStreaming on exit), which would return a half-done turn.
        if (
          !this.proc ||
          this.proc.exitCode !== null ||
          this.status === "failed" ||
          this.status === "closed"
        ) {
          throw new Error(
            `OMP process for ${this.id} exited before the turn completed.`,
          );
        }
        if (this.turnStarted && !this.isStreaming) return;
      }
    }
    throw new Error(`Timed out waiting for ${this.id} to become idle.`);
  }

  summary() {
    return {
      id: this.id,
      agent: this.agent,
      cwd: this.cwd,
      write: this.write,
      model: this.model,
      effort: this.effort,
      status: this.status,
      isStreaming: this.isStreaming,
      turnCount: this.turnCount,
      pid: this.proc?.pid || null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      logFile: this.logFile,
      sessionState: this.sessionState
        ? {
            sessionId: this.sessionState.sessionId,
            sessionFile: this.sessionState.sessionFile,
            messageCount: this.sessionState.messageCount,
            queuedMessageCount: this.sessionState.queuedMessageCount,
            model: this.sessionState.model,
          }
        : null,
    };
  }

  close() {
    this.#setStatus("closed", false, { source: "close" });
    // Reject any in-flight RPCs (send/state/result waiters) now: once status is "closed"
    // the proc "close" handler early-returns and won't reject them, so they'd hang forever.
    const err = new Error(`OMP session ${this.id} closed.`);
    this.readyReject?.(err);
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    try {
      this.proc?.stdin?.end();
    } catch {}
    terminateProcessTree(this.proc?.pid);
    return { closed: true, session_id: this.id };
  }
}

// ── CodexSession (forked from CodexAppServerSession 0.5.1:782–1255) ─

class CodexSession extends EventEmitter {
  constructor(options) {
    super();
    this.id = makeId("codex");
    this.agent = "codex";
    this.cwd = assertCwd(options.cwd);
    this.write = Boolean(options.write);
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.status = "starting";
    this.isStreaming = false;
    this.lastAssistantText = "";
    this.lastError = null;
    this.events = [];
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.threadId = null;
    this.currentTurnId = null;
    this.ignoredTurnIds = new Set();
    this.turn = null;
    this.turnCount = 0;
    this.finalAnswer = "";
    this.lastAgentMessage = "";
    this.tokenUsage = null;
    this.logFile = path.join(LOG_DIR, `${this.id}.log`);
    this._spawn = options.spawn;
  }

  async start() {
    const args = ["app-server"];
    appendLog(
      this.logFile,
      `$ ${[agentBin("codex"), ...args].join(" ")}\n`,
    );
    this.proc = this._spawn(agentBin("codex"), args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    appendLog(
      this.logFile,
      `[agent-bridge] spawned codex app-server pid=${this.proc.pid}\n`,
    );

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (text) => {
      appendLog(this.logFile, text);
      this.lastError = clampText(stripAnsi(text), 4000);
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdin.on("error", (err) => {
      appendLog(
        this.logFile,
        `[agent-bridge] codex stdin error: ${err.message}\n`,
      );
      this.lastError = err.message;
      // A broken stdin pipe means no request can be answered; fail outstanding work
      // instead of letting pending RPCs / the active turn wait forever. Skip during a
      // deliberate close() (status already "closed"), where end() naturally emits EPIPE.
      if (this.status !== "closed") {
        this.#setStatus("failed", false, {
          source: "stdin_error",
          error: err.message,
        });
        this.#rejectAll(err);
        this.#emitError(err);
      }
    });
    const rl = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => this.#handleLine(line));

    this.proc.on("error", (err) => {
      this.lastError = err.message;
      this.#setStatus("failed", false, {
        source: "process_error",
        error: err.message,
      });
      this.#emitError(err);
      this.#rejectAll(err);
    });
    this.proc.on("close", (code, signal) => {
      appendLog(
        this.logFile,
        `[agent-bridge] codex app-server exited code=${code} signal=${signal || ""}\n`,
      );
      if (this.status === "closed") {
        this.#setStatus("closed", false, {
          source: "process_close",
          code,
          signal,
        });
        return;
      }
      this.lastError =
        code === 0
          ? this.lastError
          : `codex app-server exited with code ${code}`;
      this.#setStatus(
        code === 0 && this.status !== "failed" ? "closed" : "failed",
        false,
        { source: "process_close", code, signal },
      );
      if (this.status === "failed") this.#emitError(new Error(this.lastError || "codex app-server exited."));
      this.#rejectAll(
        new Error(this.lastError || "codex app-server exited."),
      );
    });

    await withTimeout(
      this.#request("initialize", {
        clientInfo: {
          title: "Agent Bridge",
          name: "agent-bridge",
          version: "0.5.1",
        },
        capabilities: {
          experimentalApi: false,
          optOutNotificationMethods: [],
        },
      }),
      20000,
      "Timed out on codex initialize.",
    );
    this.#notify("initialized", {});

    const started = await withTimeout(
      this.#request("thread/start", {
        cwd: this.cwd,
        model: this.model,
        approvalPolicy: "never",
        sandbox: this.write ? "workspace-write" : "read-only",
        serviceName: "agent_bridge",
        ephemeral: true,
        experimentalRawEvents: false,
      }),
      20000,
      "Timed out on codex thread/start.",
    );
    this.threadId = started?.thread?.id || started?.threadId || null;
    if (!this.threadId)
      throw new Error("codex thread/start returned no thread id");
    appendLog(
      this.logFile,
      `[agent-bridge] codex thread ${this.threadId}\n`,
    );
    this.#setStatus("idle", false, { source: "ready" });
    return this;
  }

  // ── internal ──────────────────────────────────────────────────────

  #setStatus(status, isStreaming = this.isStreaming, extra = {}) {
    const nextStreaming = Boolean(isStreaming);
    const changed =
      this.status !== status || this.isStreaming !== nextStreaming;
    this.status = status;
    this.isStreaming = nextStreaming;
    this.updatedAt = nowIso();
    if (changed || extra.force) {
      this.#emit({
        type: "status",
        status,
        isStreaming: nextStreaming,
        ...extra,
      });
    }
    if (changed) {
      this.emit("status", {
        status: this.status,
        isStreaming: this.isStreaming,
      });
    }
  }

  #emit(event) {
    const record = { at: nowIso(), event };
    this.updatedAt = record.at;
    this.events.push(record);
    while (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit("event", event);
  }

  #emitError(err) {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  #write(msg) {
    appendLog(
      this.logFile,
      `> ${JSON.stringify(msg).slice(0, 600)}\n`,
    );
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || this.proc.exitCode !== null) {
      throw new Error("codex app-server stdin is not writable");
    }
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    try {
      this.#write({ id, method, params });
    } catch (err) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(err);
    }
    return promise;
  }

  #notify(method, params = {}) {
    try {
      this.#write({ method, params });
    } catch (err) {
      appendLog(
        this.logFile,
        `[agent-bridge] codex notify failed: ${err.message}\n`,
      );
    }
  }

  #rejectAll(err) {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    const turn = this.turn;
    this.turn = null;
    turn?.reject?.(err);
  }

  #handleLine(line) {
    appendLog(this.logFile, `${line}\n`);
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#emit({ type: "raw", line });
      return;
    }
    this.updatedAt = nowIso();
    if (msg.id !== undefined && msg.method) {
      // Server-initiated request: we do not implement any, so reject.
      this.#write({
        id: msg.id,
        error: { code: -32601, message: "unsupported server request" },
      });
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error)
          pending.reject(
            Object.assign(
              new Error(msg.error.message || "codex error"),
              { rpc: msg.error },
            ),
          );
        else pending.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) this.#onNotification(msg);
  }

  #onNotification(msg) {
    const method = msg.method;
    const params = msg.params || {};
    const threadId = params.threadId ?? params.thread?.id ?? null;
    if (threadId && this.threadId && threadId !== this.threadId) {
      // Subagent / unrelated thread: keep for debug, do not drive our turn.
      this.#emit(compactEvent(msg));
      return;
    }
    // Events carry the turn they belong to; ignore ones from a turn that is no
    // longer current (an aborted/interrupted turn emitting trailing deltas or a
    // late turn/completed) so they cannot corrupt or prematurely settle a new turn.
    // `ignoredTurnIds` catches the post-abort window where currentTurnId is cleared
    // but the interrupted turn's id must still be rejected.
    const evTurnId = params.turn?.id ?? params.turnId ?? null;
    const staleTurn = Boolean(
      evTurnId &&
        (this.ignoredTurnIds.has(evTurnId) ||
          (this.currentTurnId && evTurnId !== this.currentTurnId)),
    );

    switch (method) {
      case "turn/started":
        if (staleTurn) {
          this.#emit(compactEvent(msg));
          return;
        }
        this.currentTurnId = params.turn?.id || this.currentTurnId;
        if (this.turn)
          this.#setStatus("running", true, { source: "turn/started" });
        this.#emit(compactEvent(msg));
        return;
      case "item/agentMessage/delta":
        if (staleTurn) {
          this.#emit(compactEvent(msg));
          return;
        }
        if (typeof params.delta === "string") {
          this.lastAssistantText = clampText(
            this.lastAssistantText + params.delta,
          );
          // Synod: emit stream delta
          this.emit("delta", params.delta);
        }
        this.#emit(compactEvent(msg));
        return;
      case "item/completed": {
        if (staleTurn) {
          this.#emit({ type: "item.completed", stale: true });
          return;
        }
        const item = params.item || {};
        if (
          item.type === "agentMessage" &&
          typeof item.text === "string" &&
          item.text
        ) {
          this.lastAgentMessage = item.text;
          if (item.phase === "final_answer") this.finalAnswer = item.text;
        }
        // Strip large text payloads from the pushed event to avoid double-appending in the UI.
        this.#emit({
          type: "item.completed",
          itemType: item.type,
          phase: item.phase ?? null,
          id: item.id,
        });
        return;
      }
      case "turn/completed": {
        if (staleTurn) {
          this.#emit(compactEvent(msg));
          return;
        }
        const status = params.turn?.status;
        this.#emit(compactEvent(msg));
        this.#settleTurn(
          status === "completed" || status === "interrupted"
            ? null
            : new Error(`codex turn ${status}`),
          status,
        );
        return;
      }
      case "error":
        if (staleTurn) {
          this.#emit(compactEvent(msg));
          return;
        }
        this.lastError = clampText(
          JSON.stringify(params.error || params),
          4000,
        );
        this.#emit(compactEvent(msg));
        this.#settleTurn(new Error(this.lastError));
        return;
      case "thread/tokenUsage/updated":
        this.tokenUsage = params.tokenUsage || this.tokenUsage;
        return;
      default:
        this.#emit(compactEvent(msg));
    }
  }

  #settleTurn(err, status) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.currentTurnId = null;
    this.turnCount += 1;
    this.updatedAt = nowIso();
    if (err) {
      this.lastError = err.message;
      this.#setStatus("failed", false, {
        source: "turn_error",
        error: err.message,
      });
      this.#emitError(err);
      turn.reject(err);
      return;
    }
    this.lastAssistantText = clampText(
      this.finalAnswer ||
        this.lastAgentMessage ||
        this.lastAssistantText ||
        "",
    );
    this.#setStatus("idle", false, {
      source: "turn/completed",
      status,
    });
    turn.resolve();
  }

  #ignoreTurn(turnId) {
    this.ignoredTurnIds.add(turnId);
    // Bound the set; only a few turns are ever in flight around an abort.
    if (this.ignoredTurnIds.size > 32) {
      const oldest = this.ignoredTurnIds.values().next().value;
      this.ignoredTurnIds.delete(oldest);
    }
  }

  // ── public methods ────────────────────────────────────────────────

  async send(message, options = {}) {
    if (!message || !String(message).trim())
      throw new Error("message is required.");
    if (this.status === "closed")
      throw new Error(`Codex session ${this.id} is closed.`);
    if (!this.proc || this.proc.exitCode !== null)
      throw new Error(
        `Codex app-server for ${this.id} is not running.`,
      );
    if (this.turn)
      throw new Error(
        `Codex session ${this.id} already has a running turn.`,
      );
    if (!this.threadId)
      throw new Error("Codex session is not started.");

    this.finalAnswer = "";
    this.lastAgentMessage = "";
    this.lastAssistantText = "";
    this.#setStatus("running", true, { source: "send" });

    const done = new Promise((resolve, reject) => {
      this.turn = { resolve, reject };
    });
    const myTurn = this.turn;
    // Guard against unhandledRejection taking down the daemon if the turn rejects
    // (process crash / error notification) before a waiter is attached below.
    done.catch(() => {});

    let turnResp;
    // Capture the request id so a turn/start that times out can still handle a late
    // response: the app-server may yet return a turn id and run that turn untracked.
    const startReqId = this.nextId;
    try {
      turnResp = await withTimeout(
        this.#request("turn/start", {
          threadId: this.threadId,
          input: [
            {
              type: "text",
              text: String(message),
              text_elements: [],
            },
          ],
          model: this.model,
          effort: this.effort,
          outputSchema: null,
        }),
        30000,
        "Timed out starting Codex turn.",
      );
    } catch (err) {
      // Replace the pending handler so a late turn/start response interrupts and
      // ignores the orphaned turn instead of letting its events drive a later turn.
      if (this.pending.has(startReqId)) {
        this.pending.set(startReqId, {
          resolve: (result) => {
            const lateId = result?.turn?.id;
            if (lateId) {
              this.#ignoreTurn(lateId);
              if (this.threadId && this.proc && this.proc.exitCode === null) {
                this.#request("turn/interrupt", {
                  threadId: this.threadId,
                  turnId: lateId,
                }).catch(() => {});
              }
            }
          },
          reject: () => {},
        });
      }
      if (this.turn === myTurn) {
        this.turn = null;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.#emitError(err instanceof Error ? err : new Error(this.lastError));
        if (this.status !== "closed")
          this.#setStatus("idle", false, {
            source: "turn_start_error",
          });
      }
      throw err instanceof Error ? err : new Error(this.lastError);
    }
    const startedTurnId = turnResp?.turn?.id || null;
    if (this.turn !== myTurn) {
      // abort()/close() ran while turn/start was in flight, so it couldn't interrupt a
      // turn whose id was still unknown. Interrupt it now and ignore its trailing events.
      if (startedTurnId) {
        this.#ignoreTurn(startedTurnId);
        if (this.threadId && this.proc && this.proc.exitCode === null) {
          this.#request("turn/interrupt", {
            threadId: this.threadId,
            turnId: startedTurnId,
          }).catch(() => {});
        }
      }
      return {
        accepted: false,
        session_id: this.id,
        status: this.status,
      };
    }
    this.currentTurnId = startedTurnId || this.currentTurnId;
    const initialStatus = turnResp?.turn?.status;
    // Only a known-terminal status from the start response settles synchronously;
    // queued/pending/inProgress/unknown stay in flight and are driven by notifications.
    const TERMINAL = new Set([
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "error",
    ]);
    if (initialStatus && TERMINAL.has(initialStatus)) {
      const failed = initialStatus !== "completed";
      this.#settleTurn(
        failed ? new Error(`codex turn ${initialStatus}`) : null,
        initialStatus,
      );
      if (failed) throw new Error(`codex turn ${initialStatus}`);
    }

    if (options.wait) {
      try {
        return await withTimeout(
          done.then(() => this.result()),
          options.timeout_ms || DEFAULT_WAIT_TIMEOUT_MS,
          "Timed out waiting for Codex turn.",
        );
      } catch (err) {
        // On a wait timeout the turn is still pending; interrupt the backend turn
        // and clear it so the session stays reusable instead of wedged at running.
        if (this.turn) {
          try {
            await this.abort();
          } catch {}
        }
        throw err;
      }
    }
    done.catch((err) => {
      this.lastError = err.message;
    });
    return { accepted: true, session_id: this.id, status: this.status };
  }

  result() {
    return {
      session: this.summary(),
      text: this.lastAssistantText || null,
      recent_events: this.events.slice(-20),
      log_file: this.logFile,
    };
  }

  async abort() {
    const interruptedTurnId = this.currentTurnId;
    if (this.threadId && this.currentTurnId) {
      try {
        await withTimeout(
          this.#request("turn/interrupt", {
            threadId: this.threadId,
            turnId: this.currentTurnId,
          }),
          5000,
          "codex interrupt timeout",
        );
      } catch {}
    }
    const turn = this.turn;
    this.turn = null;
    this.currentTurnId = null;
    // Reject any trailing notifications from the interrupted turn so a late
    // turn/completed or delta cannot settle/contaminate a subsequent turn.
    if (interruptedTurnId) this.#ignoreTurn(interruptedTurnId);
    // Only return to idle if the app-server is still alive; otherwise leave the
    // failed/closed status instead of masking a dead backend as reusable.
    if (
      this.status !== "closed" &&
      this.proc &&
      this.proc.exitCode === null
    ) {
      this.#setStatus("idle", false, { source: "abort" });
    }
    turn?.resolve?.();
    return { aborted: true, session_id: this.id };
  }

  summary() {
    return {
      id: this.id,
      agent: this.agent,
      cwd: this.cwd,
      write: this.write,
      model: this.model,
      effort: this.effort,
      status: this.status,
      isStreaming: this.isStreaming,
      pid: this.proc?.pid || null,
      threadId: this.threadId,
      turnCount: this.turnCount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      logFile: this.logFile,
    };
  }

  close() {
    this.#setStatus("closed", false, { source: "close" });
    try {
      this.proc?.stdin?.end();
    } catch {}
    // Reject the active turn AND every in-flight RPC (turn/start, turn/interrupt, ...)
    // so nothing is left pending; the proc "close" handler early-returns once closed.
    this.#rejectAll(new Error("session closed"));
    const pid = this.proc?.pid;
    terminateProcessTree(pid);
    scheduleForceKill(pid);
    return { closed: true, session_id: this.id };
  }
}

// ── Exports ──────────────────────────────────────────────────────────

/**
 * Open a backend session for the given agent.
 *
 * @param {Object} params
 * @param {'omp'|'codex'} params.agent
 * @param {string} params.cwd — absolute working directory
 * @param {boolean} [params.write=false]
 * @param {string} [params.model]
 * @param {string} [params.effort]
 * @param {Function} [params.spawnImpl] — replacement for child_process.spawn (test injection)
 * @returns {Promise<OmpSession|CodexSession>}
 */
export async function openBackend({
  agent,
  cwd,
  write = false,
  model,
  effort,
  spawnImpl,
}) {
  ensureDirs();
  assertAgent(agent);
  const effectiveSpawn = spawnImpl || _defaultSpawn;
  const options = { cwd, write, model, effort, spawn: effectiveSpawn };
  const session =
    agent === "omp"
      ? new OmpSession(options)
      : new CodexSession(options);
  try {
    await session.start();
  } catch (err) {
    try { await session.close(); } catch {}
    throw err;
  }
  return session;
}

/**
 * Check availability of omp and codex on this machine.
 *
 * @returns {{ omp: { available: boolean, version: string|null }, codex: { available: boolean, version: string|null } }}
 */
export function doctor() {
  const result = {};
  for (const [agent, config] of Object.entries(AGENTS)) {
    const bin = agentBin(agent);
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
    result[agent] = {
      available: probe.status === 0,
      version: probe.status === 0
        ? stripAnsi(probe.stdout || probe.stderr).trim()
        : null,
    };
  }
  return result;
}

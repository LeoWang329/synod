// synod/src/backends/generic-cli.mjs — 声明式接入任意一次性 CLI。
//
// 模型:每次 send spawn 一次 `bin args… [prompt]`,stdout 流式即 delta,
// 进程退出(code 0)即 turn 完成;close() 杀在飞进程。
// 诚实限制:无持久会话状态(每 turn 独立进程),flow 的 reuse 对它只是
// 复用"逻辑会话"对象,不带对话记忆;有状态/协议型 CLI 用 type:"module"。
//
// spec: { bin, args?: string[], promptVia?: "arg"|"stdin",
//         modelFlag?: string, versionArgs?: string[], timeoutMs?: number }

import { EventEmitter } from "node:events";
import { spawn as _defaultSpawn, spawnSync, ChildProcess } from "node:child_process";
import {
  spawnPlan, assertCwd, makeId, nowIso, stripAnsi, clampText, withTimeout,
  terminateProcessTree, scheduleForceKill, probeCliVersion,
} from "../backend.mjs";
import { writePidRecord, removePidRecord } from "../pid-registry.mjs";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

class GenericCliSession extends EventEmitter {
  constructor(name, spec, options) {
    super();
    this.id = makeId(name);
    this.agent = name;
    this.cwd = assertCwd(options.cwd);
    this.write = Boolean(options.write);       // 声明式 CLI 无权限语义,仅记录
    this.model = options.model ?? null;
    this.effort = options.effort ?? null;
    this.status = "idle";
    this.isStreaming = false;
    this.lastAssistantText = "";
    this.lastError = null;
    this.turnCount = 0;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.proc = null;                          // 在飞 turn 的子进程(shutdown 读 .pid)
    this._spec = spec;
    this._spawn = options.spawn || _defaultSpawn;
    this._detached = !IS_WINDOWS;
  }

  #setStatus(status, isStreaming) {
    const changed = this.status !== status || this.isStreaming !== isStreaming;
    this.status = status;
    this.isStreaming = isStreaming;
    this.updatedAt = nowIso();
    if (changed) this.emit("status", { status, isStreaming });
  }

  async send(message, { wait = true, timeout_ms } = {}) {
    if (!message || !String(message).trim()) throw new Error("message is required.");
    if (this.status === "closed") throw new Error(`session ${this.id} is closed.`);
    if (this.status === "running") {
      throw new Error(`session ${this.id} already has a running turn.`);
    }
    const spec = this._spec;
    const args = [...(spec.args ?? [])];
    if (this.model && spec.modelFlag) args.push(spec.modelFlag, this.model);
    const promptVia = spec.promptVia ?? "arg";
    if (promptVia === "arg") args.push(String(message));

    const plan = spawnPlan(spec.bin, args);
    this.#setStatus("running", true);
    this.lastAssistantText = "";

    const proc = this._spawn(plan.command, plan.args, {
      cwd: this.cwd, env: process.env,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      detached: this._detached,
    });
    this.proc = proc;
    writePidRecord({ sessionId: this.id, pid: proc.pid, bin: this.agent });
    let stderrTail = "";
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.lastAssistantText = clampText(this.lastAssistantText + text);
      this.emit("delta", text);
    });
    proc.stderr.on("data", (chunk) => {
      stderrTail = clampText(stderrTail + chunk.toString("utf8"), 4000);
    });
    if (promptVia === "stdin") proc.stdin.end(String(message));
    else proc.stdin.end();

    const turnDone = new Promise((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code, signal) => {
        if (this.status === "closed") {
          reject(new Error(`session ${this.id} closed.`));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            `${this.agent} exited with code ${code ?? `signal ${signal}`}` +
            `${stderrTail ? `: ${stripAnsi(stderrTail).trim()}` : ""}`,
          ));
        }
      });
    });

    const finish = (async () => {
      try {
        await withTimeout(
          turnDone,
          timeout_ms ?? spec.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
          `Timed out waiting for ${this.id} turn.`,
        );
      } catch (err) {
        this.lastError = err.message;
        // 超时/关闭:在飞进程必须死(组杀,孙进程一起收)
        if (proc.exitCode === null && proc.signalCode === null) {
          terminateProcessTree(proc.pid, "SIGKILL", { group: this._detached && proc instanceof ChildProcess });
        }
        throw err;
      } finally {
        this.proc = null;
        removePidRecord(this.id);
        this.turnCount += 1;
        if (this.status !== "closed") this.#setStatus("idle", false);
      }
    })();

    if (wait) {
      await finish;
      return this.result();
    }
    finish.catch(() => {});
    return { accepted: true, session_id: this.id, status: this.status };
  }

  result() {
    return {
      session: this.summary(),
      text: this.lastAssistantText || null,
      recent_events: [],
      log_file: null,
    };
  }

  async abort() {
    const proc = this.proc;
    if (proc?.pid) terminateProcessTree(proc.pid, "SIGTERM", { group: this._detached && proc instanceof ChildProcess });
    return { aborted: true, session_id: this.id };
  }

  summary() {
    return {
      id: this.id, agent: this.agent, cwd: this.cwd, write: this.write,
      model: this.model, effort: this.effort,
      status: this.status, isStreaming: this.isStreaming, turnCount: this.turnCount,
      pid: this.proc?.pid ?? null,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
      lastError: this.lastError, logFile: null, sessionState: null,
    };
  }

  close() {
    this.#setStatus("closed", false);
    const proc = this.proc;
    if (proc?.pid) {
      terminateProcessTree(proc.pid, "SIGTERM", { group: this._detached && proc instanceof ChildProcess });
      // SIGTERM 现在,3s 后 SIGKILL 兜底(对 SIGTERM-免疫的外部 CLI),
      // 与内建会话一致;进程退出时 closeAllLiveSessionsSync 再兜底一层。
      scheduleForceKill(proc, 3000, { group: this._detached && proc instanceof ChildProcess });
    }
    this.proc = null;
    removePidRecord(this.id);
    return { closed: true, session_id: this.id };
  }
}

export function makeGenericCliAdapter(name, spec) {
  if (!spec || typeof spec.bin !== "string" || !spec.bin) {
    throw new Error(`backend "${name}": spec.bin is required`);
  }
  const promptVia = spec.promptVia ?? "arg";
  if (promptVia !== "arg" && promptVia !== "stdin") {
    throw new Error(`backend "${name}": promptVia must be "arg" or "stdin", got "${promptVia}"`);
  }
  return {
    name,
    doctor: () => probeCliVersion(spec.bin, spec.versionArgs ?? ["--version"]),
    async open(options) {
      return new GenericCliSession(name, spec, options);
    },
  };
}

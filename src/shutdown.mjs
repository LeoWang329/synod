// synod/src/shutdown.mjs — 全局活跃会话注册表 + 统一退出收口。
//
// 所有经 openBackend 出生的会话都注册到这里(backend.mjs 单点接入),
// REPL / flow / 未来 team 的会话因此对所有退出路径可见——这是对
// V1 文档 P0-2「双会话路径」问题的根治。
//
// 崩溃路径(uncaughtException)必须全同步,所以核心清理是
// closeAllLiveSessionsSync:close()(POSIX 发 SIGTERM / win32 同步强杀)
// → 同步宽限轮询 → 幸存者组 SIGKILL。

const _live = new Set();

export function trackSession(session) { _live.add(session); }
export function untrackSession(session) { _live.delete(session); }
export function liveSessions() { return [..._live]; }
export function _clearForTests() { _live.clear(); }

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 同步 sleep(不依赖子进程):Node 主线程允许 Atomics.wait。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 同步硬清理:close 全部会话,POSIX 上宽限轮询后对幸存 PID 补组/单体
 * SIGKILL。必须能在 process.exit 之前同步完成(P0-4 的兜底——原
 * scheduleForceKill 的 unref 定时器在立即退出的路径上永远不触发)。
 */
export function closeAllLiveSessionsSync({ graceMs = 500 } = {}) {
  const sessions = liveSessions();
  const pids = [];
  for (const s of sessions) {
    const pid = s.proc?.pid;
    // P1-30:只收集仍在运行的子进程 pid(exitCode/signalCode 皆 null);已退出的
    // 陈旧 pid 可能被 OS 复用,SIGKILL 它=误杀。fake(无 signalCode 字段)→ undefined
    // !== null 为真,但其 pid 为 null 已被 Number.isInteger 挡掉,二者叠加安全。
    if (Number.isInteger(pid) && pid > 1 &&
        s.proc.exitCode === null && (s.proc.signalCode ?? null) === null) {
      pids.push(pid);
    }
    try { s.close(); } catch {}
  }
  _live.clear();
  if (process.platform === "win32") return; // taskkill /T /F 已同步强杀

  const deadline = Date.now() + graceMs;
  let survivors = pids.filter(isAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    sleepSync(50);
    survivors = survivors.filter(isAlive);
  }
  for (const pid of survivors) {
    // 先试进程组(detached 子进程是组长,连孙进程一起收),再退化单体。
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

/**
 * 优雅一轮:并行 abort(限时)→ 同步硬清理。信号路径用。
 */
export async function gracefulShutdown({ abortTimeoutMs = 3000, graceMs = 500 } = {}) {
  await Promise.all(liveSessions().map((s) =>
    Promise.race([
      (async () => { try { await s.abort(); } catch {} })(),
      new Promise((r) => { const t = setTimeout(r, abortTimeoutMs); t.unref?.(); }),
    ]),
  ));
  closeAllLiveSessionsSync({ graceMs });
}

/**
 * 统一退出矩阵(修 V1 文档 P0-1 / P0-3):
 *   SIGTERM → 优雅 → exit(143)        SIGHUP → 优雅 → exit(129)
 *   uncaughtException / unhandledRejection → 同步硬清理 → exit(1)
 *   SIGINT:interactiveSigint=true 保留 cli 原"一次优雅 exit(0) /
 *   二次强杀 exit(1)"语义;false(flow 单跑)一次优雅 exit(130)。
 *
 * proc/stderr/exit 可注入以便单测;生产调用方只传 interactiveSigint。
 */
export function installShutdownHandlers({
  proc = process,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
  interactiveSigint = false,
} = {}) {
  proc.on("uncaughtException", (err) => {
    stderr.write(`synod: uncaught: ${err.stack || err.message}\n`);
    closeAllLiveSessionsSync();
    exit(1);
  });
  proc.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    stderr.write(`synod: unhandled rejection: ${msg}\n`);
    closeAllLiveSessionsSync();
    exit(1);
  });
  const graceful = (code) => () => {
    stderr.write("\nsynod: terminating, cleaning up...\n");
    gracefulShutdown().finally(() => exit(code));
  };
  proc.on("SIGTERM", graceful(143));
  proc.on("SIGHUP", graceful(129));

  let sigintCount = 0;
  proc.on("SIGINT", () => {
    sigintCount += 1;
    if (liveSessions().length === 0) {
      exit(interactiveSigint ? 0 : 130);
      return;
    }
    if (sigintCount > 1) {
      stderr.write("\nForce exiting...\n");
      closeAllLiveSessionsSync();
      exit(1);
      return;
    }
    stderr.write("\nInterrupted. Cleaning up...\n");
    gracefulShutdown().finally(() => exit(interactiveSigint ? 0 : 130));
  });
}

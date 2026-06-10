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
    if (Number.isInteger(pid) && pid > 1) pids.push(pid);
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

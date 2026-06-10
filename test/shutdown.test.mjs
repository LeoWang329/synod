// test/shutdown.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  trackSession, untrackSession, liveSessions,
  closeAllLiveSessionsSync, _clearForTests,
} from "../src/shutdown.mjs";

function makeStubSession() {
  return {
    aborted: false, closed: false, proc: undefined,
    async abort() { this.aborted = true; },
    close() { this.closed = true; return { closed: true }; },
  };
}

async function pollDead(pids, timeoutMs) {
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    alive = pids.filter(isAlive);
  }
  return alive;
}

test("track/untrack/liveSessions 基本语义", () => {
  _clearForTests();
  const s = makeStubSession();
  trackSession(s);
  assert.deepEqual(liveSessions(), [s]);
  trackSession(s); // 幂等(Set 语义)
  assert.equal(liveSessions().length, 1);
  untrackSession(s);
  assert.deepEqual(liveSessions(), []);
});

test("closeAllLiveSessionsSync 对每个会话调 close 并清空注册表", () => {
  _clearForTests();
  const a = makeStubSession(); const b = makeStubSession();
  trackSession(a); trackSession(b);
  closeAllLiveSessionsSync();
  assert.equal(a.closed, true);
  assert.equal(b.closed, true);
  assert.equal(liveSessions().length, 0);
});

test("close 抛错不阻断其余会话清理", () => {
  _clearForTests();
  const bad = { proc: undefined, close() { throw new Error("boom"); }, async abort() {} };
  const good = makeStubSession();
  trackSession(bad); trackSession(good);
  closeAllLiveSessionsSync(); // 不得抛出
  assert.equal(good.closed, true);
});

// P0-4 的核心保障:SIGTERM 免疫的子进程在宽限后被 SIGKILL 兜底击杀。
// 子进程 detached(自成进程组),close() 只发 SIGTERM(被忽略)——
// 只有 closeAllLiveSessionsSync 的兜底能杀死它。
test("SIGTERM 免疫的真实子进程在 graceMs 后被 SIGKILL 兜底",
  { skip: process.platform === "win32" }, async () => {
  _clearForTests();
  const child = spawn(process.execPath, ["-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
  ], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300)); // 等 handler 装好
  trackSession({
    proc: child,
    async abort() {},
    close() { try { process.kill(child.pid, "SIGTERM"); } catch {} },
  });
  closeAllLiveSessionsSync({ graceMs: 400 });
  const alive = await pollDead([child.pid], 2000);
  assert.deepEqual(alive, [], "SIGKILL 兜底必须杀死 SIGTERM 免疫的子进程");
});

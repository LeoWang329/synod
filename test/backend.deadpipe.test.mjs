// test/backend.deadpipe.test.mjs — P0-27/P1-30/P2-32/P2-33:内置会话死管道门控与收尸。
import test from "node:test";
import assert from "node:assert/strict";
import { openBackend } from "../src/backend.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";
import { liveSessions, _clearForTests } from "../src/shutdown.mjs";

test("P0-27 OmpSession.request 在 proc 退出后同步拒绝(不裸写死管道)", async () => {
  _clearForTests();
  const proc = makeFakeOmpProc();
  const s = await openBackend({ agent: "omp", cwd: process.cwd(), spawnImpl: () => proc });
  // 模拟后端进程已死:exitCode 置数,但会话对象仍在
  proc.exitCode = 1;
  // request 走门控:抛同步错误而不是对死管道 stdin.write
  assert.throws(() => s.request("get_state"), /not writable|not running|closed/i);
  s.close();
  _clearForTests();
});

test("P0-27 OmpSession.send 守卫补 signalCode(SIGKILL 后 exitCode===null)", async () => {
  _clearForTests();
  const proc = makeFakeOmpProc();
  const s = await openBackend({ agent: "omp", cwd: process.cwd(), spawnImpl: () => proc });
  proc.exitCode = null;
  proc.signalCode = "SIGKILL";              // 被信号杀:exitCode 仍 null
  await assert.rejects(s.send("hi", { wait: true }), /not running/);
  s.close();
  _clearForTests();
});

test("P0-27 OmpSession.abort 对已死 proc 不抛、直接回 idle", async () => {
  _clearForTests();
  const proc = makeFakeOmpProc();
  const s = await openBackend({ agent: "omp", cwd: process.cwd(), spawnImpl: () => proc });
  proc.exitCode = 1;
  const r = await s.abort();                // 不得抛 EPIPE/not writable
  assert.equal(r.aborted, true);
  s.close();
  _clearForTests();
});

test("P0-27 OmpSession stdin 'error' 被监听:写死管道 EPIPE 不冒泡成 uncaughtException", async () => {
  _clearForTests();
  const proc = makeFakeOmpProc();
  const s = await openBackend({ agent: "omp", cwd: process.cwd(), spawnImpl: () => proc });
  // 直接在 stdin 上 emit 'error':若无监听,Node 会抛 uncaughtException 让进程崩
  let caught = null;
  s.on("error", (e) => { caught = e; });
  proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.ok(caught && /EPIPE/.test(caught.message), "stdin error 应被会话捕获并转 error 事件");
  s.close();
  _clearForTests();
});

test("P2-33 OmpSession spawn 成功即 track(不等 ready)", async () => {
  _clearForTests();
  // ready 永不发:start() 会卡在 readyPromise;但 spawn 后应已 track。
  const proc = makeFakeOmpProc({ sendReady: false });
  proc.pid = 4242;                          // 给个正整数 pid 让登记生效
  const p = openBackend({ agent: "omp", cwd: process.cwd(), spawnImpl: () => proc });
  // 轮询:spawn 同步发生在 start() 内,track 紧随其后
  const deadline = Date.now() + 1000;
  while (liveSessions().length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(liveSessions().length, 1, "spawn 后应立即可见于 liveSessions");
  // 收尾:让 start 失败(超时由生产 60s,这里直接 emit close 触发 reject)
  proc.exitCode = 1; proc.emit("close", 1, null);
  await assert.rejects(p);
  _clearForTests();
});

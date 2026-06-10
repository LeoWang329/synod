// test/shutdown-handlers.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  trackSession, _clearForTests, installShutdownHandlers,
} from "../src/shutdown.mjs";

function makeStubSession({ abortNeverResolves = false } = {}) {
  return {
    aborted: false, closed: false, proc: undefined,
    async abort() {
      this.aborted = true;
      if (abortNeverResolves) await new Promise(() => {});
    },
    close() { this.closed = true; return { closed: true }; },
  };
}

function setup(opts = {}) {
  _clearForTests();
  const proc = new EventEmitter();
  const writes = [];
  const stderr = { write(s) { writes.push(s); } };
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  installShutdownHandlers({
    proc, stderr,
    exit: (code) => resolveExit(code),
    interactiveSigint: opts.interactiveSigint ?? false,
  });
  return { proc, writes, exited };
}

test("SIGTERM → abort + close 全部会话,exit(143)", async () => {
  const { proc, exited } = setup();
  const s = makeStubSession();
  trackSession(s);
  proc.emit("SIGTERM");
  assert.equal(await exited, 143);
  assert.equal(s.aborted, true);
  assert.equal(s.closed, true);
});

test("SIGHUP → 同优雅路径,exit(129)", async () => {
  const { proc, exited } = setup();
  const s = makeStubSession();
  trackSession(s);
  proc.emit("SIGHUP");
  assert.equal(await exited, 129);
  assert.equal(s.closed, true);
});

test("uncaughtException → 同步 close(不 abort),exit(1)", async () => {
  const { proc, exited, writes } = setup();
  const s = makeStubSession();
  trackSession(s);
  proc.emit("uncaughtException", new Error("boom"));
  assert.equal(await exited, 1);
  assert.equal(s.closed, true);
  assert.equal(s.aborted, false, "崩溃路径必须全同步,不得 await abort");
  assert.ok(writes.join("").includes("boom"));
});

test("unhandledRejection → 同步 close,exit(1)", async () => {
  const { proc, exited } = setup();
  const s = makeStubSession();
  trackSession(s);
  proc.emit("unhandledRejection", new Error("nope"));
  assert.equal(await exited, 1);
  assert.equal(s.closed, true);
});

test("interactive SIGINT:一次优雅 exit(0),abort 卡住时二次强杀 exit(1)", async () => {
  const { proc, exited, writes } = setup({ interactiveSigint: true });
  const s = makeStubSession({ abortNeverResolves: true });
  trackSession(s);
  proc.emit("SIGINT");                       // 第一次:优雅路径开跑(挂在 abort 上)
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.aborted, true);
  proc.emit("SIGINT");                       // 第二次:同步强杀
  assert.equal(await exited, 1);
  assert.equal(s.closed, true);
  assert.ok(writes.join("").includes("Force exiting"));
});

test("非 interactive SIGINT:一次即优雅 exit(130)", async () => {
  const { proc, exited } = setup({ interactiveSigint: false });
  const s = makeStubSession();
  trackSession(s);
  proc.emit("SIGINT");
  assert.equal(await exited, 130);
  assert.equal(s.closed, true);
});

test("无会话时 SIGINT 直接 exit(0/130)", async () => {
  const { proc, exited } = setup({ interactiveSigint: true });
  proc.emit("SIGINT");
  assert.equal(await exited, 0);
});

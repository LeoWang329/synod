// test/backends.generic-cli.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { makeGenericCliAdapter } from "../src/backends/generic-cli.mjs";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "backends");
const NODE = process.execPath;
const cwd = process.cwd();

const echoSpec = { type: "cli", bin: NODE, args: [path.join(FIX, "echo-cli.mjs")], promptVia: "arg" };

test("spec 校验:缺 bin / 非法 promptVia 拒绝", () => {
  assert.throws(() => makeGenericCliAdapter("x", {}), /bin is required/);
  assert.throws(() => makeGenericCliAdapter("x", { bin: "a", promptVia: "env" }), /promptVia/);
});

test("promptVia:arg — send 返回 stdout 文本,delta/status 事件齐全", async () => {
  const adapter = makeGenericCliAdapter("echo", echoSpec);
  const session = await adapter.open({ cwd });
  const deltas = [];
  const statuses = [];
  session.on("delta", (d) => deltas.push(d));
  session.on("status", (s) => statuses.push(s.status));
  const r = await session.send("hello world", { wait: true });
  assert.match(r.text, /echo: hello world/);
  assert.match(deltas.join(""), /echo: hello world/);
  assert.deepEqual(statuses, ["running", "idle"]);
  assert.equal(session.summary().turnCount, 1);
  session.close();
});

test("promptVia:stdin", async () => {
  const adapter = makeGenericCliAdapter("echo-stdin", {
    type: "cli", bin: NODE, args: [path.join(FIX, "echo-cli.mjs")], promptVia: "stdin",
  });
  const session = await adapter.open({ cwd });
  const r = await session.send("via stdin", { wait: true });
  assert.match(r.text, /echo-stdin: via stdin/);
  session.close();
});

test("非零退出 → send 拒绝并携带 stderr", async () => {
  const adapter = makeGenericCliAdapter("fail", {
    type: "cli", bin: NODE, args: [path.join(FIX, "fail-cli.mjs")], promptVia: "arg",
  });
  const session = await adapter.open({ cwd });
  await assert.rejects(session.send("x", { wait: true }), /exited with code 2.*boom/s);
  assert.equal(session.status, "idle", "失败后会话可复用");
  session.close();
});

test("timeout_ms 超时 → 拒绝且在飞进程被杀", async () => {
  const adapter = makeGenericCliAdapter("sleepy", {
    type: "cli", bin: NODE, args: [path.join(FIX, "sleep-cli.mjs")], promptVia: "arg",
  });
  const session = await adapter.open({ cwd });
  const before = Date.now();
  await assert.rejects(session.send("x", { wait: true, timeout_ms: 300 }), /Timed out/);
  assert.ok(Date.now() - before < 5000);
  const pid = session.proc?.pid;
  assert.equal(pid ?? null, null, "超时后 proc 引用应已清空");
  session.close();
});

test("运行中 close → 杀在飞进程,会话不可再用", async () => {
  const adapter = makeGenericCliAdapter("sleepy2", {
    type: "cli", bin: NODE, args: [path.join(FIX, "sleep-cli.mjs")], promptVia: "arg",
  });
  const session = await adapter.open({ cwd });
  const p = session.send("x", { wait: true }).catch(() => "killed");
  await new Promise((r) => setTimeout(r, 200));
  const pid = session.proc?.pid;
  assert.ok(pid, "send 进行中应有在飞进程");
  session.close();
  assert.equal(await p, "killed");
  await assert.rejects(session.send("y"), /closed/);
  // 进程消亡
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(pid, 0));
});

test("并发 send → 第二个拒绝(running 守卫)", async () => {
  const adapter = makeGenericCliAdapter("sleepy3", {
    type: "cli", bin: NODE, args: [path.join(FIX, "sleep-cli.mjs")], promptVia: "arg",
  });
  const session = await adapter.open({ cwd });
  const p = session.send("a", { wait: true, timeout_ms: 1000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(session.send("b"), /already has a running turn/);
  await p;
  session.close();
});

test("timeout — 在飞进程真的被杀(OS 层)", async () => {
  const adapter = makeGenericCliAdapter("sleepy-os", {
    type: "cli", bin: NODE, args: [path.join(FIX, "sleep-cli.mjs")], promptVia: "arg",
  });
  const session = await adapter.open({ cwd });
  let capturedPid;
  // 在超时(300ms)前轮询拿到在飞子进程 pid。
  const p = assert.rejects(session.send("x", { wait: true, timeout_ms: 300 }), /Timed out/);
  const t0 = Date.now();
  while (!capturedPid && Date.now() - t0 < 250) {
    if (session.proc?.pid) capturedPid = session.proc.pid;
    await new Promise((r) => setTimeout(r, 10));
  }
  await p;
  assert.ok(capturedPid, "应捕获到在飞子进程 pid");
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(capturedPid, 0), "超时后 OS 进程必须已消亡");
  session.close();
});

test("abort() 杀在飞进程", async () => {
  const adapter = makeGenericCliAdapter("aborty", {
    type: "cli", bin: NODE, args: [path.join(FIX, "sleep-cli.mjs")], promptVia: "arg",
  });
  const session = await adapter.open({ cwd });
  const p = session.send("x", { wait: true }).catch(() => "ended");
  await new Promise((r) => setTimeout(r, 200));
  const pid = session.proc?.pid;
  assert.ok(pid, "应有在飞进程");
  await session.abort();
  await p;
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(pid, 0), "abort 后进程应消亡");
  session.close();
});

// 注入式 fake 子进程:EventEmitter + 可读 stdout/stderr + 可写 stdin,
// pid=null(无真实 OS pid,验证组杀/PID 记录对 fake 安全),microtask 内即收 close。
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = new Writable({ write(c, e, cb) { cb(); } });
  proc.pid = null;
  proc.exitCode = null; proc.signalCode = null;
  queueMicrotask(() => { proc.stdout.push(null); proc.emit("close", 0, null); });
  return proc;
}

test("modelFlag — model 存在时注入 [modelFlag, model]", async () => {
  let capturedArgs;
  const adapter = makeGenericCliAdapter("mf", {
    type: "cli", bin: NODE, args: ["base"], promptVia: "arg", modelFlag: "--model",
  });
  const session = await adapter.open({ cwd, model: "m-7b", spawn: (cmd, args) => { capturedArgs = args; return fakeProc(); } });
  await session.send("hi", { wait: true });
  assert.deepEqual(capturedArgs, ["base", "--model", "m-7b", "hi"]);
  session.close();
});

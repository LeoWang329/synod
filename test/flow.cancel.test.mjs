// test/flow.cancel.test.mjs — §4.7-3:runId 级 AbortSignal,abort 时原语协作取消。
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/flow/runtime.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {} };

function slowSession(deltas, ms) {
  const s = new FakeSession({ deltas });
  const orig = s.send.bind(s);
  s.send = async (m, o) => { await new Promise((r) => setTimeout(r, ms)); return orig(m, o); };
  return s;
}

test("abortRun 在 agent send 进行中触发 → agent 抛 AbortError 且会话被 close", async () => {
  let opened;
  const runtime = createRuntime({
    openBackend: async () => (opened = slowSession(["ok"], 200)),
    fs: nullFs, clock: () => 0,
  });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  const p = runtime.agent(ctx, { agent: "omp", prompt: "x" });
  setTimeout(() => runtime.abortRun(ctx), 30);
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.equal(opened._closed, true, "abort 必须 close 在飞会话(杀进程)");
});

test("外部 signal(CLI Ctrl-C)→ 链接到 run controller", async () => {
  const external = new AbortController();
  const runtime = createRuntime({
    openBackend: async () => slowSession(["ok"], 200),
    fs: nullFs, clock: () => 0, signal: external.signal,
  });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  const p = runtime.agent(ctx, { agent: "omp", prompt: "x" });
  setTimeout(() => external.abort(), 30);
  await assert.rejects(p, (e) => e.name === "AbortError");
});

test("opts.signal 显式优先于 run-level signal", async () => {
  const runtime = createRuntime({
    openBackend: async () => slowSession(["ok"], 200),
    fs: nullFs, clock: () => 0,
  });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  const ac = new AbortController();
  const p = runtime.agent(ctx, { agent: "omp", prompt: "x", signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e) => e.name === "AbortError");
});

test("agentLoop 同样接 signal", async () => {
  const runtime = createRuntime({
    openBackend: async () => slowSession(["PASS"], 200),
    fs: nullFs, clock: () => 0,
  });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  const p = runtime.agentLoop(ctx, { agent: "omp", prompt: "go", until: () => true, maxTurns: 3 });
  setTimeout(() => runtime.abortRun(ctx), 30);
  await assert.rejects(p, (e) => e.name === "AbortError");
});

test("abortRun 取消在跑的 bash(SIGTERM 杀子进程)", async () => {
  const runtime = createRuntime({ openBackend: async () => null, fs: nullFs, clock: () => 0 });
  const ctx = runtime.createCtx(undefined, { cwd: process.cwd() });
  const p = runtime.bash(ctx, "sleep 5");          // 长命令
  setTimeout(() => runtime.abortRun(ctx), 50);
  const r = await p;                               // bash 不抛:返回非零 code(被杀)
  assert.notEqual(r.code, 0, "被 abort 的 bash 应以非零 code 收口");
});

test("approve 缺省回落 run-level signal:abortRun → { aborted:true }", async () => {
  const runtime = createRuntime({
    openBackend: async () => null, fs: nullFs, clock: () => 0,
    io: { stdout: { write() {} }, stdin: {}, question: () => new Promise(() => {}) }, // 永不应答
  });
  const ctx = runtime.createCtx(undefined, { cwd: "/tmp" });
  const p = runtime.approve(ctx, { content: "ok?" });
  setTimeout(() => runtime.abortRun(ctx), 30);
  const r = await p;
  assert.equal(r.aborted, true, "run abort 应让 approve 协作返回 aborted");
});

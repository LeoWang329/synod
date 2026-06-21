import { describe, it } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fsReal from "node:fs";
import { createRuntime } from "../src/flow/runtime.mjs";
import { shortHash } from "../src/flow/logger.mjs";

function memoryFs() {
  const files = new Map();
  return {
    async writeFile(p, c) { files.set(p, c); },
    async appendFile(p, c) { files.set(p, (files.get(p) ?? "") + c); },
    get(p) { return files.get(p); },
  };
}

function createFakeIo() {
  const _lines = [];
  const stdout = { write(s) { _lines.push(s); }, get lines() { return _lines; } };
  let _pendingResolve = null, _q = [];
  function feed(line) {
    if (_pendingResolve) { const r = _pendingResolve; _pendingResolve = null; r(line); }
    else _q.push(line);
  }
  return {
    stdout, stdin: { feed },
    question(prompt, { signal } = {}) {
      if (_pendingResolve) throw new Error("a question is already pending");
      if (prompt != null) stdout.write(String(prompt));
      const take = new Promise((res) => { _q.length ? res(_q.shift()) : (_pendingResolve = res); });
      if (!signal) return take;
      if (signal.aborted) { _pendingResolve = null; return Promise.reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); }
      return new Promise((res, rej) => {
        signal.addEventListener("abort", () => { _pendingResolve = null; rej(Object.assign(new Error("Aborted"), { name: "AbortError" })); }, { once: true });
        take.then(res, rej);
      });
    },
  };
}

describe("ask", () => {
  it("返回人打的原始整行（trim）", async () => {
    const io = createFakeIo();
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = rt.createCtx({ input: {} });
    const p = rt.ask(ctx, { question: "你的回答?" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("  我要 A 方案  ");
    assert.strictEqual(await p, "我要 A 方案");
  });

  it('空行返回 ""（不当 abort）', async () => {
    const io = createFakeIo();
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = rt.createCtx({ input: {} });
    const p = rt.ask(ctx, { question: "q" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("");
    assert.strictEqual(await p, "");
  });

  it("/spec 原样透传（不被分类吞）", async () => {
    const io = createFakeIo();
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = rt.createCtx({ input: {} });
    const p = rt.ask(ctx, { question: "q" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("/spec");
    assert.strictEqual(await p, "/spec");
  });

  it("ok / yes / y 当成普通答案（不像 approve 吞成 accept）", async () => {
    const io = createFakeIo();
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    for (const w of ["ok", "yes", "y"]) {
      const ctx = rt.createCtx({ input: {} });
      const p = rt.ask(ctx, { question: "q" });
      await new Promise((r) => setImmediate(r));
      io.stdin.feed(w);
      assert.strictEqual(await p, w, `word ${w}`);
    }
  });

  it("abort signal → null", async () => {
    const io = createFakeIo();
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = rt.createCtx({ input: {} });
    const c = new AbortController();
    const p = rt.ask(ctx, { question: "q", signal: c.signal });
    await new Promise((r) => setImmediate(r));
    c.abort();
    assert.strictEqual(await p, null);
  });

  it("写 step 日志 input=question output=answer", async () => {
    const fs = memoryFs();
    const io = createFakeIo();
    const rt = createRuntime({ fs, clock: () => 0, io });
    const ctx = rt.createCtx({ input: {} });
    const p = rt.ask(ctx, { question: "选哪个?" });
    await new Promise((r) => setImmediate(r));
    io.stdin.feed("B");
    await p;
    const lines = fs.get("run.log.jsonl").trim().split("\n").map(JSON.parse);
    const s = lines.find((l) => l.event === "step:succeeded");
    assert.equal(s.node, "ask");
    assert.equal(s.input, "选哪个?");
    assert.equal(s.output, "B");
  });
});

describe("ask resume/headless", () => {
  it("replay 命中回放上次人答,不再提问", async () => {
    const io = createFakeIo();
    const steps = [{ node: "ask", hash: shortHash("q1"), output: "cached", entry: { aborted: false }, type: "ask" }];
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io, replay: { runId: "R1", steps } });
    const ctx = rt.createCtx({}, { runId: "R1" });   // createCtx(input, {runId}) — runId 是第二参
    // 不 feed 任何输入:命中 replay 直接返回
    assert.strictEqual(await rt.ask(ctx, { question: "q1" }), "cached");
  });

  it("headless 抛 AwaitingHuman + 写断点", async () => {
    const io = createFakeIo();
    const runsRoot = fsReal.mkdtempSync(path.join(os.tmpdir(), "synod-ask-"));
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io, headless: true, runsRoot });
    const ctx = rt.createCtx({}, { runId: "H1" });
    await assert.rejects(() => rt.ask(ctx, { question: "需要你定?" }), /awaiting human/i);
    const cp = JSON.parse(fsReal.readFileSync(path.join(runsRoot, "H1", "checkpoint.json"), "utf8"));
    assert.equal(cp.status, "awaiting-approval");
    assert.equal(cp.stoppedAt.node, "ask");
  });
});

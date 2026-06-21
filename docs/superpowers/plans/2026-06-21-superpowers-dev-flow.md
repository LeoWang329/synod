# Superpowers 开发链 Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 superpowers 的「头脑风暴→spec→写计划→subagent 开发→review」编码成一条 synod flow（4 个子 flow + 薄父 flow），并新增内核原语 `ask()` 支撑自由问答。

**Architecture:** JS 确定性骨架当导演、omp/codex 子 agent 当工人。按产物（spec/plan/diff）切成独立子 flow，父 flow 用 `runWorkflow` 串联 + 接缝可配 `approve` 卡口。子流程间交接用**返回值**（不在仓库写文件，避开 bash 转义 + 第二个新原语；引擎已自动把每个 agent 输出记进 run 工件）。

**Tech Stack:** Node ESM、`node --test`、synod flow 引擎（`src/flow/*`）、agent-bridge 后端（omp/codex）。

## Global Constraints

- flow 文件**只能** `import { ... } from "synod/flow"`（loader 静态校验模块名；具名导出不限）。要副作用走 `bash`。
- 每个循环有上限（人在环 `ask`/`approve` 豁免）。禁 `process.exit`/`SIGINT`。
- 确定性骨架：同 input → 同节点序列。禁用 `Date.now()`/`Math.random()` 决定控制流或拼 prompt。
- 强模型角色（brainstorm/plan/review）= `agent:"codex"`；开发写码 = `agent:"omp"` + `model:"deepseek/deepseek-v4-pro"` + `write:true`。
- `ask()` 工程要求对齐 `approve`：共享单所有者 `io.question`、resume 重放、headless 退出码 5、abort 协作退出、写 `step:*` 日志、DI factory。
- 测试用 fake 后端 + fake io（见 `test/flow.approve.test.mjs` 模板）。`npm test` 必须全绿、既有 e2e 不回归。

---

### Task 1: `ask()` 内核原语

自由问答取人答：返回原始整行，不做 accept/abort/feedback 分类。`/spec`、空行 `""` 原样返回；abort（signal）返回 `null`。

**Files:**
- Create: `src/flow/api/ask.mjs`
- Modify: `src/flow/runtime.mjs`（import + DI 构建 + 挂 runtimeObj）
- Modify: `src/flow/index.mjs`（加 proxy 导出）
- Test: `test/flow.ask.test.mjs`

**Interfaces:**
- Produces: `ask(ctx, { question, prompt?, signal? }) => Promise<string|null>`
  - 正常：返回 `line.trim()`（含 `""`、`"/spec"` 原样）
  - abort：返回 `null`
  - replay 命中：返回 logged output（aborted 条目 → `null`）
  - headless：抛 `awaitingHumanError`（退出码 5）
- Produces: `createAsk({ io, logger, getSignal, getReplay, headless, events, runsRoot, onApprovalNeeded }) => ask`
- Consumes: `writeCheckpoint`, `awaitingHumanError`（`../checkpoint.mjs`）、`shortHash`（`../logger.mjs`）、`io.question`（runtime `makeQuestion`）

- [ ] **Step 1: 写失败测试** `test/flow.ask.test.mjs`

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";

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

  it("空行返回 \"\"（不当 abort）", async () => {
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

  it("ok / yes 当成普通答案（不像 approve 吞成 accept）", async () => {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.ask.test.mjs`
Expected: FAIL（`rt.ask is not a function`）

- [ ] **Step 3: 写 `src/flow/api/ask.mjs`**

```js
/**
 * createAsk — `ask()` 原语:自由问答取人答。
 * 返回人打的原始整行(trim);不做 accept/abort/feedback 分类——这是与 approve 的关键区别。
 * 空行 → "";abort(signal) → null;`/spec` 等命令由调用方解释,ask 原样返回。
 * 工程对齐 approve:共享单所有者 io.question、resume 重放、headless 退出码 5、写 step 日志。
 */
import { writeCheckpoint, awaitingHumanError } from "../checkpoint.mjs";
import { shortHash } from "../logger.mjs";

export function createAsk({ io, logger, getSignal, getReplay, headless = false, events, runsRoot, onApprovalNeeded }) {
  async function ask(ctx, opts = {}) {
    const { question, prompt = "> " } = opts;
    const q = question != null ? String(question) : "";

    // resume 重放:命中即回放,不重新提问。
    const rep = getReplay?.(ctx.runId, { node: "ask", input: q });
    if (rep?.hit) {
      if (rep.entry?.aborted) return null;
      return rep.output ?? "";
    }

    // headless:不等 stdin,打印 + 写断点 + 退出码 5。
    if (headless) {
      if (q) io.stdout.write(q + "\n");
      io.stdout.write("[synod] awaiting human input — run is paused.\n");
      if (runsRoot) {
        try {
          writeCheckpoint(runsRoot, ctx.runId, {
            status: "awaiting-approval",
            stoppedAt: { node: "ask", type: "ask", inputHash: shortHash(q) },
            pending: { content: q },
          });
        } catch { /* 写失败不阻断退出 */ }
      }
      try { events?.emit("approvalNeeded", { runId: ctx.runId, node: "ask", content: q }); } catch {}
      try { onApprovalNeeded?.(ctx); } catch {}
      throw awaitingHumanError({ runId: ctx.runId, node: "ask" });
    }

    const signal = opts.signal ?? getSignal?.(ctx.runId);
    if (q) io.stdout.write(q + "\n");

    let line;
    try {
      const askP = io.question(prompt, { signal });
      if (signal) {
        line = await new Promise((resolve, reject) => {
          if (signal.aborted) { askP.catch(() => {}); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); return; }
          const h = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          signal.addEventListener("abort", h, { once: true });
          askP.then(
            (v) => { signal.removeEventListener("abort", h); resolve(v); },
            (e) => { signal.removeEventListener("abort", h); reject(e); },
          );
        });
      } else {
        line = await askP;
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        await logger.logStep(ctx, { node: "ask", type: "ask", attempt: 1, input: q, output: "", meta: { aborted: true } }).catch(() => {});
        return null;
      }
      throw err;
    }

    const answer = line.trim();
    await logger.logStep(ctx, { node: "ask", type: "ask", attempt: 1, input: q, output: answer, meta: { aborted: false } }).catch(() => {});
    return answer;
  }
  return ask;
}
```

- [ ] **Step 4: 接线 `src/flow/runtime.mjs`**

import 段加：
```js
import { createAsk } from "./api/ask.mjs";
```
在 `const approve = createApprove({...})` 之后加：
```js
const ask = createAsk({
  io: resolvedIo, logger, getSignal: signalFor, getReplay: replayStep,
  headless: Boolean(headless), events, runsRoot, onApprovalNeeded,
});
```
在 `runtimeObj` 里 `approve,` 之后加：
```js
  /** ask() primitive — present a question, return the human's raw line. */
  ask,
```

- [ ] **Step 5: 接线 `src/flow/index.mjs`**

在 `approve` 导出之后加：
```js
export function ask(ctx, opts) {
  return getCurrentRuntime().ask(ctx, opts);
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test test/flow.ask.test.mjs`
Expected: PASS（全部用例绿）

- [ ] **Step 7: 加 replay + headless 用例并通过**

在 `test/flow.ask.test.mjs` 末尾追加：
```js
import { shortHash } from "../src/flow/logger.mjs";
import os from "node:os";
import path from "node:path";
import fsReal from "node:fs";

describe("ask resume/headless", () => {
  it("replay 命中回放上次人答,不再提问", async () => {
    const io = createFakeIo();
    const steps = [{ node: "ask", hash: shortHash("q1"), output: "cached", entry: { aborted: false }, type: "ask" }];
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io });
    const ctx = rt.createCtx({ input: {}, runId: "R1" });
    const rt2 = createRuntime({ fs: memoryFs(), clock: () => 0, io, replay: { runId: "R1", steps } });
    const ctx2 = rt2.createCtx({ input: {}, runId: "R1" });
    // 不 feed 任何输入:命中 replay 直接返回
    assert.strictEqual(await rt2.ask(ctx2, { question: "q1" }), "cached");
  });

  it("headless 抛 AwaitingHuman + 写断点", async () => {
    const io = createFakeIo();
    const runsRoot = fsReal.mkdtempSync(path.join(os.tmpdir(), "synod-ask-"));
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io, headless: true, runsRoot });
    const ctx = rt.createCtx({ input: {}, runId: "H1" });
    await assert.rejects(() => rt.ask(ctx, { question: "需要你定?" }), /awaiting human/i);
    const cp = JSON.parse(fsReal.readFileSync(path.join(runsRoot, "H1", "checkpoint.json"), "utf8"));
    assert.equal(cp.status, "awaiting-approval");
    assert.equal(cp.stoppedAt.node, "ask");
  });
});
```
Run: `node --test test/flow.ask.test.mjs` → Expected: PASS

- [ ] **Step 8: 全量回归 + 提交**

Run: `npm test`
Expected: 既有用例全绿（无回归）。
```bash
git add src/flow/api/ask.mjs src/flow/runtime.mjs src/flow/index.mjs test/flow.ask.test.mjs
git commit -m "feat(flow): ask() 原语 — 自由问答取人答(补 approve 分类坑)"
```

---

### Task 2: `parsePlan()` 纯函数

把 plan 文本解析成有序 task 列表。内联在 `execute-plan.mjs` 里（flow 只能 import synod/flow），但 `export` 出来供单测。

**Files:**
- Create: `workflows/execute-plan.mjs`（先只放 parsePlan + meta 占位，Task 4 补 run）
- Test: `test/flow.parse-plan.test.mjs`

**Interfaces:**
- Produces: `parsePlan(planText: string) => Array<{ id: string, title: string, body: string }>`
  - 契约：识别 `### Task N: 标题` 或 `## Task N: 标题` 段头，段体 = 到下一个 Task 头前的文本。
  - 无 Task 头 → 返回 `[]`。

- [ ] **Step 1: 写失败测试** `test/flow.parse-plan.test.mjs`

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { parsePlan } from "../workflows/execute-plan.mjs";

describe("parsePlan", () => {
  it("解析多个 Task 段", () => {
    const text = [
      "# Plan", "intro",
      "### Task 1: 加 foo", "实现 foo 返回 42", "",
      "### Task 2: 加 bar", "实现 bar 返回 7",
    ].join("\n");
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, "1");
    assert.equal(tasks[0].title, "加 foo");
    assert.match(tasks[0].body, /返回 42/);
    assert.equal(tasks[1].title, "加 bar");
  });

  it("兼容 ## 段头", () => {
    const tasks = parsePlan("## Task 1: only\nbody");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "only");
  });

  it("无 Task 头 → []", () => {
    assert.deepEqual(parsePlan("# 没有任务\n随便写"), []);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.parse-plan.test.mjs`
Expected: FAIL（无法 import parsePlan / execute-plan.mjs 不存在）

- [ ] **Step 3: 写 `workflows/execute-plan.mjs`（含 parsePlan + 占位 meta）**

```js
/**
 * workflows/execute-plan.mjs — subagent 驱动开发:逐 task backtrack(写→测→审→回退)。
 * flow 名 = execute-plan。写之前读 docs/FLOW_AUTHORING.md。
 * parsePlan 内联并导出供单测(flow 文件只能 import synod/flow)。
 */
import { agent, bash, backtrack, approve } from "synod/flow";

export const meta = {
  description: "按 plan 逐 task 开发:deepseek 写 → npm test → codex 审 → 不过带反馈回退",
  // inputs: { planText, testCmd?, gates? }
};

const TASK_HEADER = /^#{2,3}\s+Task\s+(\S+?):\s*(.+?)\s*$/;

/** 解析 plan 文本 → 有序 task 列表。无 Task 头 → []。 */
export function parsePlan(planText) {
  const lines = String(planText ?? "").split("\n");
  const tasks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(TASK_HEADER);
    if (m) {
      if (cur) tasks.push(cur);
      cur = { id: m[1], title: m[2], body: "" };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  if (cur) tasks.push(cur);
  return tasks.map((t) => ({ ...t, body: t.body.trim() }));
}

// run() 在 Task 4 补全。
export async function run(ctx, input) {
  throw new Error("execute-plan: run not implemented yet (Task 4)");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/flow.parse-plan.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add workflows/execute-plan.mjs test/flow.parse-plan.test.mjs
git commit -m "feat(flow): parsePlan() — plan 文本解析为有序 task 列表"
```

---

### Task 3: `brainstorm-spec.mjs` 子 flow

提问循环 + 两把钥匙判定结束（记号提议 + 人 accept）+ 刹车（MAX / `/spec`）。

**Files:**
- Create: `workflows/brainstorm-spec.mjs`
- Test: `test/flow.brainstorm-spec.test.mjs`

**Interfaces:**
- Produces: `run(ctx, input) => { specText: string, aborted?: boolean }`
  - `input`: `{ topic: string, maxTurns?: number }`
- Consumes: `agent`（codex, reuse）、`ask`、`approve`（均来自 synod/flow）

**判定逻辑（JS 只查记号/人决定/轮数）：**
1. agent 提问 → `ask` 取人答 → 喂回 transcript → 再问。
2. 人答 `/spec` 或到 MAX → 下一轮 prompt 命令 agent 立即产出草稿（带 `<<<SPEC>>>`）。
3. agent 吐含 `<<<SPEC>>>` → 取草稿 → `approve` 呈人：accept→定稿；feedback→带反馈继续；abort→返回当前草稿 + aborted。

- [ ] **Step 1: 写失败测试** `test/flow.brainstorm-spec.test.mjs`

测试用 fake agent（注入脚本化输出）+ fake io。需要一个能注入 `agent` 输出脚本的 runtime——用 `openBackend` fake（返回脚本化 FakeSession）。复用 `test/helpers/fake-backend.mjs` 的 `FakeSession`，按调用序返回不同文本。

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as brainstorm from "../workflows/brainstorm-spec.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs() {
  const files = new Map();
  return { async writeFile(p, c) { files.set(p, c); }, async appendFile(p, c) { files.set(p, (files.get(p) ?? "") + c); }, get(p){return files.get(p);} };
}
// fake io:可脚本化 question 应答序列
function scriptedIo(answers) {
  const _lines = [];
  const stdout = { write(s) { _lines.push(s); }, get lines() { return _lines; } };
  let i = 0;
  return { stdout, stdin: {}, question() { return Promise.resolve(answers[i++] ?? ""); } };
}
// fake openBackend:按调用序返回脚本化 agent 文本
function scriptedBackend(texts) {
  let i = 0;
  return async () => new FakeSession({ agent: "codex", text: texts[i++] ?? "" });
}

describe("brainstorm-spec", () => {
  it("一轮提问→人答→agent 吐记号→人 accept→定稿", async () => {
    const io = scriptedIo(["我要做一个 X", "accept"]);       // 第1次 ask 回答、approve 时 accept
    const backend = scriptedBackend([
      "请问 X 的目标用户是谁?",                              // 第1次 agent:提问
      "<<<SPEC>>>\n# X 设计\n目标用户:开发者。",              // 第2次 agent:吐记号+草稿
    ]);
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io, openBackend: backend });
    const ctx = rt.createCtx({ input: { topic: "X", maxTurns: 5 } });
    const out = await runFlow(rt, brainstorm, ctx, ctx.input);
    assert.match(out.specText, /X 设计/);
    assert.ok(!out.aborted);
  });

  it("人打 /spec 强制收尾", async () => {
    const io = scriptedIo(["/spec", "accept"]);
    const backend = scriptedBackend([
      "第一个问题?",                                          // agent 提问
      "<<<SPEC>>>\n# 强制收尾的草稿",                          // 被 /spec 触发后产出草稿
    ]);
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io, openBackend: backend });
    const ctx = rt.createCtx({ input: { topic: "Y", maxTurns: 5 } });
    const out = await runFlow(rt, brainstorm, ctx, ctx.input);
    assert.match(out.specText, /强制收尾/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.brainstorm-spec.test.mjs`
Expected: FAIL（brainstorm-spec.mjs 不存在）

- [ ] **Step 3: 写 `workflows/brainstorm-spec.mjs`**

```js
/**
 * workflows/brainstorm-spec.mjs — codex 自适应提问 + 人作答,两把钥匙判定结束。
 * 钥匙①=agent 吐 <<<SPEC>>> 记号(提议);钥匙②=人 approve accept(拍板)。
 * 刹车:到 maxTurns / 人打 /spec → 命令 agent 立即产出草稿。
 * flow 名 = brainstorm-spec。写之前读 docs/FLOW_AUTHORING.md。
 */
import { agent, ask, approve } from "synod/flow";

export const meta = {
  description: "codex 头脑风暴自适应提问 + 人作答,产出 spec 设计稿",
  // inputs: { topic, maxTurns? }
};

const MODEL = "codex";          // 强模型走 codex 后端
const SENTINEL = "<<<SPEC>>>";

function askPrompt(skillHint, transcript, force) {
  if (force) {
    return `${skillHint}\n已知对话:\n${transcript}\n\n` +
      `现在停止提问,基于以上对话直接产出完整设计稿。第一行输出 ${SENTINEL},其后是设计稿正文。`;
  }
  return `${skillHint}\n已知对话:\n${transcript}\n\n` +
    `若还有不清楚的,只问下一个澄清问题(不要解释)。\n` +
    `若已问够、能写设计稿了,第一行输出 ${SENTINEL},其后是完整设计稿正文。`;
}

const SKILL_HINT =
  "你是资深工程师,正在和用户头脑风暴一个软件设计。一次只问一个问题,逐步澄清目的/约束/成功标准。";

export async function run(ctx, input) {
  const topic = typeof input === "string" ? input : (input?.topic ?? "");
  const maxTurns = input?.maxTurns ?? 20;
  let transcript = `主题: ${topic}`;
  let force = false;

  for (let turn = 1; turn <= maxTurns + 1; turn++) {
    // 到上限那一轮强制收尾。
    if (turn > maxTurns) force = true;

    const out = await agent(ctx, {
      agent: "codex", model: MODEL, reuse: true,
      prompt: askPrompt(SKILL_HINT, transcript, force),
    });

    // 钥匙①:agent 提议记号。
    if (out.includes(SENTINEL)) {
      const draft = out.slice(out.indexOf(SENTINEL) + SENTINEL.length).trim();
      const decision = await approve(ctx, { content: draft });
      if (decision.accepted) return { specText: draft };           // 钥匙②:人拍板
      if (decision.aborted) return { specText: draft, aborted: true };
      transcript += `\n[人对设计稿的反馈] ${decision.feedback}`;     // 没过,接着聊
      force = false;
      continue;
    }

    // 还在提问:取人答。
    const answer = await ask(ctx, { content: out, question: out, prompt: "你的回答(/spec 收尾, 空行跳过): " });
    if (answer === null) return { specText: transcript, aborted: true };  // abort
    if (answer.trim() === "/spec") { force = true; continue; }            // 刹车:强制收尾
    transcript += `\nQ: ${out}\nA: ${answer}`;
  }

  // 理论不可达(force 那轮必出记号);兜底返回 transcript。
  return { specText: transcript };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/flow.brainstorm-spec.test.mjs`
Expected: PASS

> 注：若 `runFlow` 需要 `setCurrentRuntime`/`workflowsRoot` 才能跑，参照 `test/flow.revise.test.mjs` 里 runFlow 的调用方式对齐（同仓既有模式）。

- [ ] **Step 5: 提交**
```bash
git add workflows/brainstorm-spec.mjs test/flow.brainstorm-spec.test.mjs
git commit -m "feat(flow): brainstorm-spec 子flow — 两把钥匙判定 + /spec 刹车"
```

---

### Task 4: `execute-plan.mjs` 的 `run()`（逐 task backtrack + 自动刹车）

**Files:**
- Modify: `workflows/execute-plan.mjs:run`
- Test: `test/flow.execute-plan.test.mjs`

**Interfaces:**
- Produces: `run(ctx, { planText, testCmd?, gates? }) => { done: boolean, failedTask?: string, completed: string[] }`
- Consumes: `parsePlan`（本模块）、`agent`(omp/deepseek write/workspace、codex review)、`bash`、`backtrack`、`approve`

**逻辑：** `parsePlan(planText)` → `for` 逐 task：`backtrack(≤3)`{ produce: deepseek 写; review: `bash(testCmd)` + codex 审, passed = test.code===0 && /APPROVE/.test(verdict) }。某 task 耗尽仍 `passed:false` → 返回 `{done:false, failedTask}`（自动刹车,不往下）。`gates==='all'` 时每 task 后 `approve`。

- [ ] **Step 1: 写失败测试** `test/flow.execute-plan.test.mjs`

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as exec from "../workflows/execute-plan.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs() { const f = new Map(); return { async writeFile(p,c){f.set(p,c);}, async appendFile(p,c){f.set(p,(f.get(p)??"")+c);}, get(p){return f.get(p);} }; }

// openBackend 按 agent 名脚本化:deepseek 写返回 "done";codex 审返回 APPROVE/REJECT 序列。
function backendBy(map) {
  return async ({ agent, model }) => {
    const key = agent === "codex" ? "codex" : "writer";
    const arr = map[key];
    const text = typeof arr === "function" ? arr() : (arr.shift?.() ?? arr);
    return new FakeSession({ agent, text });
  };
}

describe("execute-plan", () => {
  it("单 task 一次过 → done", async () => {
    const codexVerdicts = ["APPROVE"];
    const backend = async ({ agent }) =>
      new FakeSession({ agent, text: agent === "codex" ? codexVerdicts.shift() : "written" });
    // bash(testCmd) 也要可控:用一个总是 code 0 的 testCmd
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, openBackend: backend });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, exec, ctx, {
      planText: "### Task 1: 加 foo\n实现 foo",
      testCmd: "true",          // shell true → code 0
      gates: "none",
    });
    assert.equal(out.done, true);
    assert.deepEqual(out.completed, ["1"]);
  });

  it("task 测试持续失败 → 自动刹车 {done:false}", async () => {
    const backend = async ({ agent }) =>
      new FakeSession({ agent, text: agent === "codex" ? "REJECT 还不行" : "written" });
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, openBackend: backend });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, exec, ctx, {
      planText: "### Task 1: 加 foo\n实现 foo",
      testCmd: "false",         // shell false → code 1
      gates: "none",
    });
    assert.equal(out.done, false);
    assert.equal(out.failedTask, "1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.execute-plan.test.mjs`
Expected: FAIL（run 抛 "not implemented"）

- [ ] **Step 3: 实现 `run()`（替换 Task 2 的占位 run）**

```js
const WRITER_MODEL = "deepseek/deepseek-v4-pro";

export async function run(ctx, input) {
  const planText = typeof input === "string" ? input : (input?.planText ?? "");
  const testCmd = input?.testCmd ?? "npm test";
  const gates = input?.gates ?? "none";
  const tasks = parsePlan(planText);
  const completed = [];

  for (const task of tasks) {
    const result = await backtrack(ctx, {
      maxTurns: 3,
      initialPrompt:
        `实现下面这个 task,写出代码与必要测试:\n\n## Task ${task.id}: ${task.title}\n${task.body}`,
      produce: (ctx2, prompt) =>
        agent(ctx2, { agent: "omp", model: WRITER_MODEL, write: true, workspace: "dev", prompt }),
      review: async (_code) => {
        const tested = await bash(ctx, testCmd);
        const verdict = await agent(ctx, {
          agent: "codex", write: false,
          prompt:
            `审查刚完成的 task「${task.title}」。测试输出:\n` +
            `exit=${tested.code}\nstdout:\n${tested.stdout}\nstderr:\n${tested.stderr}\n\n` +
            `若实现正确且测试通过,只回一个词 APPROVE。否则第一行 REJECT,其后给具体修改点。`,
        });
        const passed = tested.code === 0 && /APPROVE/.test(verdict);
        return { passed, feedback: passed ? undefined : `测试 exit=${tested.code}\n${verdict}` };
      },
      buildPrompt: ({ feedback }) =>
        `上次未通过。反馈:\n${feedback}\n\n请据此修正 task「${task.title}」的实现与测试。`,
    });

    if (!result.passed) {
      return { done: false, failedTask: task.id, completed };   // 自动刹车
    }
    completed.push(task.id);
    if (gates === "all") {
      await approve(ctx, { content: `Task ${task.id} (${task.title}) 验收。\n${result.output}` });
    }
  }

  return { done: true, completed };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/flow.execute-plan.test.mjs`
Expected: PASS

> 注：fake `bash` —— `createRuntime` 的 `bash` 用真 shell。测试里 `testCmd:"true"`/`"false"` 直接用 shell 内建，无需 fake。若 CI 无 shell，改注入 fake bash（参照 `test/flow.backtrack.test.mjs`）。

- [ ] **Step 5: 提交**
```bash
git add workflows/execute-plan.mjs test/flow.execute-plan.test.mjs
git commit -m "feat(flow): execute-plan run() — 逐 task backtrack + 自动刹车"
```

---

### Task 5: `spec-to-plan.mjs` + `final-review.mjs` 子 flow

两个较薄的子 flow。

**Files:**
- Create: `workflows/spec-to-plan.mjs`
- Create: `workflows/final-review.mjs`
- Test: `test/flow.spec-to-plan.test.mjs`、`test/flow.final-review.test.mjs`

**Interfaces:**
- `spec-to-plan` `run(ctx, { specText }) => { planText }`：`agent(codex)` 产出分 task 计划 → `reviseWithHuman` 人改稿。**计划必须用 `### Task N: 标题` 段头**（与 parsePlan 契约对齐——prompt 里强约束）。
- `final-review` `run(ctx, { testCmd? }) => { approved, report }`：`agent(codex, write:false)` 审全 diff（`bash('git diff')`）→ 有问题 `backtrack`(≤2) 让 deepseek 修。

- [ ] **Step 1: 写 `workflows/spec-to-plan.mjs`**

```js
/**
 * workflows/spec-to-plan.mjs — codex 由 spec 产出分 task 的 TDD 计划,人在环改稿。
 * 计划段头必须 `### Task N: 标题`(与 execute-plan 的 parsePlan 契约对齐)。
 */
import { agent, reviseWithHuman } from "synod/flow";

export const meta = {
  description: "codex 读 spec 产出分 task 的实现计划,人在环改稿定稿",
  // inputs: { specText }
};

export async function run(ctx, input) {
  const specText = typeof input === "string" ? input : (input?.specText ?? "");
  const draft = await agent(ctx, {
    agent: "codex",
    prompt:
      `根据下面的设计 spec,产出一份分 task 的 TDD 实现计划。\n` +
      `**每个 task 必须用恰好这种段头:** \`### Task N: 标题\`(N 为数字),段体写实现与验证要点。\n\n` +
      `=== SPEC ===\n${specText}`,
  });
  const planText = await reviseWithHuman(ctx, draft, { agent: "codex" });
  return { planText };
}
```

- [ ] **Step 2: 写 `workflows/final-review.mjs`**

```js
/**
 * workflows/final-review.mjs — codex 审全量 diff,有问题让 deepseek 修(≤2 轮)。
 */
import { agent, bash, backtrack } from "synod/flow";

export const meta = {
  description: "codex 审全量 diff,有问题带反馈让 deepseek 修",
  // inputs: { testCmd? }
};

const WRITER_MODEL = "deepseek/deepseek-v4-pro";

export async function run(ctx, input) {
  const testCmd = input?.testCmd ?? "npm test";

  const result = await backtrack(ctx, {
    maxTurns: 2,
    initialPrompt: "审查本分支全部改动。",
    produce: async (ctx2, _prompt) => {
      const diff = await bash(ctx2, "git diff");
      return agent(ctx2, {
        agent: "codex", write: false,
        prompt:
          `审查下面的 diff。若整体正确、可合并,只回 APPROVE。否则第一行 REJECT,其后给修改点。\n\n` +
          `=== DIFF ===\n${diff.stdout}`,
      });
    },
    review: async (verdict) => {
      const passed = /APPROVE/.test(verdict);
      return { passed, feedback: passed ? undefined : verdict };
    },
    buildPrompt: ({ feedback }) =>
      `评审未通过,反馈:\n${feedback}\n\n请修正实现(写代码),修完返回简述。`,
    // 注:修复回合需要写者。backtrack 的 produce 同一函数;改用下方说明的双角色变体见 Step 3。
  });

  return { approved: result.passed, report: result.output };
}
```

- [ ] **Step 3: 修正 final-review 的双角色（审者≠改者）**

`backtrack` 的 `produce` 每轮跑同一函数。final-review 需要「首轮审、不过让 deepseek 改后再审」。改成显式循环：

```js
export async function run(ctx, input) {
  let feedback = null;
  let verdict = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (feedback) {
      await agent(ctx, {
        agent: "omp", model: WRITER_MODEL, write: true, workspace: "dev",
        prompt: `评审未通过,反馈:\n${feedback}\n\n请修正实现(写代码)。`,
      });
    }
    const diff = await bash(ctx, "git diff");
    verdict = await agent(ctx, {
      agent: "codex", write: false,
      prompt:
        `审查下面的 diff。若可合并只回 APPROVE,否则第一行 REJECT 其后给修改点。\n\n` +
        `=== DIFF ===\n${diff.stdout}`,
    });
    if (/APPROVE/.test(verdict)) return { approved: true, report: verdict };
    feedback = verdict;
  }
  return { approved: false, report: verdict };
}
```
用此版替换 Step 2 的 run（删掉 backtrack import 若不再用；保留 `agent, bash`）。

- [ ] **Step 4: 写两个 flow 的冒烟测试**（fake backend，断言 happy path 返回结构 + parsePlan 能吃 spec-to-plan 的输出）

```js
// test/flow.spec-to-plan.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as s2p from "../workflows/spec-to-plan.mjs";
import { parsePlan } from "../workflows/execute-plan.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs(){const f=new Map();return{async writeFile(p,c){f.set(p,c);},async appendFile(p,c){f.set(p,(f.get(p)??"")+c);},get(p){return f.get(p);}};}
function scriptedIo(answers){let i=0;const o=[];return{stdout:{write(s){o.push(s);}},stdin:{},question(){return Promise.resolve(answers[i++]??"accept");}};}

describe("spec-to-plan", () => {
  it("产出的计划能被 parsePlan 解析", async () => {
    const io = scriptedIo(["accept"]);   // reviseWithHuman 第一次就 accept
    const backend = async ({ agent }) => new FakeSession({ agent, text: "### Task 1: 加 foo\n实现 foo" });
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io, openBackend: backend });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, s2p, ctx, { specText: "# 设计\n做 foo" });
    const tasks = parsePlan(out.planText);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "加 foo");
  });
});
```
```js
// test/flow.final-review.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as fr from "../workflows/final-review.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs(){const f=new Map();return{async writeFile(p,c){f.set(p,c);},async appendFile(p,c){f.set(p,(f.get(p)??"")+c);},get(p){return f.get(p);}};}

describe("final-review", () => {
  it("codex 直接 APPROVE → approved:true", async () => {
    const backend = async ({ agent }) => new FakeSession({ agent, text: "APPROVE" });
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, openBackend: backend });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, fr, ctx, {});
    assert.equal(out.approved, true);
  });
});
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `node --test test/flow.spec-to-plan.test.mjs test/flow.final-review.test.mjs`
Expected: PASS
```bash
git add workflows/spec-to-plan.mjs workflows/final-review.mjs test/flow.spec-to-plan.test.mjs test/flow.final-review.test.mjs
git commit -m "feat(flow): spec-to-plan + final-review 子flow"
```

---

### Task 6: `superpowers.mjs` 父 flow + gates

**Files:**
- Create: `workflows/superpowers.mjs`
- Test: `test/flow.superpowers.test.mjs`

**Interfaces:**
- `run(ctx, { topic, gates?, testCmd?, maxTurns? }) => { status, ... }`
  - `gate(stage, gates)` 纯函数：`gates==='all'` → spec/plan/dev/final 全 true；`'final'` → 仅 final；`'none'` → 全 false。
- Consumes: `runWorkflow`、`approve`

- [ ] **Step 1: 写 `workflows/superpowers.mjs`**

```js
/**
 * workflows/superpowers.mjs — 父 flow:串 brainstorm→plan→execute→review。
 * 子流程间用返回值交接。gates 开关控制接缝人审(none/final/all)。
 */
import { runWorkflow, approve } from "synod/flow";

export const meta = {
  description: "Superpowers 开发链:头脑风暴→spec→计划→subagent开发→review",
  // inputs: { topic, gates?, testCmd?, maxTurns? }
};

/** gate(stage, gates) — 该接缝是否需要人审。 */
export function gate(stage, gates) {
  if (gates === "all") return true;
  if (gates === "final") return stage === "final";
  return false; // "none"
}

export async function run(ctx, input) {
  const gates = input?.gates ?? "none";
  const testCmd = input?.testCmd ?? "npm test";

  const bs = await runWorkflow(ctx, "brainstorm-spec", { topic: input?.topic, maxTurns: input?.maxTurns });
  if (bs.aborted) return { status: "aborted", at: "brainstorm" };
  if (gate("spec", gates)) {
    const d = await approve(ctx, { content: bs.specText });
    if (d.aborted) return { status: "aborted", at: "spec-gate" };
  }

  const plan = await runWorkflow(ctx, "spec-to-plan", { specText: bs.specText });
  if (gate("plan", gates)) {
    const d = await approve(ctx, { content: plan.planText });
    if (d.aborted) return { status: "aborted", at: "plan-gate" };
  }

  const dev = await runWorkflow(ctx, "execute-plan", { planText: plan.planText, testCmd, gates });
  if (!dev.done) return { status: "halted", at: dev.failedTask, completed: dev.completed };
  if (gate("dev", gates)) await approve(ctx, { content: `开发完成 tasks: ${dev.completed.join(", ")}` });

  const rev = await runWorkflow(ctx, "final-review", { testCmd });
  if (gate("final", gates)) await approve(ctx, { content: rev.report });

  return { status: "done", specText: bs.specText, planText: plan.planText, review: rev };
}
```

- [ ] **Step 2: 写测试**（`gate` 纯函数 + fake 子流程串联）

`gate` 可直接单测；父流程串联用真 `runWorkflow`（需 `workflowsRoot` 指向 `workflows/` + fake backend 让各子流程跑通）。

```js
import { describe, it } from "node:test";
import assert from "node:assert";
import { gate } from "../workflows/superpowers.mjs";

describe("superpowers gate", () => {
  it("none → 全 false", () => {
    for (const s of ["spec","plan","dev","final"]) assert.equal(gate(s,"none"), false);
  });
  it("final → 仅 final", () => {
    assert.equal(gate("final","final"), true);
    assert.equal(gate("spec","final"), false);
  });
  it("all → 全 true", () => {
    for (const s of ["spec","plan","dev","final"]) assert.equal(gate(s,"all"), true);
  });
});
```

- [ ] **Step 3: 跑测试 + 全量回归 + 提交**

Run: `node --test test/flow.superpowers.test.mjs` → PASS
Run: `npm test` → 全绿无回归
```bash
git add workflows/superpowers.mjs test/flow.superpowers.test.mjs
git commit -m "feat(flow): superpowers 父flow + gates 开关"
```

---

### Task 7: 真 agent e2e 验收

最小真跑：codex brainstorm 一两轮 → deepseek 写一个琐碎 task → codex 审 → 收尾。沿用 `scripts/acceptance-flow.mjs` harness。

**Files:**
- Modify: `scripts/acceptance-flow.mjs`（加 FA6：superpowers 链最小真跑）
- 可能 Modify: `package.json`（若需要独立脚本入口，不必）

**Interfaces:**
- Consumes: 真 omp/codex 后端;`SYNOD_FLOW_MODEL=deepseek/deepseek-v4-pro` 注入。

- [ ] **Step 1: 读 `scripts/acceptance-flow.mjs` 现有 FA1–FA5 结构**

Run: `node -e "process.stdout.write(require('fs').readFileSync('scripts/acceptance-flow.mjs','utf8').slice(0,3000))"`
（了解 harness 怎么建 runtime、注入模型、跑 flow、断言。）

- [ ] **Step 2: 加 FA6 最小场景**

用一个**自包含、scoped 的 testCmd**（不要跑 synod 全量 `npm test`）。例如让 deepseek 在临时 worktree 写 `/tmp/foo.mjs`，testCmd=`node -e "process.exit(0)"`（恒绿），重点验证**链路跑通**而非真实开发质量：
- brainstorm：headless 关、用 scripted stdin 管道喂答复（参照 FA4 既有「scripted stdin」做法），喂一次回答 + 一次 `/spec` + approve。
- 断言：`run` 返回 `status:"done"`，且 run.log 里出现 codex + deepseek 的 session。

具体代码按 harness 现有断言风格补（参照 FA5 parent/child 的写法）。

- [ ] **Step 3: 跑 e2e**

Run: `SYNOD_FLOW_MODEL=deepseek/deepseek-v4-pro node scripts/acceptance-flow.mjs`
Expected: FA1–FA6 全绿。

> ⚠️ 真 agent e2e 注意（见 [[agent-bridge-delegation-gotchas]]）：跑前别留着 agent-bridge 会话（残留 worktree 扫描会假阳性）；模型串要 provider 限定。

- [ ] **Step 4: 全量回归 + 提交**

Run: `npm test && npm run test:e2e-flow`
Expected: 单测全绿 + flow e2e 全绿（含新 FA6）。
```bash
git add scripts/acceptance-flow.mjs
git commit -m "test(flow): FA6 superpowers 链最小真 agent e2e"
```

---

## Self-Review

**Spec coverage:**
- §3 `ask()` 原语 → Task 1 ✅
- §4.1 brainstorm 两把钥匙 + 刹车 → Task 3 ✅
- §4.2 spec-to-plan → Task 5 ✅
- §4.3 execute-plan + parsePlan + 自动刹车 + worktree → Task 2 + Task 4 ✅
- §4.4 final-review → Task 5 ✅
- §4.5 父 flow → Task 6 ✅
- §5 gates 开关 → Task 6 `gate()` ✅
- §8 测试策略（单测 + e2e）→ 各 Task 单测 + Task 7 ✅
- **与 spec 的有意偏差**：§4.1/§4.3 写「产物 spec.md/plan.md（经 bash 写）」→ 计划改为**返回文本不写仓库文件**（避 bash heredoc 转义 + 第二个新原语；引擎自动记 agent 工件）。已在计划开头 Architecture 注明。写仓库文件列为**首要 follow-up**（需 `writeArtifact` 原语）。

**Placeholder scan:** 无 TBD/TODO；execute-plan Task 2 的占位 run 在 Task 4 被替换（已标注）。

**Type consistency:** `parsePlan` 产出 `{id,title,body}` 与 execute-plan 消费一致；`gate(stage,gates)` 签名一致；子流程返回 `{specText}`/`{planText}`/`{done,failedTask,completed}`/`{approved,report}` 与父流程消费一致；`runWorkflow(ctx,"name",input)` 用裸名（与 `workflows/parent.mjs` 既有用法一致）。

**已知风险（spec §9 承接）：** codex 做开放式对话对口度、`<<<SPEC>>>` 记号可靠性、plan 段头契约两端漂移、`ask` 与 approve 全特性对齐——单测已钉关键不变量，真 agent 表现 Task 7 实测。

# Synod TUI — P1 骨架 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 synod 加一个 OpenCode 风格全屏 TUI 的**骨架(P1)**:右侧 agents 栏(点击/键盘切焦点)+ 焦点区(头部活动/元信息 + 当前 turn 文本流式 + C/D 折叠条)+ 系统消息条 + 底部输入栏(`/`、`@` 命令提示)+ 状态栏,挂在现有内核之上,非 TTY/`--task` 走原路径不变。

**Architecture:** TUI 是**现有内核之上的新前端**,不改 `backend.mjs`/dispatch/relay/control 语义。复用现有 `session-manager`/`repl-dispatch`/`relay`/`control-wire`,并把它们的 `stdout`/`stderr` 写入接到**捕获流**(转成 TUI 系统消息,绝不污染全屏);`session-manager` 加 `renderOutput:false` 让它**不再把模型流输出写 stdout**(TUI 从事件自渲染,避免双重渲染),并加 `onSessionOpen` 钩子让 store 直接订阅每个 session 的 `delta/event/status/error`。**焦点即路由**:TUI 焦点切换同步 `sm.use()`,普通输入永远发给焦点会话。退出/SIGINT/drain 复用与老 REPL **同一套** `drainAndClose()`。渲染用 **Ink + htm(无构建)**,鼠标手搓,且**只在进入 TUI 时动态 import**。

**Tech Stack:** Node 20+ ESM(无构建);新增 UI 依赖 `ink`、`react`、`htm`、(dev)`ink-testing-library`;`node:test` 跑既有契约测试。事件适配器走注册制(仿 `src/backends/registry.mjs`)。

**配套 spec:** `docs/superpowers/specs/2026-06-13-tui-page-design.md`(+ mockup html)。**本计划只做 P1**;P2(富工具调用卡片 + omp/codex 注册适配器)另立计划。

> **本版已纳入 codex 第 1 轮评审整改**:焦点↔路由同步、退出/SIGINT/drain 复用、不重复装 shutdown、双 TTY 判定、flowsRoot 作用域、系统消息可见、renderOutput 防双渲染、修正 fakeOpenBackend 用法、固定高卡片 + 缓冲式鼠标 + resize、store 措辞校正。

---

## 文件结构

| 文件 | 职责 | 新建/改 |
|---|---|---|
| `package.json` | 加 ink/react/htm 依赖 + dev ink-testing-library | 改 |
| `src/ui/tui/html.mjs` | htm 绑定 React.createElement(无 JSX 构建) | 新建 |
| `src/ui/tui/capture.mjs` | 捕获写入流:`write()` 行拆分 → 回调(→ store 系统消息) | 新建 |
| `src/session-manager.mjs` | 加可选 `onSessionOpen(label, session)` 钩子 + `renderOutput` 开关 | 改 |
| `src/ui/tui/events.mjs` | 规范化事件模型 + 适配器**注册表** + 默认适配器 | 新建 |
| `src/ui/tui/store.mjs` | UI 状态:sessions/当前 turn 文本/focus/系统消息;`attachSession` | 新建 |
| `src/ui/tui/hints.mjs` | `/`、`@` 命令提示(扩展 completer 逻辑);`$` 识别但不触发 | 新建 |
| `src/ui/tui/mouse.mjs` | SGR 鼠标开关/缓冲解析 + 可点击区域注册表 + 命中检测 | 新建 |
| `src/ui/tui/components/*.mjs` | AgentRail / FocusPane / CollapsibleStrip / InputBar / SystemStrip / StatusBar | 新建 |
| `src/ui/tui/app.mjs` | 根组件:三区布局 + 键盘/Ctrl-C + 焦点回调 + 订阅 store | 新建 |
| `src/ui/tui/index.mjs` | `startTui(...)`:进/退 alt-screen+raw、挂载 Ink、缓冲鼠标、resize、收尾还原 | 新建 |
| `src/cli.mjs` | `--no-tui` flag;`shouldUseTui`;抽 `drainAndClose` 共享;TTY 交互分支拉起 TUI | 改 |
| `test/ui/tui/*.test.mjs` | 各单元/组件测试 | 新建 |

**store 的规范事件模型(P1 子集):** `{kind:'message.delta', text}` · `{kind:'turn.start'}` · `{kind:'turn.end', ms}` · `{kind:'status', status, isStreaming}`。(P2 增 `tool.start/tool.end/reasoning.*`。)

**P1 对话范围(校正措辞,避免过度承诺):** 焦点区只渲染**当前 turn 的流式 assistant 文本**(`status:running` 时清空、重新累积),**不保留用户消息回显、不保留历史 turn**。完整有序时间线(user/assistant/tool 混排)是 **P2**。

---

## Task 0:依赖与无构建 JSX(htm)+ 冒烟

**Files:**
- Modify: `package.json`
- Create: `src/ui/tui/html.mjs`
- Create: `test/ui/tui/html.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/html.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { Text } from "ink";

test("html 标签模板可渲染 ink 组件(无 JSX 构建)", () => {
  const { lastFrame } = render(html`<${Text}>hello-tui<//>`);
  assert.match(lastFrame(), /hello-tui/);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `node --test test/ui/tui/html.test.mjs`
Expected: FAIL（`Cannot find package 'ink'`）

- [ ] **Step 3: 装依赖**

```bash
npm install ink react htm
npm install --save-dev ink-testing-library
```

- [ ] **Step 4: 写 html 绑定**

```js
// src/ui/tui/html.mjs — htm 绑定 React.createElement,免 JSX 构建步骤。
import React from "react";
import htm from "htm";

export const html = htm.bind(React.createElement);
```

- [ ] **Step 5: 跑测试看通过 + 确认核心零依赖直跑(未 import ink)**

Run: `node --test test/ui/tui/html.test.mjs` → PASS
Run: `node src/cli.mjs --help` → 正常打印 help（核心路径此刻不 import ink）

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/ui/tui/html.mjs test/ui/tui/html.test.mjs
git commit -m "feat(tui): add ink/htm deps + no-build html binding (P1 task0)"
```

---

## Task 1:捕获写入流(capture stream)

**Files:**
- Create: `src/ui/tui/capture.mjs`
- Create: `test/ui/tui/capture.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/capture.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { makeCaptureStream } from "../../../src/ui/tui/capture.mjs";

test("按换行切分,整行回调,残段留存", () => {
  const lines = [];
  const s = makeCaptureStream((line) => lines.push(line));
  s.write("Relay added: a->b\n");
  s.write("No session ");
  s.write("\"x\"\nmore");
  assert.deepStrictEqual(lines, ['Relay added: a->b', 'No session "x"']);
});

test("有 write 方法且返回 true(满足 Writable 鸭子类型)", () => {
  const s = makeCaptureStream(() => {});
  assert.strictEqual(typeof s.write, "function");
  assert.strictEqual(s.write("x\n"), true);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `node --test test/ui/tui/capture.test.mjs` → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/capture.mjs — 把 sm/dispatch/relay 的流写入按行转成 UI 系统消息。
// session-manager / dispatch 只用到流的 .write(string);最小鸭子类型即可。
export function makeCaptureStream(onLine) {
  let buf = "";
  return {
    write(chunk) {
      buf += String(chunk);
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const line of parts) if (line.length) onLine(line);
      return true;
    },
  };
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `node --test test/ui/tui/capture.test.mjs` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/capture.mjs test/ui/tui/capture.test.mjs
git commit -m "feat(tui): capture stream → per-line callback (P1 task1)"
```

---

## Task 2:session-manager 加 `onSessionOpen` 钩子 + `renderOutput` 开关

两处加法,默认行为不变:① `onSessionOpen(label, session)` 让 TUI 拿到 session 附加渲染监听;② `renderOutput:false`(默认 true)让 sm **不再把模型流输出(delta)与 turn 边界线写 stdout**——TUI 从事件自渲染,避免"模型文本又被捕获成系统消息"的双重渲染(codex MAJOR #7)。

**Files:**
- Modify: `src/session-manager.mjs`
- Create: `test/session-manager.tui-hooks.test.mjs`

- [ ] **Step 1: 写失败测试**(注意 `fakeOpenBackend` 是 async opener,须包一层 `(opts)=>fakeOpenBackend(opts)` —— codex MAJOR #8)

```js
// test/session-manager.tui-hooks.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { createSessionManager } from "../src/session-manager.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

const REPORT = { omp: { available: true } };
const cap = () => ({ buf: "", write(s) { this.buf += s; return true; } });

function mk(extra = {}) {
  const stdout = cap(), stderr = cap();
  const sm = createSessionManager({
    openBackend: (opts) => fakeOpenBackend(opts),   // ← 正确用法(helper 是 async opener)
    stdout, stderr, report: REPORT, cwd: process.cwd(),
    defaults: {}, onIdle: () => {}, ...extra,
  });
  return { sm, stdout, stderr };
}

test("onSessionOpen 在每个 session 建好后以 (label, session) 调用", async () => {
  const seen = [];
  const { sm } = mk({ onSessionOpen: (label, session) => seen.push([label, typeof session.on]) });
  const label = await sm.open({ agent: "omp" });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0][0], label);
  assert.strictEqual(seen[0][1], "function"); // EventEmitter
});

test("renderOutput:false 时,模型 delta 不写 stdout", async () => {
  const { sm, stdout } = mk({ renderOutput: false });
  const label = await sm.open({ agent: "omp" });
  const session = sm._sessions.get(label).session;
  session.emit("status", { status: "running", isStreaming: true });
  session.emit("delta", "模型输出不该落到 stdout");
  session.emit("status", { status: "idle", isStreaming: false });
  assert.ok(!stdout.buf.includes("模型输出不该落到 stdout"));
});

test("renderOutput 默认 true:模型 delta 仍写 stdout(不回归)", async () => {
  const { sm, stdout } = mk();
  const label = await sm.open({ agent: "omp" });
  const session = sm._sessions.get(label).session;
  session.emit("status", { status: "running", isStreaming: true });
  session.emit("delta", "正常渲染");
  assert.ok(stdout.buf.includes("正常渲染"));
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `node --test test/session-manager.tui-hooks.test.mjs` → FAIL

- [ ] **Step 3: 实现**

3a. 函数签名加形参:

```js
function createSessionManager({ openBackend, stdout, stderr, report, cwd, defaults, onIdle, onTurnComplete, onSessionOpen, renderOutput = true, errorLeadingNewline = false, relays, env = process.env }) {
```

3b. 紧随 `_onTurnComplete` 定义后加:

```js
  const _onSessionOpen = onSessionOpen || null;
  const _renderOutput = renderOutput !== false;
```

3c. `open()` 里把 **delta→feed** 与 **turnBoundary 写 stdout** 用 `_renderOutput` 门控。即把现有:

```js
      session.on("delta", (chunk) => lineBuf.feed(chunk));
```
改为:
```js
      if (_renderOutput) session.on("delta", (chunk) => lineBuf.feed(chunk));
```

并把 status idle 分支里的 turnBoundary 写法门控(其余 startTurn/endTurn/_onIdle 不动):

```js
        } else if (status === "idle") {
          lineBuf.endTurn();
          if (_renderOutput && useColor && _turnStartAt != null) {
            const secs = ((Date.now() - _turnStartAt) / 1000).toFixed(1);
            stdout.write(turnBoundary(label, secs));
            _turnStartAt = null;
          }
          _onIdle(label);
        }
```

3d. 在 `if (setCurrent) _currentLabel = label;` 之后、`announce === "interactive"` 之前插入:

```js
      // TUI/外部消费者钩子:session 已建好、核心 listener 已接好;交出 (label, session)
      // 供 TUI store 附加渲染监听。纯加法、默认 no-op,不改既有行为。
      if (_onSessionOpen) { try { _onSessionOpen(label, session); } catch {} }
```

- [ ] **Step 4: 跑测试看通过 + 既有 sm 测试不回归**

Run: `node --test test/session-manager.tui-hooks.test.mjs test/session-manager.test.mjs` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.mjs test/session-manager.tui-hooks.test.mjs
git commit -m "feat(sm): onSessionOpen hook + renderOutput toggle for TUI (P1 task2)"
```

---

## Task 3:规范化事件 + 适配器注册表

**Files:**
- Create: `src/ui/tui/events.mjs`
- Create: `test/ui/tui/events.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/events.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { registerEventAdapter, getEventAdapter, defaultAdapter } from "../../../src/ui/tui/events.mjs";

test("默认适配器:delta → message.delta", () => {
  assert.deepStrictEqual(defaultAdapter({ channel: "delta", payload: "hi" }), { kind: "message.delta", text: "hi" });
});
test("默认适配器:status → status", () => {
  assert.deepStrictEqual(
    defaultAdapter({ channel: "status", payload: { status: "running", isStreaming: true } }),
    { kind: "status", status: "running", isStreaming: true });
});
test("默认适配器:event 通道 P1 不消费 → null", () => {
  assert.strictEqual(defaultAdapter({ channel: "event", payload: { type: "toolCall" } }), null);
});
test("注册制:注册后按 agent 取回,未注册回退默认", () => {
  const custom = () => ({ kind: "status", status: "x", isStreaming: false });
  registerEventAdapter("fake-agent", custom);
  assert.strictEqual(getEventAdapter("fake-agent"), custom);
  assert.strictEqual(getEventAdapter("never-registered"), defaultAdapter);
});
```

- [ ] **Step 2: 跑测试看失败** → `node --test test/ui/tui/events.test.mjs` → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/events.mjs — 规范化事件 + 适配器注册表(仿 backends/registry.mjs)。
// 适配器签名:normalize({ channel, payload, agent }) → 规范事件 | null
//   channel ∈ "delta" | "status" | "event" | "error";返回 null = UI 不渲染。
export function defaultAdapter({ channel, payload }) {
  if (channel === "delta" && typeof payload === "string") return { kind: "message.delta", text: payload };
  if (channel === "status" && payload && typeof payload === "object")
    return { kind: "status", status: payload.status, isStreaming: Boolean(payload.isStreaming) };
  return null; // P1:event 原始流暂不消费(P2 由 omp/codex 适配器接管)
}
const _adapters = new Map();
export function registerEventAdapter(agent, normalize) { _adapters.set(agent, normalize); }
export function getEventAdapter(agent) { return _adapters.get(agent) || defaultAdapter; }
```

- [ ] **Step 4: 跑测试看通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/events.mjs test/ui/tui/events.test.mjs
git commit -m "feat(tui): normalized event model + adapter registry (P1 task3)"
```

---

## Task 4:UI store

**Files:**
- Create: `src/ui/tui/store.mjs`
- Create: `test/ui/tui/store.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/store.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
const fakeSession = () => new EventEmitter();

test("attachSession 注册会话,默认焦点为第一个", () => {
  const store = createStore();
  store.attachSession("omp#1", fakeSession(), "omp", { model: "m" });
  assert.strictEqual(store.getState().focusLabel, "omp#1");
  assert.strictEqual(store.getState().sessions["omp#1"].agent, "omp");
});
test("delta 累积当前 turn 文本 + 记 lastLine", () => {
  const store = createStore(); const s = fakeSession();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "hello "); s.emit("delta", "world\nsecond");
  const sess = store.getState().sessions["omp#1"];
  assert.match(sess.assistantText, /hello world\nsecond/);
  assert.strictEqual(sess.lastLine, "second");
  assert.strictEqual(sess.status, "running");
});
test("status idle 收尾 turn,turn 计数 +1", () => {
  const store = createStore(); const s = fakeSession();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "answer");
  s.emit("status", { status: "idle", isStreaming: false });
  const sess = store.getState().sessions["omp#1"];
  assert.strictEqual(sess.status, "idle"); assert.strictEqual(sess.turn, 1);
});
test("setFocus / focusNext 切换焦点;subscribe 收到通知", () => {
  const store = createStore();
  store.attachSession("omp#1", fakeSession(), "omp", {});
  store.attachSession("codex#1", fakeSession(), "codex", {});
  let hits = 0; store.subscribe(() => { hits += 1; });
  store.setFocus("codex#1");
  assert.strictEqual(store.getState().focusLabel, "codex#1");
  store.setFocus("omp#1"); store.focusNext();
  assert.strictEqual(store.getState().focusLabel, "codex#1");
  assert.ok(hits >= 1);
});
test("pushSystem 记系统消息;error 事件进系统消息", () => {
  const store = createStore(); const s = fakeSession();
  store.attachSession("omp#1", s, "omp", {});
  store.pushSystem("Relay added: a->b");
  s.emit("error", new Error("boom"));
  const sys = store.getState().system;
  assert.ok(sys.includes("Relay added: a->b"));
  assert.match(sys.at(-1), /omp#1.*boom/);
});
test("dropSession 移除并重选焦点", () => {
  const store = createStore();
  store.attachSession("omp#1", fakeSession(), "omp", {});
  store.attachSession("codex#1", fakeSession(), "codex", {});
  store.setFocus("omp#1"); store.dropSession("omp#1");
  assert.strictEqual(store.getState().sessions["omp#1"], undefined);
  assert.strictEqual(store.getState().focusLabel, "codex#1");
});
```

- [ ] **Step 2: 跑测试看失败** → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/store.mjs — TUI 状态容器(纯逻辑,React 之外,可单测)。
// P1:每个 session 只保留"当前 turn 的流式 assistant 文本"(非完整 timeline,见计划头部说明)。
import { getEventAdapter } from "./events.mjs";
const MAX_SYSTEM = 100;

export function createStore() {
  const state = {
    sessions: {}, order: [], focusLabel: null,
    system: [], relays: [], fences: {},
  };
  const subs = new Set();
  const notify = () => { for (const fn of subs) fn(); };
  const trimSystem = () => { while (state.system.length > MAX_SYSTEM) state.system.shift(); };

  function ensure(label) {
    if (!state.sessions[label]) {
      state.sessions[label] = {
        agent: "", model: null, effort: null, status: "idle", isStreaming: false,
        turn: 0, assistantText: "", lastLine: "", turnStartAt: null, ms: null,
      };
      state.order.push(label);
    }
    return state.sessions[label];
  }
  function apply(label, ev) {
    if (!ev) return;
    const s = ensure(label);
    if (ev.kind === "status") {
      s.status = ev.status; s.isStreaming = ev.isStreaming;
      if (ev.status === "running") { s.assistantText = ""; s.lastLine = ""; s.turnStartAt = Date.now(); }
      else if (ev.status === "idle") {
        s.turn += 1;
        if (s.turnStartAt != null) { s.ms = Date.now() - s.turnStartAt; s.turnStartAt = null; }
      }
    } else if (ev.kind === "message.delta") {
      s.assistantText += ev.text;
      const nl = s.assistantText.lastIndexOf("\n");
      s.lastLine = nl === -1 ? s.assistantText : s.assistantText.slice(nl + 1);
    }
    notify();
  }
  return {
    getState() { return state; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    attachSession(label, session, agent, { model = null, effort = null } = {}) {
      const s = ensure(label); s.agent = agent; s.model = model; s.effort = effort;
      if (!state.focusLabel) state.focusLabel = label;
      const normalize = getEventAdapter(agent);
      session.on("delta", (d) => apply(label, normalize({ channel: "delta", payload: d, agent })));
      session.on("status", (st) => apply(label, normalize({ channel: "status", payload: st, agent })));
      session.on("event", (e) => apply(label, normalize({ channel: "event", payload: e, agent })));
      session.on("error", (err) => { state.system.push(`[${label}] ${err?.message ?? err}`); trimSystem(); notify(); });
      notify();
    },
    setFocus(label) { if (state.sessions[label]) { state.focusLabel = label; notify(); } },
    focusNext() {
      if (state.order.length === 0) return;
      const i = state.order.indexOf(state.focusLabel);
      state.focusLabel = state.order[(i + 1) % state.order.length]; notify();
    },
    pushSystem(line) { state.system.push(line); trimSystem(); notify(); },
    setRelays(list) { state.relays = list; notify(); },
    setFence(label, data) { state.fences[label] = data; notify(); },
    dropSession(label) {
      delete state.sessions[label];
      state.order = state.order.filter((l) => l !== label);
      if (state.focusLabel === label) state.focusLabel = state.order[state.order.length - 1] ?? null;
      notify();
    },
  };
}
```

- [ ] **Step 4: 跑测试看通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/store.mjs test/ui/tui/store.test.mjs
git commit -m "feat(tui): UI store (per-session current-turn text/focus/system) (P1 task4)"
```

---

## Task 5:命令提示引擎(`/`、`@`;`$` 识别不触发)

**Files:**
- Create: `src/ui/tui/hints.mjs`
- Create: `test/ui/tui/hints.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/hints.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { computeHints } from "../../../src/ui/tui/hints.mjs";
const ctx = { labels: () => ["omp#1", "codex#1"], flows: ["qa-loop"], backends: () => ["omp", "codex"], profiles: () => ["rev"] };

test("行首 / 列出斜杠命令", () => { const h = computeHints("/", ctx); assert.strictEqual(h.kind, "slash"); assert.ok(h.items.some((i) => i.value === "/open")); });
test("/op 前缀过滤", () => { assert.deepStrictEqual(computeHints("/op", ctx).items.map((i) => i.value), ["/open"]); });
test("/use 后补全 label", () => { assert.deepStrictEqual(computeHints("/use ", ctx).items.map((i) => i.value), ["omp#1", "codex#1"]); });
test("@ 列出 @all + 各 label", () => { assert.deepStrictEqual(computeHints("@", ctx).items.map((i) => i.value), ["@all", "@omp#1", "@codex#1"]); });
test("$ 识别为 shell 前缀但本期无候选(不报错)", () => { const h = computeHints("$ ", ctx); assert.strictEqual(h.kind, "shell"); assert.deepStrictEqual(h.items, []); });
test("普通文本无提示", () => { const h = computeHints("hello", ctx); assert.strictEqual(h.kind, "none"); assert.deepStrictEqual(h.items, []); });
```

- [ ] **Step 2: 跑测试看失败** → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/hints.mjs — TUI 输入提示(/ 与 @;$ 识别但本期无行为)。纯函数。
const SLASH = [
  ["/open", "新开会话 [+profile] [--agent/--model/--effort/--write/--mesh]"],
  ["/use", "切换当前会话 <label>"], ["/close", "关闭会话 <label>"], ["/sessions", "列出会话"],
  ["/relay", "建立转发 <from>-><to>"], ["/unrelay", "解除转发 <from>-><to>"], ["/relays", "列出转发规则"],
  ["/forward", "一次性转发 <from>-><to> [备注]"], ["/flow", "运行工作流 [<name> [输入]]"],
  ["/resume", "恢复中断的 flow <runId>"], ["/status", "总览"], ["/help", "帮助 [命令]"], ["/exit", "退出"],
];
const OPEN_OPTS = ["--agent", "--model", "--effort", "--write", "--mesh", "--no-mesh"];

export function computeHints(line, ctx) {
  const labels = ctx.labels();
  if (/^\/\S*$/.test(line)) {
    const items = SLASH.filter(([c]) => c.startsWith(line)).map(([value, desc]) => ({ value, desc }));
    return { kind: "slash", items }; // `/` 已列全部;非匹配前缀(/zz)返回空,不回退倒全表(codex 评审修正)
  }
  if (/^@\S*$/.test(line)) {
    const cands = ["@all", ...labels.map((l) => "@" + l)];
    return { kind: "target", items: cands.filter((c) => c.startsWith(line)).map((value) => ({ value, desc: "" })) };
  }
  if (/^\$/.test(line)) return { kind: "shell", items: [] };
  const parts = line.split(/\s+/), cmd = parts[0];
  const word = /\s$/.test(line) ? "" : parts[parts.length - 1];
  const mk = (arr) => ({ items: arr.map((value) => ({ value, desc: "" })) });
  if (cmd === "/use" || cmd === "/close") return { kind: "arg", ...mk(labels.filter((l) => l.startsWith(word))) };
  if (cmd === "/open") {
    if (parts[parts.length - 2] === "--agent") return { kind: "arg", ...mk(ctx.backends().filter((n) => n.startsWith(word))) };
    return { kind: "arg", ...mk([...ctx.profiles().map((p) => "+" + p), ...OPEN_OPTS].filter((c) => c.startsWith(word))) };
  }
  if (cmd === "/relay" || cmd === "/unrelay" || cmd === "/forward") {
    const arrow = word.indexOf("->");
    if (arrow === -1) return { kind: "arg", ...mk(labels.filter((l) => l.startsWith(word)).map((l) => l + "->")) };
    const left = word.slice(0, arrow + 2), right = word.slice(arrow + 2);
    return { kind: "arg", ...mk(labels.filter((l) => l.startsWith(right)).map((l) => left + l)) };
  }
  if (cmd === "/flow" && parts.length <= 2) return { kind: "arg", ...mk(ctx.flows.filter((n) => n.startsWith(word))) };
  return { kind: "none", items: [] };
}
```

- [ ] **Step 4: 跑测试看通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/hints.mjs test/ui/tui/hints.test.mjs
git commit -m "feat(tui): command hints engine (/ @ $) (P1 task5)"
```

---

## Task 6:鼠标(SGR 缓冲解析 + 区域注册 + 命中)

修正 codex #9/#10:① 只开 1000+1006(**不开 1002 drag**,避免 motion 被当 click);② 解析器**缓冲**处理分片/多序列,只产出鼠标事件、留存残段;③ 调用侧只接受**左键 press、非滚轮**;④ 坐标 **1-based**,命中检测沿用左闭右开但坐标按终端 1-based 传入。

**Files:**
- Create: `src/ui/tui/mouse.mjs`
- Create: `test/ui/tui/mouse.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/mouse.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { drainMouse, RegionRegistry, MOUSE_ON, MOUSE_OFF, isLeftClick } from "../../../src/ui/tui/mouse.mjs";

test("drainMouse 提取一个事件;尾随普通文本(非鼠标)被丢弃,rest 空", () => {
  const { events, rest } = drainMouse("\x1b[<0;12;5Mxyz");
  assert.deepStrictEqual(events, [{ x: 12, y: 5, button: 0, press: true, motion: false, wheel: 0 }]);
  assert.strictEqual(rest, "");   // "xyz" 是普通键盘字节,由 Ink 处理,鼠标 drainer 丢弃
});
test("drainMouse 一次提取多个事件,rest 空", () => {
  const { events, rest } = drainMouse("\x1b[<0;1;1M\x1b[<0;2;2m");
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[1].press, false);
  assert.strictEqual(rest, "");
});
test("drainMouse 完整事件 + 末尾不完整 ESC 片段:保留该片段待下次拼接", () => {
  const { events, rest } = drainMouse("\x1b[<0;1;1M\x1b[<0;12");
  assert.strictEqual(events.length, 1);
  assert.strictEqual(rest, "\x1b[<0;12");
});
test("drainMouse 纯不完整序列:整段留存", () => {
  const { events, rest } = drainMouse("\x1b[<0;12");
  assert.deepStrictEqual(events, []);
  assert.strictEqual(rest, "\x1b[<0;12");
});
test("滚轮(button 64)→ wheel:-1;motion(bit32)→ motion:true", () => {
  assert.strictEqual(drainMouse("\x1b[<64;1;1M").events[0].wheel, -1);
  assert.strictEqual(drainMouse("\x1b[<35;1;1M").events[0].motion, true);
});
test("isLeftClick:只认左键 press、非 motion、非 wheel", () => {
  assert.strictEqual(isLeftClick({ button: 0, press: true, motion: false, wheel: 0 }), true);
  assert.strictEqual(isLeftClick({ button: 0, press: false, motion: false, wheel: 0 }), false);
  assert.strictEqual(isLeftClick({ button: 0, press: true, motion: true, wheel: 0 }), false);
  assert.strictEqual(isLeftClick({ button: 64, press: true, motion: false, wheel: -1 }), false);
});
test("RegionRegistry 命中(1-based 坐标,左闭右开)", () => {
  const r = new RegionRegistry();
  r.set("agent:omp#1", { x: 71, y: 2, w: 30, h: 5 });
  assert.strictEqual(r.hit(72, 3), "agent:omp#1");
  assert.strictEqual(r.hit(71, 2), "agent:omp#1");
  assert.strictEqual(r.hit(101, 3), null);
  assert.strictEqual(r.hit(72, 7), null);
});
test("MOUSE_ON 只含 1000+1006(不含 1002),MOUSE_OFF 关之", () => {
  assert.ok(MOUSE_ON.includes("1000") && MOUSE_ON.includes("1006") && !MOUSE_ON.includes("1002"));
  assert.ok(MOUSE_OFF.includes("1006"));
});
```

- [ ] **Step 2: 跑测试看失败** → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/mouse.mjs — 手搓鼠标:SGR 上报开关、缓冲解析、区域注册 + 命中。
// 只开 1000(按键)+1006(SGR 坐标,支持 >223 列);不开 1002,避免拖动 motion 噪声。
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

// \x1b[<B;X;Y(M|m):M=按下/滚动,m=释放。B bit0-1=按钮,bit5(32)=motion,>=64=滚轮。
const SGR_G = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** 从输入缓冲提取所有完整鼠标事件,返回 { events, rest }(rest=尾部未完成片段)。 */
export function drainMouse(buf) {
  const events = [];
  let lastEnd = 0;
  SGR_G.lastIndex = 0;
  let m;
  while ((m = SGR_G.exec(buf)) !== null) {
    const b = Number(m[1]);
    events.push({
      x: Number(m[2]), y: Number(m[3]),
      button: b & 3, press: m[4] === "M",
      motion: (b & 32) !== 0, wheel: b >= 64 ? ((b & 1) ? 1 : -1) : 0,
    });
    lastEnd = SGR_G.lastIndex;
  }
  // 残段:最后一个 ESC 起、未被完整匹配的尾巴(可能是被截断的序列)。
  const tailEsc = buf.lastIndexOf("\x1b", buf.length);
  const rest = tailEsc >= lastEnd ? buf.slice(tailEsc) : "";
  return { events, rest };
}

export function isLeftClick(ev) {
  return Boolean(ev && ev.press && !ev.motion && ev.wheel === 0 && ev.button === 0);
}

export class RegionRegistry {
  constructor() { this.map = new Map(); }
  set(id, rect) { this.map.set(id, rect); }
  clear() { this.map.clear(); }
  hit(x, y) {
    for (const [id, r] of this.map) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return id;
    }
    return null;
  }
}
```

- [ ] **Step 4: 跑测试看通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/mouse.mjs test/ui/tui/mouse.test.mjs
git commit -m "feat(tui): buffered SGR mouse parse + region hit-test (P1 task6)"
```

---

## Task 7:Ink 组件(含 SystemStrip + 固定高 agent 卡)

修正 codex #6(系统消息要可见 → 新增 `SystemStrip`)与 #9(agent 卡**固定高度**,鼠标命中坐标才可推算)。**AgentRail 每张卡固定 5 行**:第 1 行 label+turn、第 2 行状态、第 3 行 relay-out(无则空行占位)、第 4 行 relay-in(无则空行占位)、第 5 行 lastLine。**不用条件行、不用 marginTop**——高度恒定。

**Files:**
- Create: `src/ui/tui/components/AgentRail.mjs` / `FocusPane.mjs` / `CollapsibleStrip.mjs` / `InputBar.mjs` / `SystemStrip.mjs` / `StatusBar.mjs`
- Create: `test/ui/tui/components.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/components.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { AgentRail } from "../../../src/ui/tui/components/AgentRail.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";
import { CollapsibleStrip } from "../../../src/ui/tui/components/CollapsibleStrip.mjs";
import { InputBar } from "../../../src/ui/tui/components/InputBar.mjs";
import { SystemStrip } from "../../../src/ui/tui/components/SystemStrip.mjs";
import { StatusBar } from "../../../src/ui/tui/components/StatusBar.mjs";

const sessions = {
  "omp#1": { agent: "omp", model: "deepseek-v4-pro", effort: "high", status: "running", isStreaming: true, turn: 4, assistantText: "分析中...", lastLine: "分析中...", ms: null },
  "codex#1": { agent: "codex", model: null, effort: null, status: "idle", isStreaming: false, turn: 3, assistantText: "评审完成", lastLine: "评审完成", ms: 1200 },
};

test("AgentRail 列出所有 label", () => {
  const { lastFrame } = render(html`<${AgentRail} sessions=${sessions} order=${["omp#1","codex#1"]} focusLabel="omp#1" relays=${[]} />`);
  assert.match(lastFrame(), /omp#1/); assert.match(lastFrame(), /codex#1/);
});
test("FocusPane 头部含 model/turn,正文含 assistantText", () => {
  const { lastFrame } = render(html`<${FocusPane} label="omp#1" sess=${sessions["omp#1"]} fence=${null} relays=${[]} />`);
  assert.match(lastFrame(), /omp#1/); assert.match(lastFrame(), /deepseek-v4-pro/); assert.match(lastFrame(), /分析中/);
});
test("FocusPane 无会话时给提示", () => {
  const { lastFrame } = render(html`<${FocusPane} label=${null} sess=${undefined} fence=${null} relays=${[]} />`);
  assert.match(lastFrame(), /无会话|\^O/);
});
test("CollapsibleStrip 折叠只显摘要,展开显明细", () => {
  assert.match(render(html`<${CollapsibleStrip} label="编排意图" summary="3 cmds" expanded=${false} detail="x" />`).lastFrame(), /3 cmds/);
  assert.match(render(html`<${CollapsibleStrip} label="编排意图" summary="3 cmds" expanded=${true} detail="DETAIL-LINE" />`).lastFrame(), /DETAIL-LINE/);
});
test("InputBar 显示前缀 + 文本;有提示时渲染候选", () => {
  assert.match(render(html`<${InputBar} focusLabel="omp#1" value="给它加测试" hints=${{kind:"none",items:[]}} />`).lastFrame(), /omp#1/);
  assert.match(render(html`<${InputBar} focusLabel="omp#1" value="/op" hints=${{kind:"slash",items:[{value:"/open",desc:"新开"}]}} />`).lastFrame(), /\/open/);
});
test("SystemStrip 渲染最近系统消息", () => {
  assert.match(render(html`<${SystemStrip} messages=${["Relay added: a->b", "No session x"]} />`).lastFrame(), /No session x/);
});
test("SystemStrip 空时不报错", () => {
  assert.doesNotThrow(() => render(html`<${SystemStrip} messages=${[]} />`));
});
test("StatusBar 显示运行数", () => {
  assert.match(render(html`<${StatusBar} running=${1} mesh=${true} />`).lastFrame(), /1 running/);
});
```

- [ ] **Step 2: 跑测试看失败** → FAIL

- [ ] **Step 3: 实现各组件**

```js
// src/ui/tui/components/StatusBar.mjs
import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function StatusBar({ running, mesh }) {
  return html`<${Box} justifyContent="space-between" paddingX=${1}>
    <${Text} dimColor>↹ 切焦点  ^O 开  ^W 关  / 命令  ^C 退出<//>
    <${Text} color="blue">● ${running} running · mesh ${mesh ? "on" : "off"}<//>
  <//>`;
}
```

```js
// src/ui/tui/components/SystemStrip.mjs — 渲染来自捕获流/错误的系统消息(最近 3 条)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function SystemStrip({ messages }) {
  const recent = (messages || []).slice(-3);
  if (recent.length === 0) return html`<${Box}/>`;
  return html`<${Box} flexDirection="column" paddingX=${1}>
    ${recent.map((m, i) => html`<${Text} key=${i} dimColor wrap="truncate-end">· ${m}<//>`)}
  <//>`;
}
```

```js
// src/ui/tui/components/AgentRail.mjs — 固定高卡片(每卡恒 5 行内容,鼠标命中可推算)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function AgentRail({ sessions, order, focusLabel, relays }) {
  const outTo = (l) => relays.filter((r) => r.from === l).map((r) => r.to);
  const inFrom = (l) => relays.filter((r) => r.to === l).map((r) => r.from);
  return html`<${Box} flexDirection="column" width=${30} borderStyle="single" borderColor="gray">
    <${Box} paddingX=${1}><${Text} color="magenta">AGENTS · ${order.length}  ↹/点击<//><//>
    ${order.map((label) => {
      const s = sessions[label]; const sel = label === focusLabel;
      const out = outTo(label), inn = inFrom(label);
      return html`<${Box} key=${label} flexDirection="column" paddingX=${1}
          borderStyle="single" borderColor=${sel ? "blue" : "gray"}>
        <${Text} bold=${sel} color=${sel ? "blue" : undefined} wrap="truncate-end">
          ${s.status === "running" ? "● " : "✓ "}${label}  t${s.turn}<//>
        <${Text} color=${s.status === "running" ? "blue" : "green"} wrap="truncate-end">
          ${s.status === "running" ? "running" : "idle"}${s.ms ? ` · ${(s.ms/1000).toFixed(1)}s` : ""}<//>
        <${Text} color="magenta" wrap="truncate-end">${out.length ? "▶ " + out.join(",") : " "}<//>
        <${Text} dimColor wrap="truncate-end">${inn.length ? "◀ " + inn.join(",") : " "}<//>
        <${Text} dimColor wrap="truncate-end">${s.lastLine || " "}<//>
      <//>`;
    })}
  <//>`;
}
```

> 固定高:每卡用 `borderStyle="single"`(占 2 行边框)+ 恒 5 行内容 = **7 行/卡**;首卡从 rail 内第 2 行(header 占 1 行 + rail 顶边框 1 行)起。Task 9 的区域推算据此:`y0 = railTop + 2`,每卡 `h = 7`。relay 行即使空也渲染占位(空格),保证高度恒定。

```js
// src/ui/tui/components/CollapsibleStrip.mjs
import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function CollapsibleStrip({ label, summary, expanded, detail, hot }) {
  return html`<${Box} flexDirection="column" borderStyle="single" borderColor="gray" paddingX=${1}>
    <${Box}>
      <${Text}>${expanded ? "▾" : "▸"} <${Text} bold>${label}<//>${hot ? html`<${Text} color="yellow"> ●<//>` : null}<//>
      <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} dimColor>${summary}<//><//>
    <//>
    ${expanded ? html`<${Text}>${detail}<//>` : null}
  <//>`;
}
```

```js
// src/ui/tui/components/FocusPane.mjs
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { CollapsibleStrip } from "./CollapsibleStrip.mjs";
export function FocusPane({ label, sess, fence, relays, expandC = false, expandD = false }) {
  if (!sess) return html`<${Box} flexGrow=${1} paddingX=${1}><${Text} dimColor>无会话。^O 新开一个。<//><//>`;
  const meta = [sess.agent, sess.model || "default", sess.effort ? `effort ${sess.effort}` : null].filter(Boolean).join(" · ");
  const out = relays.filter((r) => r.from === label).map((r) => r.to);
  const inn = relays.filter((r) => r.to === label).map((r) => r.from);
  const cSummary = fence ? `${fence.commands.length} cmds${fence.feedbackSent ? " · 回喂已发" : ""}` : "—";
  const dSummary = `▶ out ${out.join(",") || "—"} · ◀ in ${inn.join(",") || "—"}`;
  return html`<${Box} flexDirection="column" flexGrow=${1}>
    <${Box} flexDirection="column" borderStyle="single" borderColor="blue" paddingX=${1}>
      <${Box}>
        <${Text} color=${sess.status === "running" ? "blue" : "green"}>● <//><${Text} bold color="blue">${label}<//>
        <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color="blue">
          ${sess.status} · turn ${sess.turn}${sess.ms ? ` · ${(sess.ms/1000).toFixed(1)}s` : ""}<//><//>
      <//>
      <${Text} dimColor>${meta}<//>
    <//>
    <${Box} flexGrow=${1} flexDirection="column" paddingX=${1}>
      <${Text}>${sess.assistantText || ""}${sess.isStreaming ? "▌" : ""}<//>
    <//>
    <${CollapsibleStrip} label="C 编排意图" summary=${cSummary} expanded=${expandC} hot=${Boolean(fence && !fence.seen)}
      detail=${fence ? fence.commands.map((c) => `${c.cmd} → ${c.result}`).join("\n") : ""} />
    <${CollapsibleStrip} label="D relay" summary=${dSummary} expanded=${expandD}
      detail=${`out: ${out.join(",") || "—"}\nin: ${inn.join(",") || "—"}`} />
  <//>`;
}
```

```js
// src/ui/tui/components/InputBar.mjs
import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function InputBar({ focusLabel, value, hints }) {
  return html`<${Box} flexDirection="column">
    ${hints && hints.items.length ? html`<${Box} flexDirection="column" paddingX=${1}>
      ${hints.items.slice(0, 6).map((it) => html`<${Box} key=${it.value}>
        <${Text} color="cyan">${it.value}<//>${it.desc ? html`<${Text} dimColor>  ${it.desc}<//>` : null}
      <//>`)}
    <//>` : null}
    <${Box} borderStyle="single" borderColor="blue" paddingX=${1}>
      <${Text} color="green" bold>[${focusLabel || "—"}] ❯ <//><${Text}>${value}▌<//>
    <//>
  <//>`;
}
```

- [ ] **Step 4: 跑测试看通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/components test/ui/tui/components.test.mjs
git commit -m "feat(tui): Ink components incl SystemStrip + fixed-height rail (P1 task7)"
```

---

## Task 8:App 组合 + 键盘/Ctrl-C/焦点回调

修正 codex #1(焦点即路由)与 #2(Ctrl-C)。App 不直接碰 sm;通过注入回调 `onSelect(label)` / `onCycle()` / `onInterrupt()` 与外部交互。**普通输入交给 dispatch(发往 sm 当前会话);焦点切换调 `onCycle/onSelect` 由 cli 同步 `sm.use()`;Ctrl-C 调 `onInterrupt`。** 渲染 SystemStrip。

**Files:**
- Create: `src/ui/tui/app.mjs`
- Create: `test/ui/tui/app.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/app.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { App } from "../../../src/ui/tui/app.mjs";
import { EventEmitter } from "node:events";

const ctx = { labels: () => ["omp#1"], flows: [], backends: () => ["omp"], profiles: () => [] };
function base(store) {
  return { store, dispatch: () => ({}), hintsCtx: ctx, mesh: true, onSelect: () => {}, onCycle: () => {}, onInterrupt: () => {} };
}

test("App 渲染焦点 label 与系统消息", () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", { model: "m" });
  store.pushSystem("Relay added: a->b");
  const { lastFrame } = render(html`<${App} ...${base(store)} />`);
  assert.match(lastFrame(), /omp#1/);
  assert.match(lastFrame(), /Relay added/);
});
test("回车把输入行交给 dispatch(source:human),并在之后同步焦点", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  const calls = [];
  const props = { ...base(store), dispatch: (line, opts) => { calls.push([line, opts]); return { redraw: true }; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("hello"); stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls.at(-1), ["hello", { source: "human" }]);
});
test("Tab 调 onCycle;Ctrl-C 调 onInterrupt", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  let cycled = 0, interrupted = 0;
  const props = { ...base(store), onCycle: () => { cycled++; }, onInterrupt: () => { interrupted++; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("\t");           // Tab
  stdin.write("\x03");         // Ctrl-C
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cycled >= 1); assert.ok(interrupted >= 1);
});
test("输入 /exit(dispatch 返回 {exit:true})→ 调 onInterrupt", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  let interrupted = 0;
  const props = { ...base(store), dispatch: () => ({ exit: true }), onInterrupt: () => { interrupted++; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("/exit"); stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(interrupted >= 1);
});
```

> 说明:`html\`<${App} ...${props} />\``——htm 支持 `...${obj}` 展开 props。

- [ ] **Step 2: 跑测试看失败** → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/app.mjs — TUI 根组件:布局 + 键盘 + Ctrl-C + 焦点回调 + store 订阅。
import { useState, useEffect } from "react";
import { Box, useInput } from "ink";
import { html } from "./html.mjs";
import { AgentRail } from "./components/AgentRail.mjs";
import { FocusPane } from "./components/FocusPane.mjs";
import { InputBar } from "./components/InputBar.mjs";
import { SystemStrip } from "./components/SystemStrip.mjs";
import { StatusBar } from "./components/StatusBar.mjs";
import { computeHints } from "./hints.mjs";

export function App({ store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt }) {
  const [, force] = useState(0);
  const [value, setValue] = useState("");
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  const st = store.getState();
  const hints = computeHints(value, hintsCtx);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onInterrupt(); return; }
    if (key.tab) { onCycle(); return; }
    if (key.return) {
      const line = value.trim(); setValue("");
      if (line) {
        const r = dispatch(line, { source: "human" });
        if (r && r.exit) onInterrupt();   // /exit /quit → 触发优雅退出(同 Ctrl-C 收尾链)
      }
      return;
    }
    if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); return; }
    if (key.ctrl && input === "o") { dispatch("/open", { source: "human" }); return; }
    if (key.ctrl && input === "w" && st.focusLabel) { dispatch(`/close ${st.focusLabel}`, { source: "human" }); return; }
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });

  const running = Object.values(st.sessions).filter((s) => s.status === "running").length;
  return html`<${Box} flexDirection="column" width="100%">
    <${Box} flexGrow=${1}>
      <${FocusPane} label=${st.focusLabel} sess=${st.sessions[st.focusLabel]} fence=${st.fences[st.focusLabel] || null} relays=${st.relays} />
      <${AgentRail} sessions=${st.sessions} order=${st.order} focusLabel=${st.focusLabel} relays=${st.relays} />
    <//>
    <${SystemStrip} messages=${st.system} />
    <${InputBar} focusLabel=${st.focusLabel} value=${value} hints=${hints} />
    <${StatusBar} running=${running} mesh=${mesh} />
  <//>`;
}
```

> 焦点即路由(codex #1):App 的普通输入永远经 `dispatch(line,{source:"human"})` 发往 **sm 当前会话**;`onCycle/onSelect` 由 cli 实现为"`sm.use(label)` + `store.setFocus(label)`",并在每次 `dispatch` 后由 cli 包装器把 `store.setFocus(sm.currentLabel)` 对齐(覆盖 `/open`、`/use` 改 current 的情况)。这样"看到选中的"永远等于"消息发往的"。

- [ ] **Step 4: 跑测试看通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/app.mjs test/ui/tui/app.test.mjs
git commit -m "feat(tui): App layout + focus-as-routing + Ctrl-C callback (P1 task8)"
```

---

## Task 9:`startTui` 生命周期(alt-screen / 缓冲鼠标 / resize / 收尾还原)

修正 codex #10(缓冲鼠标循环 + 只认左键 click)与 #12(resize 重算区域)。

**Files:**
- Create: `src/ui/tui/index.mjs`
- Create: `test/ui/tui/index.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/index.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { buildTeardown, ENTER_ALT, EXIT_ALT, computeRailRegions } from "../../../src/ui/tui/index.mjs";
import { MOUSE_OFF } from "../../../src/ui/tui/mouse.mjs";

test("teardown 写出退出 alt-screen + 关鼠标 + 显光标", () => {
  const out = []; const stdout = { write: (s) => { out.push(s); return true; } };
  buildTeardown(stdout)();
  const j = out.join("");
  assert.ok(j.includes(EXIT_ALT) && j.includes(MOUSE_OFF) && j.includes("\x1b[?25h"));
});
test("ENTER/EXIT_ALT 是 alt-screen 转义", () => {
  assert.ok(ENTER_ALT.includes("?1049h")); assert.ok(EXIT_ALT.includes("?1049l"));
});
test("computeRailRegions:右栏宽 30 贴右,首卡 railTop+2,每卡高 7(1-based)", () => {
  const regs = computeRailRegions(["omp#1", "codex#1"], 100);
  // 右栏左边界 = cols-30+1 = 71(1-based)
  assert.deepStrictEqual(regs["agent:omp#1"], { x: 71, y: 3, w: 30, h: 7 });
  assert.deepStrictEqual(regs["agent:codex#1"], { x: 71, y: 10, w: 30, h: 7 });
});
```

- [ ] **Step 2: 跑测试看失败** → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/index.mjs — 启动/拆除全屏 TUI。Ink 动态 import(核心零依赖路径不触发)。
import { MOUSE_ON, MOUSE_OFF, drainMouse, isLeftClick, RegionRegistry } from "./mouse.mjs";

export const ENTER_ALT = "\x1b[?1049h";
export const EXIT_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export function buildTeardown(stdout) {
  let done = false;
  return function teardown() {
    if (done) return; done = true;
    try { stdout.write(MOUSE_OFF + SHOW_CURSOR + EXIT_ALT); } catch {}
  };
}

// 右栏 agent 卡矩形(1-based)。右栏宽 30 贴右;rail 顶边框 1 行 + header 1 行 → 首卡从第 3 行起;
// 每卡 borderStyle 占 7 行(见 AgentRail 固定高说明)。纯函数,便于单测。
export function computeRailRegions(order, cols) {
  const x = (cols || 100) - 30 + 1;     // 1-based 左边界
  const regs = {};
  order.forEach((label, i) => { regs[`agent:${label}`] = { x, y: 3 + i * 7, w: 30, h: 7 }; });
  return regs;
}

export async function startTui({ store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt, stdin = process.stdin, stdout = process.stdout }) {
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { App } = await import("./app.mjs");

  stdout.write(ENTER_ALT + HIDE_CURSOR + MOUSE_ON);
  const teardown = buildTeardown(stdout);

  const regions = new RegionRegistry();
  const relayout = () => {
    regions.clear();
    const regs = computeRailRegions(store.getState().order, stdout.columns);
    for (const [id, r] of Object.entries(regs)) regions.set(id, r);
  };
  relayout();
  const unsub = store.subscribe(relayout);
  const onResize = () => relayout();
  stdout.on?.("resize", onResize);

  // 缓冲式鼠标:累积 stdin,循环提取完整 SGR 事件,只对左键 click 命中右栏卡 → onSelect。
  let mbuf = "";
  function onData(chunk) {
    mbuf += chunk.toString("utf8");
    const { events, rest } = drainMouse(mbuf);
    mbuf = rest.length < 64 ? rest : "";   // 防御:异常超长残段丢弃
    for (const ev of events) {
      if (!isLeftClick(ev)) continue;
      const id = regions.hit(ev.x, ev.y);
      if (id && id.startsWith("agent:")) onSelect(id.slice("agent:".length));
    }
  }
  stdin.on("data", onData);

  const instance = render(
    React.createElement(App, { store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt }),
    { stdout, stdin, exitOnCtrlC: false },
  );

  const cleanup = () => { stdin.off?.("data", onData); stdout.off?.("resize", onResize); unsub(); teardown(); };
  instance.waitUntilExit().then(cleanup, cleanup);
  return {
    waitUntilExit: instance.waitUntilExit.bind(instance),
    unmount: instance.unmount.bind(instance),
    teardown: cleanup,
  };
}
```

> Ctrl-C:`exitOnCtrlC:false` → App 的 `useInput` 接管;App 调注入的 `onInterrupt`(cli 实现为优雅收尾,见 Task 10)。

- [ ] **Step 4: 跑测试看通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/index.mjs test/ui/tui/index.test.mjs
git commit -m "feat(tui): startTui lifecycle (buffered mouse/resize/teardown) (P1 task9)"
```

---

## Task 10:cli.mjs 接线(`--no-tui` + 双 TTY 判定 + 共享 drain/退出 + 焦点同步)

修正 codex #2/#3/#4/#5:① 抽 `drainAndClose` 共享给两条前端;② **不在 main() 内重复 `installShutdownHandlers`**;③ `shouldUseTui` 要 `stdin.isTTY && stdout.isTTY`;④ TUI 分支内自定义 `flowsRoot`;⑤ 焦点切换同步 `sm.use`。

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli-ui.integration.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// 追加到 test/cli-ui.integration.test.mjs
import { shouldUseTui } from "../src/cli.mjs";
const tty = (v) => ({ isTTY: v });
test("shouldUseTui:stdin+stdout 都 TTY、交互、未禁用 → true", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [], noTui: false }, {}), true));
test("shouldUseTui:stdin 非 TTY(管道喂入)→ false", () =>
  assert.strictEqual(shouldUseTui(tty(false), tty(true), { tasks: [], noTui: false }, {}), false));
test("shouldUseTui:stdout 非 TTY → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(false), { tasks: [], noTui: false }, {}), false));
test("shouldUseTui:--task → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [{}], noTui: false }, {}), false));
test("shouldUseTui:--no-tui → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [], noTui: true }, {}), false));
test("shouldUseTui:SYNOD_NO_TUI=1 → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [], noTui: false }, { SYNOD_NO_TUI: "1" }), false));
```

- [ ] **Step 2: 跑测试看失败** → `node --test test/cli-ui.integration.test.mjs` → FAIL（`shouldUseTui` 未导出）

- [ ] **Step 3: 实现**

3a. `parseArgs`:`out` 初值加 `noTui: false,`;switch 加 `case "--no-tui": out.noTui = true; break;`;help 文本加 `  --no-tui              Disable the full-screen TUI (use the line REPL)`。

3b. 新增导出纯函数(签名收 stdin+stdout):

```js
// 是否进入全屏 TUI:stdin 与 stdout 都须是 TTY(管道喂入/输出重定向都退回行 REPL);
// 非 --task、未 --no-tui、无 SYNOD_NO_TUI。
export function shouldUseTui(stdin, stdout, args, env) {
  if (!stdin || !stdin.isTTY || !stdout || !stdout.isTTY) return false;
  if (args.tasks && args.tasks.length > 0) return false;
  if (args.noTui) return false;
  if (env && (env.SYNOD_NO_TUI === "1" || env.SYNOD_NO_TUI === "true")) return false;
  return true;
}
```

3c. 把现有交互分支的 onClose **排水核心**抽成可复用函数(在 main() 内,sm/registry/drainControl/controlActivity 都在闭包里时定义),供 line-REPL 的 onClose 与 TUI 退出共用。提取既有 [cli.mjs onClose] 的 5 轮 drain + relay 清理 + flush + closeAll 主体为:

```js
  // 退出排水(line REPL 与 TUI 共用):有界不动点排空在飞 turn / control fence / relay 级联,
  // 再清 relay 规则、flush、closeAll。drainCtl/活动计数由调用方闭包提供。
  async function drainAndClose({ sm, registry, drainControl, controlActivity }) {
    try {
      for (let round = 0; round < 5; round += 1) {
        const beforeLoad = sm.sessionLoad, beforeAct = controlActivity();
        await sm.drainAll(); await drainControl();
        await sm.drainAll(); await drainControl();
        if (sm.sessionLoad === beforeLoad && controlActivity() === beforeAct) break;
      }
    } finally {
      // 即使 drainAll 抛("did not quiesce"等),也务必清 relay、flush、关全部会话(对齐老 onClose 的 finally)。
      for (const [label] of sm._sessions) registry.removeForLabel(label);
      sm.flushAll(); sm.closeAll();
    }
  }
```

> 把现有 line-REPL 的 `onClose`(cli.mjs:542 起)主体替换为调用 `drainAndClose({ sm, registry, drainControl, controlActivity })`(flow abort/await 部分保留在 onClose,不动),确保两条前端语义一致、不重复维护。

3d. TUI 分支(放在 `args.tasks.length>0` 非交互判断**之后**、现有交互 REPL 初始化**之前**;分支内自带 sm/registry/dispatch/wireControl 与独立 `flowsRoot`):

```js
  // ── TUI 分支(stdin+stdout 皆 TTY 默认进;捕获流隔离全屏)────────────────────
  if (shouldUseTui(stdin, stdout, args, env)) {
    const flowsRootTui = workflowsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
    const { startTui } = await import("./ui/tui/index.mjs");
    const { createStore } = await import("./ui/tui/store.mjs");
    const { makeCaptureStream } = await import("./ui/tui/capture.mjs");

    const store = createStore();
    const cap = makeCaptureStream((line) => store.pushSystem(line));

    let smTui, composed;
    const registry = createRelayRegistry((to, msg, meta) => {
      if (meta) store.pushSystem(`[relay ${meta.from}→${to}] ${meta.chars} chars`);
      smTui.enqueue({ target: to, msg });
    });
    smTui = createSessionManager({
      openBackend, stdout: cap, stderr: cap, report, cwd,
      defaults: { model: args.model, effort: args.effort, write: args.write, mesh },
      onIdle: () => {}, renderOutput: false,                       // ← 模型输出不写 stdout,TUI 自渲染
      onSessionOpen: (label, session) => {
        const info = smTui._sessions.get(label);
        store.attachSession(label, session, info.agent, { model: info.model, effort: info.effort });
        store.setRelays(registry.list());
      },
      onTurnComplete: (label, result) => { if (composed) composed(label, result); store.setRelays(registry.list()); },
      relays: () => registry.list(), env,
    });
    let _dropDepthTui = () => {};
    const dispatchTui = createReplDispatch({
      sm: smTui, registry, stdout: cap, stderr: cap, defaultAgent: args.agent,
      guardrails: { maxSessions: 10, maxDepth: 3, allowWrite: false }, config, flowStatus: () => "none",
      onCloseLabel: (label) => _dropDepthTui(label),     // /close 后清 control-wire depth(对齐老 REPL)
    });
    const wired = wireControl({ sm: smTui, registry, stderr: cap, dispatch: dispatchTui });
    composed = wired.onTurnComplete;
    _dropDepthTui = wired.dropLabel;
    const drainControl = wired.drainControl, controlActivity = wired.controlActivity;

    // 焦点即路由:切焦点 = sm.use + store.setFocus;每次 dispatch 后把 store 焦点对齐 sm.currentLabel。
    const syncFocus = () => { store.setFocus(smTui.currentLabel); for (const l of store.getState().order) if (!smTui._sessions.has(l)) store.dropSession(l); };
    const onSelect = (label) => { if (smTui.use(label)) store.setFocus(label); };
    const onCycle = () => { store.focusNext(); const f = store.getState().focusLabel; if (f) smTui.use(f); };
    const dispatchWrapped = (line, opts) => { const r = dispatchTui(line, opts); Promise.resolve(r).finally?.(syncFocus); syncFocus(); return r; };

    const flowList = await (async () => { try { return (await discoverFlows(flowsRootTui)).flows?.map((f) => f.name) ?? []; } catch { return []; } })();
    const hintsCtx = {
      labels: () => [...smTui._sessions.keys()], flows: flowList,
      backends: () => backendNames(), profiles: () => Object.keys(config.agents ?? {}),
    };

    // 启动残留 worktree 提示也进系统消息条(对齐老交互路径,别因走 TUI 就丢)。
    try { const n = residualWorktreeNotice(scanResidualWorktrees(cwd)); if (n) store.pushSystem(n.trim()); } catch {}

    const defLabel = await smTui.open({ agent: args.agent, announce: false });
    if (!defLabel) return 3;
    store.setFocus(smTui.currentLabel);

    let tui;
    // 首次 Ctrl-C / `/exit`:abort 所有在跑 turn(等价老 REPL gracefulShutdown 的 abort,避免长任务卡退出),
    // 再 unmount → waitUntilExit resolve → 下面 drainAndClose 收尾。abort 可能返回 Promise,统一 catch 防
    // unhandledRejection(codex MINOR)。若 unmount 完成前用户再按一次 Ctrl-C(此刻仍在 App 内、useInput 还活着)
    // → 第二次直接同步强关退出;unmount 之后的 Ctrl-C 才落到入口安装的进程级 SIGINT handler。
    let _interruptCount = 0;
    const onInterrupt = () => {
      _interruptCount += 1;
      if (_interruptCount >= 2) { closeAllLiveSessionsSync(); process.exit(1); return; }
      for (const [, info] of smTui._sessions) {
        try { Promise.resolve(info.session.abort?.()).catch(() => {}); } catch {}
      }
      try { tui.unmount(); } catch {}
    };
    tui = await startTui({ store, dispatch: dispatchWrapped, hintsCtx, mesh, onSelect, onCycle, onInterrupt, stdin, stdout });
    await tui.waitUntilExit();
    await drainAndClose({ sm: smTui, registry, drainControl, controlActivity });
    return 0;
  }
```

> 不在此分支调 `installShutdownHandlers`(入口 `_isMain` 块已装一次,line:682;TTY raw 模式下 Ctrl-C 走 Ink 的 `useInput`,进程级 SIGINT 兜底仍在)。`composed`/`smTui` 是闭包延迟引用,turn 完成时早已初始化(codex 已确认非 TDZ)。`/flow` 在 TUI 内由 dispatch 缺省 runFlow 报"不可用"→ 进系统消息条(P1 不接 flow 的 approve/question);完整 flow 接线列入后续。

- [ ] **Step 4: 跑测试看通过 + 既有 cli 测试不回归**

Run: `node --test test/cli-ui.integration.test.mjs test/cli.custom-backend.integration.test.mjs` → PASS

- [ ] **Step 5: 手动冒烟(真 TTY)**

- `node src/cli.mjs`:进 TUI;右栏 omp#1;输入 `hi`↵ 焦点区流式;`↹` 切焦点(消息随焦点走);鼠标点右栏卡切焦点;`/open --agent codex` 右栏出 codex#1 且焦点跟随;`/relay omp#1->codex#1` 在系统消息条看到反馈;`Ctrl-C` 优雅退出、终端还原(无 alt-screen 残留 / 光标恢复 / 无鼠标乱码)。
- `node src/cli.mjs --no-tui`、`echo hi | node src/cli.mjs --task omp:"hi"`、`echo hi | node src/cli.mjs`:均走老路径/纯文本,行为同改动前。

- [ ] **Step 6: 全量受影响测试 + Commit**

Run: `node --test test/cli-ui.integration.test.mjs test/session-manager*.test.mjs test/ui/tui/*.test.mjs`
Expected: PASS（本机 symlink/EPERM 类既有失败除外）

```bash
git add src/cli.mjs test/cli-ui.integration.test.mjs
git commit -m "feat(cli): TUI front-end — double-TTY gate, shared drainAndClose, focus-as-routing (P1 task10)"
```

---

## P2(另立计划,不在本计划内)

富工具调用卡片:`events.mjs` 注册 omp/codex 专用适配器(omp:`tool_execution_start/end`+`toolcall_*`;codex:`item/*` 去剥离),`backend.mjs` 给工具事件一条**不经 compactEvent 截断**的原始通道;`ToolCard`(收起/展开、diff/output);store 升级为**有序条目时间线**(user/assistant/tool 混排)+ 用户消息回显;C 编排意图接 control-wire 真实数据;`$` 命令语义另定;flow 在 TUI 内的 approve/question 接线。详见 spec §5/§7/§10。

---

## 自检(写完对照 spec + codex 评审)

- **spec 覆盖**:L3 三区(Task7/8 ✓)、右栏点击+键盘切焦点且**焦点即路由**(Task6/8/9/10 ✓)、焦点区 B+E 头部(FocusPane ✓)、A 当前 turn 文本流式(store+FocusPane ✓,P1 范围已在头部校正)、C/D 折叠条(CollapsibleStrip ✓;C 真实数据 P1 留 `setFence` 接口,默认 "—")、系统消息可见(SystemStrip ✓)、`/`@`提示(Task5 ✓)、`$` 识别不触发(Task5 ✓)、Ink+htm+手搓鼠标(Task6/9 ✓)、注册制适配器(Task3 ✓)、TTY(双 TTY)默认进 TUI+`--no-tui`+非 TTY 不变(Task10 ✓)、退出/SIGINT/drain 与老 REPL 共用(drainAndClose,Task10 ✓)、终端还原(Task9 ✓)、模型输出不双渲染(renderOutput,Task2 ✓)、F 已砍 ✓。
- **codex 第 1 轮 12 条**:#1 焦点路由(Task8/10 ✓)、#2 退出/SIGINT/drain 复用(Task10 drainAndClose ✓)、#3 不重复装 shutdown(Task10 ✓)、#4 双 TTY(Task10 ✓)、#5 flowsRoot 作用域(Task10 自定义 ✓)、#6 系统消息可见(SystemStrip ✓)、#7 renderOutput 防双渲染(Task2 ✓)、#8 fakeOpenBackend 用法(Task2 ✓)、#9 固定高卡片+1-based 坐标+区域测试(Task7/9 ✓)、#10 缓冲鼠标+只认左键(Task6/9 ✓)、#11 store 措辞校正(头部+Task4 注释 ✓)、#12 resize 重算(Task9 ✓)。
- **占位扫描**:无 TODO/TBD;每步含可运行代码与命令。
- **类型一致**:store 方法名(attachSession/setFocus/focusNext/pushSystem/setRelays/setFence/dropSession/getState/subscribe)跨 app/index/cli 一致;`computeHints` 返回 `{kind,items:[{value,desc}]}` 与 InputBar 一致;`drainMouse` 返回 `{events:[{x,y,button,press,motion,wheel}],rest}` 与 index 用法一致;`computeRailRegions` 返回 `{[id]:{x,y,w,h}}` 与 RegionRegistry.set 一致;`shouldUseTui(stdin,stdout,args,env)` 与 cli 调用一致。
- **codex 第 2 轮 7 条**:`/exit` 在 TUI 生效(App 处理 `r.exit`→onInterrupt,Task8 ✓)、Ctrl-C 先 abort 在跑会话再 unmount(Task10 onInterrupt ✓)、`drainAndClose` try/finally 保证必关(Task10 ✓)、`drainMouse` 测试/实现对齐(尾随普通文本丢弃 rest="",Task6 ✓)、AgentRail 全可变行 `truncate-end` 保固定高(Task7 ✓)、TUI dispatch 接 `onCloseLabel→dropLabel`(Task10 ✓)、residual worktree 提示进系统消息条(Task10 ✓)。
- **遗留留门(非阻塞)**:C 真实数据、完整 timeline、flow 在 TUI 内 approve/question → P2。
```

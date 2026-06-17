# flow-in-TUI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐 task 执行。步骤用 `- [ ]` 复选框跟踪。

**目标:** 让全屏 TUI 里的 `/flow` / `/resume` 真正能跑——把运行中的 flow 投影成只读会话卡,复用现有 rail/焦点流/待你/输入框,支持自主跑完型与交互 approve 型。

**架构:** 不改 flow 引擎核心。`flow.mjs main()` 已把 `progress`/`io`/`signal` 作为可注入依赖透传给 `createRuntime`;新增 TUI 驱动 `flow-tui.mjs` 装配这三件套——`progress` 投影 store、`io.question` 把 approve 挂「待你」由输入框作答、`signal` 接 Ctrl-C。唯一碰引擎处:`main()` 增加可注入 `progress` 入参(现内部从 `stdout` 自建)。

**技术栈:** Node ESM、Ink ^6、node:test、现有 `src/ui/tui/*`、现有 flow 引擎(`src/flow.mjs` + `src/flow/runtime.mjs`)。

**对应 spec:** `docs/superpowers/specs/2026-06-16-flow-in-tui-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/flow.mjs` | 改 | `main()` 接受可注入 `progress` 入参(一行 + 签名) |
| `src/ui/tui/store.mjs` | 改 | flow 伪会话模型 + 8 个驱动方法 |
| `src/ui/tui/flow-tui.mjs` | 建 | flow 驱动:tuiSink/tuiIo/capSink + runFlow/resumeFlow/flowStatus/abortAll/answer/handleHumanLine |
| `src/cli.mjs` | 改 | TUI 分支接线 + onInterrupt abortAll + syncFocus 收窄 + dispatchWrapped 路由 |
| `src/ui/tui/components/AgentRail.mjs` | 改 | flow 卡显示名 `⑂agent` + done/failed 态 |
| `src/ui/tui/components/FocusPane.mjs` | 改 | 渲染 `output`/`approve` 条目 + flow 头部标记 |
| `src/ui/tui/components/InputBar.mjs` | 改 | 待答 flow 焦点时提示 `approve ❯` |
| `test/flow.main.test.mjs` | 改 | 注入 `progress` 用例 |
| `test/ui/tui/store.flow.test.mjs` | 建 | store flow 方法单测 |
| `test/ui/tui/flow-tui.test.mjs` | 建 | flow-tui 单测(注入假 flowMain) |
| `scripts/smoke-tui.mjs` | 改 | 端到端冒烟:卡片→approve→作答→完成 |

---

## Task 1: `flow.mjs` 接受可注入 `progress`

**Files:**
- Modify: `src/flow.mjs`(`main()` 签名 + `flow.mjs:344-348` 的 `progressSink` 计算)
- Test: `test/flow.main.test.mjs`(新增一例)

- [ ] **Step 1: 写失败测试**

在 `test/flow.main.test.mjs` 复用该文件已有的 happy-path fixture flow(同文件里成功跑通的那个 flow 名 + `openBackend`/`workflowsRoot`),新增:

```js
test("main() 注入 progress 时,flow 事件汇入注入的 sink(不再只走 stdout)", async () => {
  const events = [];
  const sink = { emit(ev) { events.push(ev); } };
  const code = await main({
    argv: [/* 复用本文件 happy-path 用例的 flow 名 */],
    input: /* 同上 */,
    progress: sink,
    openBackend: /* 复用本文件的 fakeOpenBackend */,
    workflowsRoot: /* 复用本文件的 fixtures 根 */,
    stdout: { write() {} }, stderr: { write() {} },
    fs: { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} },
  });
  assert.strictEqual(code, 0);
  assert.ok(events.some((e) => e.type === "delta" || e.type === "start" || e.type === "opening"),
    "注入的 sink 应收到至少一个 progress 事件");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.main.test.mjs`
Expected: 新例 FAIL(`events` 为空——`main()` 当前忽略注入的 `progress`,自建 sink 只写 stdout)。

- [ ] **Step 3: 改 `main()`**

在 `src/flow.mjs` 的 `main({...})` 解构入参里新增 `progress: injectedProgress`(放在 `io: injectedIo` 附近):

```js
  io: injectedIo,
  signal: externalSignal,
  progress: injectedProgress,   // TUI 注入:结构化进度事件汇(替代默认的 stdout 文本 reporter)
```

把 `flow.mjs:348` 的 `progressSink` 计算改为优先用注入的:

```js
  const progressSink = injectedProgress ?? (view ? view.countingSink(baseSink) : baseSink);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/flow.main.test.mjs`
Expected: 全 PASS(含新例;原有用例不回归——不传 `progress` 时行为不变)。

- [ ] **Step 5: 提交**

```bash
git add src/flow.mjs test/flow.main.test.mjs
git commit -m "feat(flow): main() 接受可注入 progress 事件汇(flow-in-TUI 接缝)"
```

---

## Task 2: `store.mjs` flow 伪会话模型 + 方法

**Files:**
- Modify: `src/ui/tui/store.mjs`
- Test: `test/ui/tui/store.flow.test.mjs`(新建)

- [ ] **Step 1: 写失败测试**

`test/ui/tui/store.flow.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert";
import { createStore } from "../../../src/ui/tui/store.mjs";

const L = "⑂planner#f1";

test("attachFlowAgent 建只读 flow 卡,进 sessions+order,默认焦点", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: "m" });
  const s = store.getState().sessions[L];
  assert.strictEqual(s.kind, "flow");
  assert.strictEqual(s.flowId, "f1");
  assert.strictEqual(s.agent, "planner");
  assert.strictEqual(s.status, "running");
  assert.ok(store.getState().order.includes(L));
  assert.strictEqual(store.getState().focusLabel, L);
});

test("appendFlowDelta 追加到末条 assistant(打字机式),缺卡则 no-op", () => {
  const store = createStore();
  store.appendFlowDelta("无此卡", "x");   // 不抛
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.appendFlowDelta(L, "hel"); store.appendFlowDelta(L, "lo");
  const ent = store.getState().sessions[L].entries;
  assert.strictEqual(ent.length, 1);
  assert.strictEqual(ent[0].type, "assistant");
  assert.strictEqual(ent[0].text, "hello");
});

test("setFlowQuestion 置 pendingQuestion+awaiting+approve 条;firstAwaiting 选中它", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.setFlowQuestion(L, "接受 diff?");
  const s = store.getState().sessions[L];
  assert.strictEqual(s.pendingQuestion, "接受 diff?");
  assert.strictEqual(s.status, "awaiting");
  assert.ok(s.entries.some((e) => e.type === "approve" && e.text === "接受 diff?"));
  assert.strictEqual(store.firstAwaiting(), L);
});

test("resolveFlowQuestion 清 pendingQuestion 回 running", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.setFlowQuestion(L, "q");
  store.resolveFlowQuestion(L);
  const s = store.getState().sessions[L];
  assert.strictEqual(s.pendingQuestion, null);
  assert.strictEqual(s.status, "running");
});

test("endFlow 标 done/failed + 系统消息;dropFlow 撤掉该 flow 全部卡并修焦点", () => {
  const store = createStore();
  store.attachFlowAgent("⑂a#f1", { flowId: "f1", agent: "a", model: null });
  store.attachFlowAgent("⑂b#f1", { flowId: "f1", agent: "b", model: null });
  store.endFlow("f1", { ok: true, summary: "flow done" });
  assert.strictEqual(store.getState().sessions["⑂a#f1"].status, "done");
  assert.ok(store.getState().system.includes("flow done"));
  store.dropFlow("f1");
  assert.strictEqual(store.getState().sessions["⑂a#f1"], undefined);
  assert.ok(!store.getState().order.some((l) => l.endsWith("#f1")));
  assert.strictEqual(store.getState().focusLabel, null);
});

test("appendFlowOutput 追加 output 条(approve 正文/diff 可见)", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.appendFlowOutput(L, "diff --git ...");
  assert.ok(store.getState().sessions[L].entries.some((e) => e.type === "output" && /diff/.test(e.text)));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/store.flow.test.mjs`
Expected: FAIL（`store.attachFlowAgent is not a function`）。

- [ ] **Step 3: 实现 store 方法**

在 `src/ui/tui/store.mjs` 的 `createStore()` 内、`return {…}` 之前加 `ensureFlow`,并在返回对象里加方法(放在 `dropSession` 附近):

```js
  // ── flow 伪会话:无真 session/适配器,由 flow-tui 的 progress/io 投影驱动 ──
  function ensureFlow(label, { flowId, agent, model }) {
    let s = state.sessions[label];
    if (!s) {
      s = state.sessions[label] = {
        kind: "flow", flowId, agent: agent ?? "", model: model ?? null, effort: null,
        status: "running", isStreaming: true, turn: 0,
        assistantText: "", lastLine: "", turnStartAt: null, ms: null,
        entries: [], _newAsst: false, pendingQuestion: null,
      };
      state.order.push(label);
      if (!state.focusLabel) state.focusLabel = label;
    }
    return s;
  }
```

返回对象新增:

```js
    attachFlowAgent(label, meta) { ensureFlow(label, meta); notify(); },
    appendFlowDelta(label, text) {
      const s = state.sessions[label]; if (!s) return;
      s.isStreaming = true;
      const last = s.entries[s.entries.length - 1];
      if (last && last.type === "assistant") last.text += text;
      else s.entries.push({ type: "assistant", text });
      trimEntries(s); notify();
    },
    appendFlowOutput(label, text) {
      const s = state.sessions[label]; if (!s) return;
      s.entries.push({ type: "output", text: String(text) }); trimEntries(s); notify();
    },
    setFlowAgentStatus(label, status) {
      const s = state.sessions[label]; if (!s) return;
      s.status = status; if (status === "done" || status === "failed") s.isStreaming = false; notify();
    },
    setFlowQuestion(label, prompt) {
      const s = state.sessions[label]; if (!s) return;
      s.pendingQuestion = prompt; s.status = "awaiting";
      s.entries.push({ type: "approve", text: prompt }); trimEntries(s); notify();
    },
    resolveFlowQuestion(label) {
      const s = state.sessions[label]; if (!s) return;
      s.pendingQuestion = null; if (s.status === "awaiting") s.status = "running"; notify();
    },
    endFlow(flowId, { ok = true, summary = null } = {}) {
      for (const l of state.order) {
        const s = state.sessions[l];
        if (s && s.kind === "flow" && s.flowId === flowId) {
          s.status = ok ? "done" : "failed"; s.isStreaming = false; s.pendingQuestion = null;
        }
      }
      if (summary) { state.system.push(summary); trimSystem(); }
      notify();
    },
    dropFlow(flowId) {
      const drop = state.order.filter((l) => { const s = state.sessions[l]; return s && s.kind === "flow" && s.flowId === flowId; });
      for (const l of drop) delete state.sessions[l];
      state.order = state.order.filter((l) => !drop.includes(l));
      if (drop.includes(state.focusLabel)) state.focusLabel = state.order[state.order.length - 1] ?? null;
      notify();
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/store.flow.test.mjs`
Expected: 全 PASS。再跑 `node --test --test-isolation=none test/ui/tui/*.test.mjs` 确认既有 store 测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/store.mjs test/ui/tui/store.flow.test.mjs
git commit -m "feat(tui): store flow 伪会话模型 + 驱动方法(attach/delta/question/end/drop)"
```

---

## Task 3: `flow-tui.mjs` 驱动核心

**Files:**
- Create: `src/ui/tui/flow-tui.mjs`
- Test: `test/ui/tui/flow-tui.test.mjs`(新建)

注:`createFlowTui` 接受可注入 `flowMain`,单测传假实现(不跑真引擎)。

- [ ] **Step 1: 写失败测试**

`test/ui/tui/flow-tui.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { createFlowTui } from "../../../src/ui/tui/flow-tui.mjs";

function mk(flowMain) {
  const store = createStore();
  const ft = createFlowTui({ store, openBackend: () => {}, workflowsRoot: "/x", cwd: "/x", config: {}, flowMain, dropDelayMs: 5 });
  return { store, ft };
}

test("runFlow:progress 事件投影成 flow 卡 + 流式;结束后 endFlow", async () => {
  let captured;
  const flowMain = async ({ progress }) => { captured = progress; progress.emit({ type: "opening", agent: "planner", model: "m" }); progress.emit({ type: "delta", agent: "planner", model: "m", text: "hi" }); return 0; };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["demo"]);
  const labels = store.getState().order;
  const fl = labels.find((l) => l.startsWith("⑂planner"));
  assert.ok(fl, "应有 ⑂planner 卡");
  assert.strictEqual(store.getState().sessions[fl].entries.find((e) => e.type === "assistant").text, "hi");
  assert.strictEqual(store.getState().sessions[fl].status, "done");
});

test("io.question:置 awaiting,answer() 即 resolve 引擎 Promise", async () => {
  let resolved = null;
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "review", model: null });
    const ans = await io.question("接受?", {});
    resolved = ans;
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["demo"]);
  await new Promise((r) => setTimeout(r, 10));   // 让 flowMain 跑到 question
  const fl = store.getState().order.find((l) => l.startsWith("⑂review"));
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, "接受?");
  assert.strictEqual(store.getState().sessions[fl].status, "awaiting");
  assert.strictEqual(ft.answer(fl, "y"), true);
  await p;
  assert.strictEqual(resolved, "y");
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, null);
});

test("abortAll:拒绝待答问题,引擎据 signal 收口", async () => {
  let rejected = false;
  const flowMain = async ({ progress, io, signal }) => {
    progress.emit({ type: "start", agent: "review", model: null });
    try { await io.question("接受?", { signal }); } catch { rejected = true; }
    return 1;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["demo"]);
  await new Promise((r) => setTimeout(r, 10));
  ft.abortAll();
  await p;
  assert.strictEqual(rejected, true);
});

test("flowStatus:运行中计数,空闲 none", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const flowMain = async () => { await gate; return 0; };
  const { ft } = mk(flowMain);
  const p = ft.runFlow(["demo"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(ft.flowStatus(), /running/);
  release(); await p;
  assert.strictEqual(ft.flowStatus(), "none");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/flow-tui.test.mjs`
Expected: FAIL（模块不存在 / `createFlowTui` 未导出）。

- [ ] **Step 3: 实现 `flow-tui.mjs`**

```js
// src/ui/tui/flow-tui.mjs — 把 flow 引擎运行投影进 TUI store(只读会话卡 + approve 经输入框作答)。
// 不碰真 stdout(全屏 alt-screen):flow 的 progress/io/signal 三个注入接缝在此装配。
import { main as realFlowMain } from "../../flow.mjs";

const DROP_DELAY_MS = 3000;
const shortAgent = (label) => label.replace(/^⑂/, "").replace(/#.*$/, "").replace(/:.*$/, "");

export function createFlowTui({ store, openBackend, workflowsRoot, cwd, config, env = process.env, flowMain = realFlowMain, dropDelayMs = DROP_DELAY_MS }) {
  let _seq = 0;
  const activeFlows = new Map();   // flowId → { ctrl }
  const pending = new Map();       // label → { resolve, reject, flowId }

  const keyOf = (flowId, agent, model) => `⑂${agent}${model ? ":" + model : ""}#${flowId}`;

  function makeSink(flowId) {
    let last = null;   // { label, agent, model }
    return {
      last: () => last,
      emit(ev) {
        if (!ev) return;
        const agent = ev.agent ?? String(flowId);
        const label = keyOf(flowId, agent, ev.model);
        last = { label, agent, model: ev.model ?? null };
        if (ev.type === "opening" || ev.type === "start") {
          store.attachFlowAgent(label, { flowId, agent, model: ev.model ?? null });
        } else if (ev.type === "delta" && ev.text) {
          store.attachFlowAgent(label, { flowId, agent, model: ev.model ?? null });
          store.appendFlowDelta(label, ev.text);
        }
      },
    };
  }

  function makeIo(flowId, sink, flowName) {
    const targetLabel = () => (sink.last()?.label) || keyOf(flowId, flowName, null);
    const cap = (s) => { const l = targetLabel(); store.appendFlowOutput(l, String(s)); return true; };
    return {
      stdout: { write: cap }, stderr: { write: cap }, stdin: {},
      question(prompt, { signal } = {}) {
        const label = targetLabel();
        store.attachFlowAgent(label, { flowId, agent: shortAgent(label), model: null });
        store.setFlowQuestion(label, prompt);
        return new Promise((resolve, reject) => {
          pending.set(label, { resolve, reject, flowId });
          const onAbort = () => { if (pending.delete(label)) reject(new Error("flow aborted")); };
          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      },
    };
  }

  function start(argv, extra = {}) {
    const flowId = `f${++_seq}`;
    const flowName = argv[0] || flowId;
    const ctrl = new AbortController();
    const sink = makeSink(flowId);
    const io = makeIo(flowId, sink, flowName);
    activeFlows.set(flowId, { ctrl });
    const p = Promise.resolve()
      .then(() => flowMain({
        argv, progress: sink, io, signal: ctrl.signal,
        stdout: io.stdout, stderr: io.stderr,
        openBackend, workflowsRoot, cwd, config, env, ...extra,
      }))
      .then((code) => { store.endFlow(flowId, { ok: code === 0, summary: `flow ${flowName} 结束(exit ${code})` }); return code; })
      .catch((err) => { store.endFlow(flowId, { ok: false, summary: `flow ${flowName} 出错: ${err?.message ?? err}` }); return 1; })
      .finally(() => {
        activeFlows.delete(flowId);
        for (const [label, pr] of [...pending]) if (pr.flowId === flowId) { pending.delete(label); pr.reject(new Error("flow ended")); }
        setTimeout(() => store.dropFlow(flowId), dropDelayMs).unref?.();
      });
    return p;
  }

  return {
    runFlow: (argv) => start(argv),
    flowStatus: () => (activeFlows.size > 0 ? `${activeFlows.size} running` : "none"),
    abortAll: () => { for (const { ctrl } of activeFlows.values()) ctrl.abort(); },
    answer(label, line) {
      const pr = pending.get(label);
      if (!pr) return false;
      pending.delete(label);
      store.resolveFlowQuestion(label);
      pr.resolve(line);
      return true;
    },
    // resumeFlow / handleHumanLine 在 Task 4 加入
    _start: start,   // 供 resumeFlow 复用(Task 4)
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/flow-tui.test.mjs`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/flow-tui.mjs test/ui/tui/flow-tui.test.mjs
git commit -m "feat(tui): flow-tui 驱动核心(progress 投影 + io.question 作答 + abort)"
```

---

## Task 4: flow-tui 输入路由 + resumeFlow

**Files:**
- Modify: `src/ui/tui/flow-tui.mjs`
- Test: `test/ui/tui/flow-tui.test.mjs`(追加)

- [ ] **Step 1: 写失败测试**

追加:

```js
test("handleHumanLine:flow 会话有待答 → 作答并吞掉;无待答 → 系统消息拒绝;非 flow → 不处理", async () => {
  const flowMain = async ({ progress, io }) => { progress.emit({ type: "start", agent: "review", model: null }); await io.question("?", {}); return 0; };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["demo"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂review"));
  // 有待答 → 作答
  assert.strictEqual(ft.handleHumanLine(fl, "y"), true);
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, null);
  await p;
  // 非 flow 会话(不存在/普通)→ 不处理
  assert.strictEqual(ft.handleHumanLine("omp#1", "hi"), false);
});

test("handleHumanLine:flow 会话无待答 → 拒绝(系统消息),不处理给后端", () => {
  const { store, ft } = mk(async () => 0);
  store.attachFlowAgent("⑂x#f9", { flowId: "f9", agent: "x", model: null });
  const before = store.getState().system.length;
  assert.strictEqual(ft.handleHumanLine("⑂x#f9", "hi"), true);
  assert.ok(store.getState().system.length > before);
});
```

(resumeFlow 走真引擎,留给 Task 6 的 cli 集成 + 手动验证;此处不单测。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/flow-tui.test.mjs`
Expected: 新例 FAIL（`ft.handleHumanLine is not a function`）。

- [ ] **Step 3: 实现 `handleHumanLine` + `resumeFlow`**

在 `flow-tui.mjs` 顶部加 import:

```js
import path from "node:path";
import os from "node:os";
import { prepareResume } from "./../../flow/resume.mjs";   // 路径以仓库实际为准(见 cli.mjs:619-637 的 import)
```

> 实现者注:`prepareResume` 的确切模块路径照搬 `cli.mjs` 顶部该函数的 import(本计划不假设路径)。

返回对象里把占位 `_start` 删掉,新增:

```js
    resumeFlow: async (runId) => {
      const runsRoot = path.resolve(env.SYNOD_HOME || os.homedir(), ".synod", "runs");
      let r;
      try { r = await prepareResume(runsRoot, runId); }
      catch (err) { store.pushSystem(`/resume: ${err.message}`); return; }
      return start([r.flowName], { resume: { runId: r.runId, input: r.input, steps: r.steps }, cwd: r.cwd, runsRoot });
    },
    handleHumanLine(label, line) {
      const s = store.getState().sessions[label];
      if (!s || s.kind !== "flow") return false;     // 非 flow → 交回普通 dispatch
      if (s.pendingQuestion != null) { this.answer(label, line); return true; }
      store.pushSystem("⑂ 这是 flow 会话,不能直接发消息(只能在它请求确认时作答)");
      return true;
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/flow-tui.test.mjs`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/flow-tui.mjs test/ui/tui/flow-tui.test.mjs
git commit -m "feat(tui): flow-tui 输入路由(只读寻址 + 作答)+ resumeFlow"
```

---

## Task 5: 组件渲染(AgentRail / FocusPane / InputBar)

**Files:**
- Modify: `src/ui/tui/components/AgentRail.mjs`、`FocusPane.mjs`、`InputBar.mjs`
- Test: `test/ui/tui/focuspane.flow.test.mjs`(新建,用 `ink-testing-library`)

- [ ] **Step 1: 写失败测试**

`test/ui/tui/focuspane.flow.test.mjs`(参照既有组件测试的 render 写法):

```js
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";

test("FocusPane:flow 会话头部带 ⑂,output/approve 条目可渲染", () => {
  const sess = {
    kind: "flow", agent: "planner", model: "m", status: "awaiting", turn: 0,
    pendingQuestion: "接受 diff?",
    entries: [{ type: "assistant", text: "分析中" }, { type: "output", text: "diff xyz" }, { type: "approve", text: "接受 diff?" }],
  };
  const { lastFrame } = render(html`<${FocusPane} label="⑂planner:m#f1" sess=${sess} selectedIndex=${-1} />`);
  const f = lastFrame();
  assert.match(f, /⑂planner/);     // 头部显示名而非裸 label
  assert.match(f, /diff xyz/);      // output 条
  assert.match(f, /接受 diff/);     // approve 条
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/focuspane.flow.test.mjs`
Expected: FAIL（output/approve 未渲染或头部裸 label）。

- [ ] **Step 3: 改三个组件**

`FocusPane.mjs` —— 头部显示名 + 新条目类型。把头部 `${label}` 改为:

```js
  const display = sess.kind === "flow" ? `⑂${sess.agent}` : label;
```
头部里用 `${display}` 替换 `${label}`。在 entries 的 `.map` 链里、`assistant` 默认分支之前补两类:

```js
        if (e.type === "output") return html`<${Text} key=${i} color=${theme.dim} wrap="truncate-end">${e.text}<//>`;
        if (e.type === "approve") return html`<${Text} key=${i} color=${theme.warn} bold>↳ ${e.text} · 在下面作答<//>`;
```

`AgentRail.mjs` —— flow 显示名 + done/failed 态。在 `.map` 内 `const sel = …` 之后:

```js
      const name = s.kind === "flow" ? `⑂${s.agent}` : label;
      const dotColor = s.status === "running" ? theme.accent : s.status === "awaiting" ? theme.warn : s.status === "failed" ? theme.warn : theme.ok;
      const dot = s.status === "running" ? "●" : s.status === "failed" ? "✗" : "✓";
      const statusText = s.status === "running" ? `running${s.ms ? ` · ${(s.ms / 1000).toFixed(1)}s` : ""}`
        : s.status === "awaiting" ? "待你" : s.status === "failed" ? "failed" : s.status === "done" ? "done" : "idle";
      const statusColor = s.status === "running" ? theme.accent : s.status === "awaiting" || s.status === "failed" ? theme.warn : theme.ok;
```
把第 19 行的 `${label}  t${s.turn}` 改为 `${name}  t${s.turn}`。

`InputBar.mjs` —— 待答 flow 焦点时改提示。给 `InputBar` 加入参 `approve`(布尔),把提示符行改为:

```js
      <${Text} color=${theme.accent} bold>[${focusLabel || "—"}] ${approve ? "approve" : ""} ❯ <//><${Text} color=${theme.text}>${value}▌<//>
```
并在 `app.mjs` 渲染处计算并传:`const fa = st.sessions[st.focusLabel]; const approve = !!(fa && fa.kind === "flow" && fa.pendingQuestion);` 传 `approve=${approve}` 给 `InputBar`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/focuspane.flow.test.mjs`
Expected: PASS。再跑 `node --test --test-isolation=none test/ui/tui/*.test.mjs` 确认既有组件/快照测试不回归(若有断言整帧文本的用例随之更新)。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/components/ test/ui/tui/focuspane.flow.test.mjs src/ui/tui/app.mjs
git commit -m "feat(tui): flow 卡渲染(⑂ 显示名 + output/approve 条 + 输入框 approve 提示)"
```

---

## Task 6: `cli.mjs` 接线(最高优先回归点:syncFocus 收窄)

**Files:**
- Modify: `src/cli.mjs`(TUI 分支:`cli.mjs:440-478` 一带 + `onInterrupt` `cli.mjs:497`)

无新单测(纯集成接线);验证 = `node --check` + 既有 cli 门禁不回归 + Task 7 冒烟端到端。

- [ ] **Step 1: 接 flow-tui 并补 dispatchTui 参数**

在 TUI 分支构造 `dispatchTui`(`cli.mjs:451`)之前加:

```js
    const { createFlowTui } = await import("./ui/tui/flow-tui.mjs");
    const flowTui = createFlowTui({ store, openBackend, workflowsRoot: flowsRootTui, cwd, config, env });
```

把 `dispatchTui = createReplDispatch({…})` 补上三参,并删掉写死的 `flowStatus: () => "none"`:

```js
    const dispatchTui = createReplDispatch({
      sm: smTui, registry, stdout: cap, stderr: cap, defaultAgent: args.agent,
      guardrails: { maxSessions: 10, maxDepth: 3, allowWrite: false }, config,
      runFlow: flowTui.runFlow, resumeFlow: flowTui.resumeFlow, flowStatus: flowTui.flowStatus,
      onCloseLabel: (label) => _dropDepthTui(label),
    });
```

- [ ] **Step 2: dispatchWrapped 先走 flow 路由**

在 `dispatchWrapped`(`cli.mjs:470`)开头,纯文本 human 行先问 flow-tui:

```js
    const dispatchWrapped = (line, opts) => {
      const source = opts?.source ?? "human";
      const label = smTui.currentLabel;
      // flow 会话:只读寻址——有待答则作答、无待答则拒绝,均不进普通 dispatch。
      if (source === "human" && label && !/^[/@$]/.test(line) && flowTui.handleHumanLine(label, line)) {
        syncFocus(); return { redraw: true };
      }
      const r = dispatchTui(line, opts);
      if (source === "human" && label && !/^[/@$]/.test(line) && r?.redraw === false) store.pushUser(label, line);
      Promise.resolve(r).finally?.(syncFocus); syncFocus(); return r;
    };
```

- [ ] **Step 3: syncFocus 收窄(关键回归点)**

`syncFocus`(`cli.mjs:467`)当前会把所有不在 `smTui._sessions` 的 label 从 store 撤掉——flow 卡正好不在 smTui 里,会被误撤。改为只撤「非 flow」的孤儿:

```js
    const syncFocus = () => {
      store.setFocus(smTui.currentLabel);
      for (const l of store.getState().order) {
        const s = store.getState().sessions[l];
        if (s && s.kind === "flow") continue;        // flow 卡由 flow-tui 自己 endFlow/dropFlow 管理
        if (!smTui._sessions.has(l)) store.dropSession(l);
      }
    };
```

> 注意:`setFocus(smTui.currentLabel)` 会把焦点拉回 smTui 当前会话。若希望「Ctrl-G 跳到 flow 卡后焦点稳住」,需确认 dispatch 后 `syncFocus` 不把焦点从 flow 卡抢走——flow 卡不在 smTui,`smTui.currentLabel` 仍是真会话,故 `setFocus` 会切走。**对策**:`onSelect`(`cli.mjs:468`)跳 flow 卡时不依赖 smTui;`syncFocus` 仅在「当前焦点是真会话」时才 `setFocus`。把 `setFocus` 行改为:
```js
      const fl = store.getState().focusLabel;
      const fs = store.getState().sessions[fl];
      if (!fs || fs.kind !== "flow") store.setFocus(smTui.currentLabel);
```

- [ ] **Step 4: onInterrupt 接 flow abort**

`onInterrupt`(`cli.mjs:497`)第一次打断(非退出分支)里,abort 各 session 之后加:

```js
      try { flowTui.abortAll(); } catch {}
```

- [ ] **Step 5: 验证**

Run: `node --check src/cli.mjs`
Run: `node --test test/cli.tui-gate.test.mjs test/cli.integration.test.mjs`(各自隔离进程,确认 cli 不回归)
Expected: 语法 OK;cli 门禁全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/cli.mjs
git commit -m "feat(cli): TUI 接 flow-tui(/flow 可用)+ onInterrupt abortAll + syncFocus 收窄不误撤 flow 卡"
```

---

## Task 7: 冒烟扩展(端到端)

**Files:**
- Modify: `scripts/smoke-tui.mjs`

冒烟自己装配 flow-tui(注入假 flowMain),经真 startTui/store/render 走通「卡片→approve→作答→完成」。

- [ ] **Step 1: 加 flow 段**

在 `scripts/smoke-tui.mjs` 顶部 import `createFlowTui`;在现有断言之后、teardown 之前加一段:

```js
  // 8) flow-in-TUI:假 flowMain 驱动 sink + 一次 io.question,经真 store/render 走通。
  const { createFlowTui } = await import("../src/ui/tui/flow-tui.mjs");
  let _ans = null;
  const fakeFlowMain = async ({ progress, io }) => {
    progress.emit({ type: "opening", agent: "planner", model: "m" });
    progress.emit({ type: "delta", agent: "planner", model: "m", text: "分析需求…" });
    _ans = await io.question("接受 diff?", {});
    return 0;
  };
  const flowTui = createFlowTui({ store, openBackend: () => {}, workflowsRoot: ".", cwd: ".", config: {}, flowMain: fakeFlowMain, dropDelayMs: 50 });
  const fp = flowTui.runFlow(["demo"]);
  await sleep(60);
  ok("flow:⑂planner 卡冒出且流式", /⑂planner/.test(stdout.text()) && stdout.text().includes("分析需求"));
  const flowLabel = store.getState().order.find((l) => l.startsWith("⑂planner"));
  ok("flow:approve 门置 awaiting + pendingQuestion", store.getState().sessions[flowLabel].pendingQuestion === "接受 diff?");
  ok("flow:状态栏出现 flow 计数", /1 running|1 flow/.test(stdout.text()) || flowTui.flowStatus().includes("running"));
  // 作答(直接走 flow-tui;真 app 经 dispatchWrapped.handleHumanLine,这里等价驱动)
  flowTui.handleHumanLine(flowLabel, "y");
  await fp;
  ok("flow:作答后 resolve + pendingQuestion 清空", _ans === "y" && store.getState().sessions[flowLabel].pendingQuestion === null);
  await sleep(80);   // 等 dropFlow
  ok("flow:结束后卡片撤除 + 结果进系统消息", !store.getState().order.includes(flowLabel) && store.getState().system.some((m) => /flow demo 结束/.test(m)));
```

- [ ] **Step 2: 跑冒烟**

Run: `node scripts/smoke-tui.mjs`
Expected: 全部 checks PASS（含新增 5 条 flow 检查),退出 0。

- [ ] **Step 3: 提交**

```bash
git add scripts/smoke-tui.mjs
git commit -m "test(tui): 冒烟覆盖 flow-in-TUI 端到端(卡片→approve→作答→完成→撤卡)"
```

---

## 收尾(全部 task 后)

- [ ] 跑全套 TUI 门禁:`node --test --test-isolation=none test/ui/tui/*.test.mjs` + `node scripts/smoke-tui.mjs` 全绿。
- [ ] flow 既有套件单文件隔离不回归:`node --test test/flow.main.test.mjs test/flow.run.test.mjs`。
- [ ] 人工真终端冒烟:`node src/cli.mjs` → `/flow <真实flow>` → 看 ⑂ 卡、approve、作答、完成;`/flow` 不带名 → `--list`;`Ctrl-C` 中断在跑 flow。
- [ ] 派最终 code-reviewer 过整条改动。
- [ ] 用 superpowers:finishing-a-development-branch 收尾分支。

---

## 自查(写计划后)

**spec 覆盖:** §6.1→T1;§6.3→T2;§6.2 sink/io/run/abort→T3,routing/resume→T4;§6.6 渲染→T5;§6.4 接线 + §9 syncFocus 回归→T6;§10 冒烟→T7。approve 经 `io.question`、Ctrl-G 复用 `firstAwaiting`、只读寻址均落到具体 task。覆盖完整。

**占位扫描:** 仅两处显式「以仓库实际为准」——`prepareResume` 的 import 路径(T4)与 `flow.main.test.mjs` 的 fixture 名(T1),均为「照搬现有同名 import / 同文件既有用例」的可定位指令,非 TODO。

**类型一致:** store 方法名(attachFlowAgent/appendFlowDelta/appendFlowOutput/setFlowAgentStatus/setFlowQuestion/resolveFlowQuestion/endFlow/dropFlow)、flow-tui 出口(runFlow/resumeFlow/flowStatus/abortAll/answer/handleHumanLine)、flow 卡字段(kind/flowId/pendingQuestion)、引擎入参 `progress` 跨 T1–T7 一致。

**已知风险(spec §13):** `io.question` 归属卡(取 `sink.last()`,无则用 `⑂<flowName>` 主控卡)已在 T3 makeIo 兜底;`syncFocus` 误撤 + 焦点抢回已在 T6 Step 3 双重处理。

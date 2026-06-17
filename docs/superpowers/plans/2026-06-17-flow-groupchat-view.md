# flow 群聊视图 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每个 task 一个 fresh 子 agent + spec 审 + 质量审。步骤用 `- [ ]`。

**Goal:** 把 flow-in-TUI 的渲染模型从"每个内部 agent 一张并列会话卡"改成"一个 flow 一张群聊卡":rail 只占一行,切进去是独立群聊页,所有 agent 按发言人在同一条时间线里显示。

**Architecture:** 底层已有 `flowId` 作分组键。把 store 的"每 (agent,flowId) 一卡"收成"每 flowId 一卡",条目带 `agent` 发言人字段;flow-tui 投影到唯一 label `⑂<flowName>#<flowId>`;FocusPane/AgentRail 加 `kind:"flow"` 群聊分支。`cli.mjs`/`app.mjs`/`InputBar` 不改(焦点路由按 `kind:"flow"`,approve 判定 `pendingQuestion` 仍真值)。

**Tech Stack:** Ink ^6 + htm(`html\`…\``)、node:test、ink-testing-library。设计依据见 `docs/superpowers/specs/2026-06-17-flow-groupchat-view-design.md`。

**测试节奏:** TUI 套件单进程:`node --test --test-isolation=none test/ui/tui/*.test.mjs`(项目惯例)。每个 task 跑自己 scoped 的测试文件;全套件在 Task 3 收尾后转绿;smoke 在 Task 4。ink-testing-library 渲染无色,断言用文本子串。

---

## Task 1: store —— 收成每 flowId 一张群聊卡

**Files:**
- Modify: `src/ui/tui/store.mjs`(替换 `ensureFlow` 与 8 个 flow 方法)
- Test: `test/ui/tui/store.flow.test.mjs`(整体改写)

- [ ] **Step 1: 改写测试**(覆盖新 API)

替换 `test/ui/tui/store.flow.test.mjs` 全文为:

```js
import { test } from "node:test";
import assert from "node:assert";
import { createStore } from "../../../src/ui/tui/store.mjs";

const L = "⑂研发流#f1";

test("attachFlow 建唯一只读 flow 卡(kind/flowName/默认聚焦)", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  const s = store.getState().sessions[L];
  assert.strictEqual(s.kind, "flow");
  assert.strictEqual(s.flowId, "f1");
  assert.strictEqual(s.flowName, "研发流");
  assert.strictEqual(s.status, "running");
  assert.deepStrictEqual(s.agents, []);
  assert.ok(store.getState().order.includes(L));
  assert.strictEqual(store.getState().focusLabel, L);
});

test("appendFlowDelta:同发言人累加一段,切换另起一段;登记花名册;缺卡 no-op", () => {
  const store = createStore();
  store.appendFlowDelta("无此卡", "x", "y");   // 不抛
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.appendFlowDelta(L, "planner", "拆"); store.appendFlowDelta(L, "planner", "解");
  store.appendFlowDelta(L, "coder", "写码");
  const ent = store.getState().sessions[L].entries;
  assert.strictEqual(ent.length, 2);
  assert.deepStrictEqual([ent[0].type, ent[0].agent, ent[0].text], ["assistant", "planner", "拆解"]);
  assert.deepStrictEqual([ent[1].type, ent[1].agent, ent[1].text], ["assistant", "coder", "写码"]);
  assert.deepStrictEqual(store.getState().sessions[L].agents, ["planner", "coder"]);
  assert.strictEqual(store.getState().sessions[L].lastLine, "拆解写码");
});

test("noteFlowAgent 幂等登记参与者", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.noteFlowAgent(L, "planner"); store.noteFlowAgent(L, "planner"); store.noteFlowAgent(L, "review");
  assert.deepStrictEqual(store.getState().sessions[L].agents, ["planner", "review"]);
});

test("setFlowQuestion:pendingQuestion 为 {agent,prompt}+awaiting+approve 条;firstAwaiting 命中", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.setFlowQuestion(L, "review", "接受 diff?");
  const s = store.getState().sessions[L];
  assert.deepStrictEqual(s.pendingQuestion, { agent: "review", prompt: "接受 diff?" });
  assert.strictEqual(s.status, "awaiting");
  assert.ok(s.entries.some((e) => e.type === "approve" && e.agent === "review" && e.text === "接受 diff?"));
  assert.ok(s.agents.includes("review"));
  assert.strictEqual(store.firstAwaiting(), L);
});

test("resolveFlowQuestion 清 pendingQuestion 回 running", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.setFlowQuestion(L, "review", "q");
  store.resolveFlowQuestion(L);
  const s = store.getState().sessions[L];
  assert.strictEqual(s.pendingQuestion, null);
  assert.strictEqual(s.status, "running");
});

test("appendFlowOutput 追加带发言人的 output 条", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.appendFlowOutput(L, "coder", "diff --git ...");
  const e = store.getState().sessions[L].entries.find((x) => x.type === "output");
  assert.ok(e && e.agent === "coder" && /diff/.test(e.text));
  assert.ok(store.getState().sessions[L].agents.includes("coder"));
});

test("endFlow 标 done + 系统消息;dropFlow 撤该 flow 卡并修焦点", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.endFlow("f1", { ok: true, summary: "flow done" });
  assert.strictEqual(store.getState().sessions[L].status, "done");
  assert.ok(store.getState().system.includes("flow done"));
  store.dropFlow("f1");
  assert.strictEqual(store.getState().sessions[L], undefined);
  assert.ok(!store.getState().order.includes(L));
  assert.strictEqual(store.getState().focusLabel, null);
});

test("endFlow ok:false → failed + summary 进系统消息", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.endFlow("f1", { ok: false, summary: "boom" });
  assert.strictEqual(store.getState().sessions[L].status, "failed");
  assert.ok(store.getState().system.includes("boom"));
});

test("setFlowQuestion:非焦点 flow 卡 → 焦点会话流冒确认 nudge(^G 去看)", () => {
  const store = createStore();
  store.attachSession("real#1", { on() {} }, "omp", {});
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });   // 非焦点
  store.setFlowQuestion(L, "review", "接受?");
  const fe = store.getState().sessions["real#1"].entries;
  assert.ok(fe.some((e) => e.type === "nudge" && /要你确认/.test(e.text)));
});
```

- [ ] **Step 2: 跑测试看红**

Run: `node --test --test-isolation=none test/ui/tui/store.flow.test.mjs`
Expected: FAIL(`store.attachFlow is not a function` 等)

- [ ] **Step 3: 改 store**

在 `src/ui/tui/store.mjs`,把 `ensureFlow`(约 31–44 行)替换为:

```js
  // ── flow 伪会话:一个 flowId 一张群聊卡,条目带发言人(agent)字段 ──
  function ensureFlow(label, { flowId, flowName }) {
    let s = state.sessions[label];
    if (!s) {
      s = state.sessions[label] = {
        kind: "flow", flowId, flowName: flowName ?? "", agent: flowName ?? "",
        model: null, effort: null, status: "running", isStreaming: true, turn: 0,
        assistantText: "", lastLine: "", turnStartAt: null, ms: null,
        agents: [], entries: [], _newAsst: false, pendingQuestion: null,
      };
      state.order.push(label);
      if (!state.focusLabel) state.focusLabel = label;
    }
    return s;
  }
  function noteAgent(s, agent) { if (agent && !s.agents.includes(agent)) s.agents.push(agent); }
```

把现有 flow 方法块(`attachFlowAgent` 起,到 `resolveFlowQuestion` 止;`endFlow`/`dropFlow` **保留不动**)替换为:

```js
    attachFlow(label, meta) { ensureFlow(label, meta); notify(); },
    noteFlowAgent(label, agent) { const s = state.sessions[label]; if (!s) return; noteAgent(s, agent); notify(); },
    appendFlowDelta(label, agent, text) {
      const s = state.sessions[label]; if (!s) return;
      noteAgent(s, agent);
      s.isStreaming = true;
      s.assistantText += text;
      const nl = s.assistantText.lastIndexOf("\n");
      s.lastLine = nl === -1 ? s.assistantText : s.assistantText.slice(nl + 1);
      const last = s.entries[s.entries.length - 1];
      if (last && last.type === "assistant" && last.agent === agent) last.text += text;
      else s.entries.push({ type: "assistant", agent, text });
      trimEntries(s); notify();
    },
    appendFlowOutput(label, agent, text) {
      const s = state.sessions[label]; if (!s) return;
      noteAgent(s, agent);
      s.entries.push({ type: "output", agent, text: String(text) }); trimEntries(s); notify();
    },
    setFlowQuestion(label, agent, prompt) {
      const s = state.sessions[label]; if (!s) return;
      noteAgent(s, agent);
      s.pendingQuestion = { agent, prompt }; s.status = "awaiting";
      s.entries.push({ type: "approve", agent, text: prompt }); trimEntries(s);
      pushNudgeToFocus(label, "要你确认");   // 非焦点时,焦点流冒「… 要你确认 · ^G 去看」(A 通道)
      notify();
    },
    resolveFlowQuestion(label) {
      const s = state.sessions[label]; if (!s) return;
      s.pendingQuestion = null; if (s.status === "awaiting") s.status = "running"; notify();
    },
```

注意:旧 `attachFlowAgent` 与 `setFlowAgentStatus` 删除(后者本无调用方)。`endFlow`/`dropFlow` 不动(已按 `flowId` 工作)。

- [ ] **Step 4: 跑测试看绿**

Run: `node --test --test-isolation=none test/ui/tui/store.flow.test.mjs`
Expected: PASS(全部)

旁注:此刻 `flow-tui.test.mjs`/`focuspane.flow.test.mjs`/smoke 仍红(用旧 API),分别在 Task 2/3/4 转绿——本 task 只跑上面这一个文件。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/store.mjs test/ui/tui/store.flow.test.mjs
git commit -m "refactor(tui): flow store 收成每 flowId 一张群聊卡(条目带发言人)"
```

---

## Task 2: flow-tui —— 投影到唯一 ⑂<flowName> 卡

**Files:**
- Modify: `src/ui/tui/flow-tui.mjs`(整体替换)
- Test: `test/ui/tui/flow-tui.test.mjs`(整体改写)

- [ ] **Step 1: 改写测试**

替换 `test/ui/tui/flow-tui.test.mjs` 全文为:

```js
import { test } from "node:test";
import assert from "node:assert";
import { getEventListeners } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { createFlowTui } from "../../../src/ui/tui/flow-tui.mjs";

function mk(flowMain) {
  const store = createStore();
  const ft = createFlowTui({ store, openBackend: () => {}, workflowsRoot: "/x", cwd: "/x", config: {}, flowMain, dropDelayMs: 5 });
  return { store, ft };
}

test("runFlow:多 agent 投影到一张 ⑂<flowName> 卡,条目按发言人归属;结束 done", async () => {
  const flowMain = async ({ progress }) => {
    progress.emit({ type: "opening", agent: "planner", model: "m" });
    progress.emit({ type: "delta", agent: "planner", model: "m", text: "拆解" });
    progress.emit({ type: "start", agent: "coder", model: "m" });
    progress.emit({ type: "delta", agent: "coder", model: "m", text: "写码" });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["研发流"]);
  const labels = store.getState().order;
  const fl = labels.find((l) => l.startsWith("⑂研发流"));
  assert.ok(fl, "应有 ⑂研发流 卡");
  assert.strictEqual(labels.filter((l) => l.startsWith("⑂")).length, 1, "只有一张 flow 卡(非每 agent 一张)");
  const s = store.getState().sessions[fl];
  assert.deepStrictEqual(s.agents, ["planner", "coder"]);
  assert.deepStrictEqual(s.entries.map((e) => [e.agent, e.text]), [["planner", "拆解"], ["coder", "写码"]]);
  assert.strictEqual(s.status, "done");
});

test("io.question:置 awaiting,pendingQuestion={agent,prompt};answer() resolve 引擎", async () => {
  let resolved = null;
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "review", model: null });
    resolved = await io.question("接受?", {});
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  assert.deepStrictEqual(store.getState().sessions[fl].pendingQuestion, { agent: "review", prompt: "接受?" });
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
  const { ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
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
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(ft.flowStatus(), /running/);
  release(); await p;
  assert.strictEqual(ft.flowStatus(), "none");
});

test("io.stdout.write 投影成带发言人的 output 条", async () => {
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "planner", model: "m" });
    io.stdout.write("行内输出");
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["研发流"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  assert.ok(store.getState().sessions[fl].entries.some((e) => e.type === "output" && e.agent === "planner" && e.text === "行内输出"));
});

test("answer 后移除 abort 监听器(同一 flow 顺序两问不泄漏)", async () => {
  let sig;
  const flowMain = async ({ progress, io, signal }) => {
    sig = signal;
    progress.emit({ type: "start", agent: "review", model: null });
    await io.question("q1", { signal });
    await io.question("q2", { signal });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 10));
  let fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  ft.answer(fl, "a1");
  await new Promise((r) => setTimeout(r, 10));
  fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  ft.answer(fl, "a2");
  await p;
  assert.strictEqual(getEventListeners(sig, "abort").length, 0, "answered 不应残留 abort 监听器");
});

test("handleHumanLine:有待答→作答并吞掉;非 flow→不处理", async () => {
  const flowMain = async ({ progress, io }) => { progress.emit({ type: "start", agent: "review", model: null }); await io.question("?", {}); return 0; };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  assert.strictEqual(ft.handleHumanLine(fl, "y"), true);
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, null);
  await p;
  assert.strictEqual(ft.handleHumanLine("omp#1", "hi"), false);
});

test("handleHumanLine:flow 会话无待答 → 拒绝(系统消息)", () => {
  const { store, ft } = mk(async () => 0);
  store.attachFlow("⑂x#f9", { flowId: "f9", flowName: "x" });
  const before = store.getState().system.length;
  assert.strictEqual(ft.handleHumanLine("⑂x#f9", "hi"), true);
  assert.ok(store.getState().system.length > before);
});

test("io.stdout.write 无对应卡(/flow --list)→ 落系统消息,不静默丢", async () => {
  const flowMain = async ({ io }) => { io.stdout.write("flow-a: 描述\nflow-b: 描述\n"); return 0; };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["--list"]);
  const sys = store.getState().system;
  assert.ok(sys.some((m) => /flow-a: 描述/.test(m)), "应有 flow-a 行");
  assert.ok(sys.some((m) => /flow-b: 描述/.test(m)), "应有 flow-b 行");
});

test("flowName 从 argv 跳过前置 flag(--progress/-- 不当成名字)", async () => {
  const { store, ft } = mk(async () => 0);
  await ft.runFlow(["--progress", "myflow"]);
  await ft.runFlow(["--progress", "--", "other", "{\"x\":1}"]);
  const sys = store.getState().system;
  assert.ok(sys.some((m) => /flow myflow 结束/.test(m)), "['--progress','myflow'] → myflow");
  assert.ok(sys.some((m) => /flow other 结束/.test(m)), "['--progress','--','other',…] → other");
  assert.ok(!sys.some((m) => /--progress/.test(m)), "摘要不出现 --progress");
});
```

- [ ] **Step 2: 跑测试看红**

Run: `node --test --test-isolation=none test/ui/tui/flow-tui.test.mjs`
Expected: FAIL(label/pendingQuestion 形状对不上)

- [ ] **Step 3: 替换 flow-tui**

替换 `src/ui/tui/flow-tui.mjs` 全文为:

```js
// src/ui/tui/flow-tui.mjs — 把 flow 引擎运行投影进 TUI store(一个 flow = 一张群聊卡 + approve 经输入框作答)。
// 不碰真 stdout(全屏 alt-screen):flow 的 progress/io/signal 三个注入接缝在此装配。
import { main as realFlowMain } from "../../flow.mjs";
import path from "node:path";
import os from "node:os";
import { prepareResume } from "../../flow/replay.mjs";

const DROP_DELAY_MS = 3000;
// argv 可能带前置 flag(repl-dispatch 给 TUI 的是 ["--progress", name] 或 ["--progress","--",name,input])。
// 取第一个非 flag(或 "--" 之后)的 token 作 flow 名——用于卡 label/结束摘要,避免取到 "--progress"。
const flowNameOf = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") return argv[i + 1] ?? null;
    if (!argv[i].startsWith("-")) return argv[i];
  }
  return null;
};

export function createFlowTui({ store, openBackend, workflowsRoot, cwd, config, env = process.env, flowMain = realFlowMain, dropDelayMs = DROP_DELAY_MS }) {
  let _seq = 0;
  const activeFlows = new Map();   // flowId → { ctrl }
  const pending = new Map();       // flow label → { resolve, reject, flowId, signal, onAbort }

  const flowLabelOf = (flowId, flowName) => `⑂${flowName}#${flowId}`;

  function makeSink(flowId, flowName) {
    const label = flowLabelOf(flowId, flowName);
    let lastAgent = null;   // 当前发言人 = 最近事件的 agent(io.question/output 归属据此)
    return {
      last: () => ({ label, agent: lastAgent }),
      emit(ev) {
        if (!ev) return;
        const agent = ev.agent ?? flowName;
        lastAgent = agent;
        if (!store.getState().sessions[label]) store.attachFlow(label, { flowId, flowName });
        if (ev.type === "delta" && ev.text) store.appendFlowDelta(label, agent, ev.text);
        else if (ev.type === "opening" || ev.type === "start") store.noteFlowAgent(label, agent);
      },
    };
  }

  function makeIo(flowId, sink, flowName) {
    const label = flowLabelOf(flowId, flowName);
    const speaker = () => sink.last()?.agent ?? flowName;
    const cap = (s) => {   // write 返回 true = 无背压
      if (store.getState().sessions[label]) store.appendFlowOutput(label, speaker(), String(s));
      else for (const ln of String(s).split("\n")) if (ln.trim()) store.pushSystem(ln);   // 无卡(如 /flow --list):落系统消息,别静默丢
      return true;
    };
    return {
      stdout: { write: cap }, stderr: { write: cap }, stdin: {},
      question(prompt, { signal } = {}) {
        if (!store.getState().sessions[label]) store.attachFlow(label, { flowId, flowName });
        store.setFlowQuestion(label, speaker(), prompt);
        return new Promise((resolve, reject) => {
          const onAbort = () => { if (pending.delete(label)) reject(new Error("flow aborted")); };
          pending.set(label, { resolve, reject, flowId, signal, onAbort });
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
    const flowName = flowNameOf(argv) || flowId;
    const ctrl = new AbortController();
    const sink = makeSink(flowId, flowName);
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
        for (const [lbl, pr] of [...pending]) if (pr.flowId === flowId) { pending.delete(lbl); pr.signal?.removeEventListener("abort", pr.onAbort); pr.reject(new Error("flow ended")); }
        setTimeout(() => store.dropFlow(flowId), dropDelayMs).unref?.();
      });
    return p;
  }

  const api = {
    runFlow: (argv) => start(argv),
    flowStatus: () => (activeFlows.size > 0 ? `${activeFlows.size} running` : "none"),
    abortAll: () => { for (const { ctrl } of activeFlows.values()) ctrl.abort(); },
    answer(label, line) {
      const pr = pending.get(label);
      if (!pr) return false;
      pending.delete(label);
      pr.signal?.removeEventListener("abort", pr.onAbort);
      store.resolveFlowQuestion(label);
      pr.resolve(line);
      return true;
    },
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
      if (s.pendingQuestion != null) { api.answer(label, line); return true; }
      store.pushSystem("⑂ 这是 flow 会话,不能直接发消息(只能在它请求确认时作答)");
      return true;
    },
  };
  return api;
}
```

- [ ] **Step 4: 跑测试看绿**

Run: `node --test --test-isolation=none test/ui/tui/flow-tui.test.mjs`
Expected: PASS(全部)

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/flow-tui.mjs test/ui/tui/flow-tui.test.mjs
git commit -m "refactor(tui): flow-tui 投影到唯一 ⑂<flowName> 群聊卡(发言人归属)"
```

---

## Task 3: FocusPane 群聊页 + AgentRail flow 行

**Files:**
- Modify: `src/ui/tui/components/FocusPane.mjs`
- Modify: `src/ui/tui/components/AgentRail.mjs`
- Test: `test/ui/tui/focuspane.flow.test.mjs`(改写)
- Test: `test/ui/tui/components.agentrail.test.mjs`(追加 flow 用例)

- [ ] **Step 1: 改写 FocusPane 测试**

替换 `test/ui/tui/focuspane.flow.test.mjs` 全文为:

```js
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";

test("FocusPane flow 群聊:头部 ⑂flowName + 花名册;裸 label 不泄漏;output/approve 渲染", () => {
  const sess = {
    kind: "flow", flowName: "研发流", agent: "研发流", model: null, status: "awaiting", turn: 0,
    agents: ["planner", "coder", "review"],
    pendingQuestion: { agent: "review", prompt: "接受 diff?" },
    entries: [
      { type: "assistant", agent: "planner", text: "分析中" },
      { type: "output", agent: "coder", text: "diff xyz" },
      { type: "approve", agent: "review", text: "接受 diff?" },
    ],
  };
  const { lastFrame } = render(html`<${FocusPane} label="flow-session-1" sess=${sess} selectedIndex=${-1} />`);
  const f = lastFrame();
  assert.match(f, /⑂研发流/);                       // 头部 flowName
  assert.doesNotMatch(f, /flow-session-1/);         // 裸 label 不泄漏到头部
  assert.match(f, /planner · coder · review/);      // 参与者花名册
  assert.match(f, /diff xyz/);                       // output 条
  assert.match(f, /↳ 接受 diff\? · 在下面作答/);    // approve 分支专属包裹
});

test("FocusPane flow 群聊:发言人分段,连续同发言人不重复头", () => {
  const sess = {
    kind: "flow", flowName: "研发流", agent: "研发流", status: "running", turn: 0,
    agents: ["planner", "coder"], pendingQuestion: null,
    entries: [
      { type: "assistant", agent: "planner", text: "AAA" },
      { type: "assistant", agent: "planner", text: "BBB" },
      { type: "assistant", agent: "coder", text: "CCC" },
    ],
  };
  const { lastFrame } = render(html`<${FocusPane} label="x" sess=${sess} />`);
  const f = lastFrame();
  // 花名册(1)+ 分段头(1)= 2;若每条都插头,planner 会出现 3 次
  assert.strictEqual((f.match(/planner/g) || []).length, 2);
  assert.strictEqual((f.match(/coder/g) || []).length, 2);
  assert.match(f, /AAA/); assert.match(f, /BBB/); assert.match(f, /CCC/);
});

test("FocusPane 非 flow 会话:头部用裸 label,不插发言人头", () => {
  const sess = {
    kind: undefined, agent: "omp", model: "m", effort: null, status: "running", turn: 1, isStreaming: false,
    entries: [{ type: "assistant", text: "你好" }],
  };
  const { lastFrame } = render(html`<${FocusPane} label="omp#1" sess=${sess} />`);
  const f = lastFrame();
  assert.match(f, /omp#1/);
  assert.match(f, /你好/);
});
```

- [ ] **Step 2: 跑测试看红**

Run: `node --test --test-isolation=none test/ui/tui/focuspane.flow.test.mjs`
Expected: FAIL(花名册/分段头未渲染)

- [ ] **Step 3: 改 FocusPane**

替换 `src/ui/tui/components/FocusPane.mjs` 全文为:

```js
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { ToolCard } from "./ToolCard.mjs";
import { theme } from "../theme.mjs";
export function FocusPane({ label, sess, selectedIndex = -1 }) {
  if (!sess) return html`<${Box} flexGrow=${1} paddingX=${1}><${Text} color=${theme.dim}>无会话。^O 新开一个。<//><//>`;
  const isFlow = sess.kind === "flow";
  const display = isFlow ? `⑂${sess.flowName}` : label;
  // flow:头部 meta = 参与者花名册;普通会话:agent · model · effort
  const meta = isFlow
    ? (sess.agents || []).join(" · ")
    : [sess.agent, sess.model || "default", sess.effort ? `effort ${sess.effort}` : null].filter(Boolean).join(" · ");
  const entries = Array.isArray(sess.entries) ? sess.entries : [];
  const lastAsstIdx = (() => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "assistant") return i; return -1; })();
  const dotColor = sess.status === "running" ? theme.accent : sess.status === "awaiting" ? theme.warn : theme.ok;
  const statusText = isFlow ? sess.status : `${sess.status} · turn ${sess.turn}${sess.ms ? ` · ${(sess.ms / 1000).toFixed(1)}s` : ""}`;
  const body = (e, i) => {
    if (e.type === "user") return html`<${Box} key=${i} alignSelf="flex-start" backgroundColor=${theme.border} paddingX=${1}><${Text} color=${theme.you} bold>❯ ${e.text}<//><//>`;
    if (e.type === "tool") return html`<${ToolCard} key=${i} entry=${e} selected=${i === selectedIndex} />`;
    if (e.type === "breadcrumb") return html`<${Text} key=${i} color=${theme.breadcrumb}>· ${e.text}<//>`;
    if (e.type === "nudge") return html`<${Text} key=${i} color=${theme.nudge}>↳ ${e.text} · ^G 去看<//>`;
    if (e.type === "output") return html`<${Text} key=${i} color=${theme.dim} wrap="truncate-end">${e.text}<//>`;
    if (e.type === "approve") return html`<${Text} key=${i} color=${theme.warn} bold>↳ ${e.text} · 在下面作答<//>`;
    return html`<${Text} key=${i} color=${theme.text}>${e.text}${(sess.isStreaming && i === lastAsstIdx) ? "▌" : ""}<//>`;
  };
  let prevAgent = null;
  // 无线条、无色块:头部一行,空一行后是对话流(flow 为群聊:发言人切换插一行暗色名)。
  return html`<${Box} flexDirection="column" flexGrow=${1} paddingX=${1}>
    <${Box}>
      <${Text} color=${dotColor}>● <//><${Text} bold color=${theme.text}>${display}<//><${Text} color=${theme.dim}>  ${meta}<//>
      <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color=${theme.dim}>${statusText}<//><//>
    <//>
    <${Box} flexGrow=${1} flexDirection="column" marginTop=${1}>
      ${entries.length === 0 ? html`<${Text} color=${theme.dim}>(本会话暂无内容)<//>` : entries.map((e, i) => {
        const showHead = isFlow && e.agent && e.agent !== prevAgent;
        if (isFlow) prevAgent = e.agent ?? prevAgent;
        if (!showHead) return body(e, i);
        return html`<${Box} key=${i} flexDirection="column">
          <${Text} bold color=${theme.dim}>${e.agent}<//>
          ${body(e, i)}
        <//>`;
      })}
    <//>
  <//>`;
}
```

- [ ] **Step 4: FocusPane 测试看绿**

Run: `node --test --test-isolation=none test/ui/tui/focuspane.flow.test.mjs`
Expected: PASS

- [ ] **Step 5: 给 AgentRail 测试追加 flow 用例**

先 Read `test/ui/tui/components.agentrail.test.mjs` 确认它已 import `render`/`html`/`AgentRail`(若缺则补 import)。在文件末尾追加:

```js
test("AgentRail:flow 卡显示 ⑂flowName + 'running · N agents'", () => {
  const sessions = { "⑂研发流#f1": { kind: "flow", flowName: "研发流", status: "running", agents: ["a", "b", "c"], turn: 0, lastLine: "在干活" } };
  const { lastFrame } = render(html`<${AgentRail} sessions=${sessions} order=${["⑂研发流#f1"]} focusLabel=${null} />`);
  const f = lastFrame();
  assert.match(f, /⑂研发流/);
  assert.match(f, /running · 3 agents/);
});

test("AgentRail:flow 卡 awaiting → 待你", () => {
  const sessions = { "⑂x#f1": { kind: "flow", flowName: "x", status: "awaiting", agents: ["a"], turn: 0, lastLine: "" } };
  const { lastFrame } = render(html`<${AgentRail} sessions=${sessions} order=${["⑂x#f1"]} focusLabel=${"⑂x#f1"} />`);
  assert.match(lastFrame(), /待你/);
});
```

- [ ] **Step 6: 跑测试看红**

Run: `node --test --test-isolation=none test/ui/tui/components.agentrail.test.mjs`
Expected: FAIL(`running · 3 agents` 未出现;现仍渲染 `⑂undefined`/`t0`)

- [ ] **Step 7: 改 AgentRail**

替换 `src/ui/tui/components/AgentRail.mjs` 全文为:

```js
// src/ui/tui/components/AgentRail.mjs — 右栏 agent 名单。只用一条左竖线(borderLeft)与焦点区分隔,
// 该列纵向铺满 → 竖线贯穿到底。无色块。每卡恒 3 行内容 + 卡间 1 行间隔 = 4 行步距(鼠标命中按此推算)。
// flow 卡:一行代表整个 flow(⑂flowName + N agents),其内部 agent 不在此单列。
// 选中卡:▎左条 + 标签高亮色(accent)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function AgentRail({ sessions, order, focusLabel }) {
  return html`<${Box} flexDirection="column" width=${22} paddingX=${1}
      borderStyle="single" borderColor=${theme.border} borderTop=${false} borderRight=${false} borderBottom=${false}>
    <${Text} color=${theme.dim}>AGENTS · ${order.length}  ↹/^G<//>
    ${order.map((label) => {
      const s = sessions[label]; const sel = label === focusLabel;
      const isFlow = s.kind === "flow";
      const name = isFlow ? `⑂${s.flowName}` : label;
      const turnTag = isFlow ? "" : `  t${s.turn}`;
      const dotColor = s.status === "running" ? theme.accent : (s.status === "awaiting" || s.status === "failed") ? theme.warn : theme.ok;
      const dot = s.status === "running" ? "●" : s.status === "failed" ? "✗" : s.status === "awaiting" ? "●" : "✓";
      const statusText = s.status === "awaiting" ? "待你"
        : s.status === "failed" ? "failed"
        : s.status === "done" ? "done"
        : s.status === "running" ? (isFlow ? `running · ${(s.agents || []).length} agents` : `running${s.ms ? ` · ${(s.ms / 1000).toFixed(1)}s` : ""}`)
        : "idle";
      const statusColor = s.status === "running" ? theme.accent : (s.status === "awaiting" || s.status === "failed") ? theme.warn : theme.ok;
      return html`<${Box} key=${label} flexDirection="column" marginTop=${1}>
        <${Text} wrap="truncate-end"><${Text} color=${theme.accent}>${sel ? "▎" : " "}<//><${Text} color=${dotColor}>${dot} <//><${Text} bold=${sel} color=${sel ? theme.accent : theme.text}>${name}${turnTag}<//><//>
        <${Text} color=${statusColor} wrap="truncate-end"> ${statusText}<//>
        <${Text} color=${theme.dim} wrap="truncate-end"> ${s.lastLine || " "}<//>
      <//>`;
    })}
  <//>`;
}
```

- [ ] **Step 8: 全 TUI 套件看绿**

Run: `node --test --test-isolation=none test/ui/tui/*.test.mjs`
Expected: PASS(全部;此刻 store/flow-tui/components 已一致)

- [ ] **Step 9: 提交**

```bash
git add src/ui/tui/components/FocusPane.mjs src/ui/tui/components/AgentRail.mjs test/ui/tui/focuspane.flow.test.mjs test/ui/tui/components.agentrail.test.mjs
git commit -m "feat(tui): FocusPane 群聊页(发言人分段)+ AgentRail flow 行(⑂flowName · N agents)"
```

---

## Task 4: smoke 第 8 节 + 交付门

**Files:**
- Modify: `scripts/smoke-tui.mjs`(第 8 节)

- [ ] **Step 1: 改 smoke 第 8 节**

把 `scripts/smoke-tui.mjs` 第 8 节(`// 8) flow-in-TUI…` 起到 `try { tui.teardown…` 前)替换为:

```js
  // 8) flow 群聊视图:假 flowMain 多 agent → 一张 ⑂demo 群聊卡 + 一次 io.question,经真 store/render 走通。
  const { createFlowTui } = await import("../src/ui/tui/flow-tui.mjs");
  let _ans = null;
  const fakeFlowMain = async ({ progress, io }) => {
    progress.emit({ type: "opening", agent: "planner", model: "m" });
    progress.emit({ type: "delta", agent: "planner", model: "m", text: "分析需求…" });
    progress.emit({ type: "start", agent: "coder", model: "m" });
    progress.emit({ type: "delta", agent: "coder", model: "m", text: "写实现…" });
    _ans = await io.question("接受 diff?", {});
    return 0;
  };
  const flowTui = createFlowTui({ store, openBackend: () => {}, workflowsRoot: ".", cwd: ".", config: {}, flowMain: fakeFlowMain, dropDelayMs: 50 });
  const fp = flowTui.runFlow(["demo"]);
  await sleep(60);
  const flowLabel = store.getState().order.find((l) => l.startsWith("⑂demo"));
  ok("flow:一张 ⑂demo 群聊卡(非每 agent 一张)", store.getState().order.filter((l) => l.startsWith("⑂")).length === 1 && !!flowLabel);
  ok("flow:群聊页含两发言人 planner/coder + 文本", /planner/.test(stdout.text()) && /coder/.test(stdout.text()) && stdout.text().includes("分析需求") && stdout.text().includes("写实现"));
  ok("flow:approve 门置 awaiting + pendingQuestion.prompt", store.getState().sessions[flowLabel].pendingQuestion && store.getState().sessions[flowLabel].pendingQuestion.prompt === "接受 diff?");
  ok("flow:flowStatus 报 running", flowTui.flowStatus().includes("running"));
  flowTui.handleHumanLine(flowLabel, "y");
  await fp;
  ok("flow:作答后 resolve + pendingQuestion 清空", _ans === "y" && store.getState().sessions[flowLabel].pendingQuestion === null);
  await sleep(80);   // 等 dropFlow(dropDelayMs=50)
  ok("flow:结束后卡片撤除 + 结果进系统消息", !store.getState().order.includes(flowLabel) && store.getState().system.some((m) => /flow demo 结束/.test(m)));
```

- [ ] **Step 2: 跑 smoke**

Run: `node scripts/smoke-tui.mjs`
Expected: 全 PASS(`N/N checks passed` + `SMOKE PASS`)

- [ ] **Step 3: 交付门(全绿)**

Run(三条都要绿):
```bash
node --test --test-isolation=none test/ui/tui/*.test.mjs
node --test test/flow.main.test.mjs test/flow.run.test.mjs test/cli.tui-gate.test.mjs test/cli.integration.test.mjs
node scripts/smoke-tui.mjs
```
Expected: TUI 套件全绿、flow+cli 全绿、smoke 全绿。

- [ ] **Step 4: 提交**

```bash
git add scripts/smoke-tui.mjs
git commit -m "test(tui): smoke 第 8 节覆盖 flow 群聊视图(多 agent 一卡 + 作答)"
```

---

## 收尾

- 全部 task 后:派 final code reviewer 审整体(spec 合规 + 质量)。
- 唯一不可自动验证:真 TTY 交互渲染(本环境无 PTY)。人工 `node src/cli.mjs` → `/flow <真实flow>` → 看右栏只一行 `⑂flowname`、切进去是群聊页(多 agent 按发言人)、approve→`approve ❯` 作答→继续;`/flow` 无参→列表;Ctrl-C 中断。
- 不 push/不 merge,除非用户明示。

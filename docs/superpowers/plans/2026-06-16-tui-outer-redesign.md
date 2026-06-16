# TUI 最外层交互重设计 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-06-16-tui-outer-redesign-design.md` 重排 TUI 渲染层:输入框通栏两线、状态栏加"待你"计数、删 C/D 折叠条改流内面包屑、agent 栏瘦身加"待你"态、配色统一为 Catppuccin Mocha。

**Architecture:** 纯渲染/状态层改造,内核(session-manager/control-wire/relay/backend)与 store 数据通道不动。fence 数据改"额外推一条流内面包屑条目";后台 session turn 结束改置 `awaiting` 态并向焦点流推"冒泡"条目。配色集中进新 `theme.mjs`,换主题只改一处。

**Tech Stack:** Node ESM + Ink ^6(`<Text color="#hex">`/`<Box borderTop/borderBottom>`)+ htm 模板(`html\`...\``)+ node:test + ink-testing-library。

**实现期约定:**
- 测试只跑受影响文件,**别全量 `node --test`**(会拖进验收/网络测试一路 30s 超时)。若报 `spawn EPERM`,加 `--test-isolation=none`。
- "待你"(awaiting)触发规则在本计划里**已定死**(spec §6 曾留开放):**后台(非焦点)session 一个 turn 结束(running→idle)即置 `awaiting`;被聚焦(setFocus/focusNext/点击/Ctrl-G 跳转)即清回 `idle`。** 焦点 session 永不 awaiting。error 同样置 awaiting。
- 跳转"待你"用 **Ctrl-G**(原 C 展开键已释放;`Ctrl-Tab` 在多数终端不可靠,故弃用 mockup 里的 `^↹` 写法)。

---

### Task 1: theme.mjs — Catppuccin Mocha 配色模块

**Files:**
- Create: `src/ui/tui/theme.mjs`
- Test: `test/ui/tui/theme.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/theme.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { theme } from "../../../src/ui/tui/theme.mjs";

test("theme 含全部语义角色且为 #hex", () => {
  for (const k of ["bg","bg2","border","borderBright","text","dim","accent","you","tool","ok","warn","breadcrumb","nudge"]) {
    assert.match(theme[k], /^#[0-9a-f]{6}$/i, `${k} 应为 #hex`);
  }
});
test("关键色值锁定(Catppuccin Mocha)", () => {
  assert.strictEqual(theme.accent, "#89b4fa");
  assert.strictEqual(theme.warn, "#fab387");
  assert.strictEqual(theme.nudge, "#cba6f7");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/theme.test.mjs`
Expected: FAIL —  Cannot find module `theme.mjs`。

- [ ] **Step 3: 实现 theme.mjs**

```js
// src/ui/tui/theme.mjs — Catppuccin Mocha 配色:语义角色 → #hex。换主题只改这里。
// Ink <Text color> / <Box borderColor> 接受 #hex(truecolor 直出,旧终端自动降到最近 ANSI)。
export const theme = {
  bg: "#1e1e2e", bg2: "#181825",
  border: "#313244", borderBright: "#45475a",
  text: "#cdd6f4", dim: "#6c7086",
  accent: "#89b4fa",      // label·焦点·提示符·光标
  you: "#a6e3a1",         // 用户输入标记
  tool: "#94e2d5",        // 工具卡 / 提示候选
  ok: "#a6e3a1",          // 成功 / idle / done
  warn: "#fab387",        // 待你 / 计数 / 高亮
  breadcrumb: "#7f849c",  // 编排面包屑(压低)
  nudge: "#cba6f7",       // 后台冒泡 ↳
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/theme.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/theme.mjs test/ui/tui/theme.test.mjs
git commit -m "feat(tui): theme.mjs — Catppuccin Mocha 配色单点"
```

---

### Task 2: breadcrumbs.mjs — fence 命令翻成人话(纯函数)

**Files:**
- Create: `src/ui/tui/breadcrumbs.mjs`
- Test: `test/ui/tui/breadcrumbs.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/breadcrumbs.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { fenceBreadcrumb } from "../../../src/ui/tui/breadcrumbs.mjs";

test("/open 成功 → 开了 <label>", () => {
  assert.strictEqual(fenceBreadcrumb("/open --agent codex", "ok · session codex#1"), "开了 codex#1");
});
test("/open 无 session 字样但 ok → 开了新会话", () => {
  assert.strictEqual(fenceBreadcrumb("/open --agent codex", "ok"), "开了新会话");
});
test("/relay → 连了 relay <args>", () => {
  assert.strictEqual(fenceBreadcrumb("/relay omp#1->codex#1", "ok"), "连了 relay omp#1->codex#1");
});
test("@target → 给 <target> 派了活", () => {
  assert.strictEqual(fenceBreadcrumb("@codex#1 核对 diff", "ok"), "给 codex#1 派了活");
});
test("未识别命令 → 回退 cmd → result", () => {
  assert.strictEqual(fenceBreadcrumb("/weird x", "boom"), "/weird x → boom");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/breadcrumbs.test.mjs`
Expected: FAIL — 找不到模块。

- [ ] **Step 3: 实现 breadcrumbs.mjs**

```js
// src/ui/tui/breadcrumbs.mjs — 把 fence 命令(cmd,result)翻成一句人能读的面包屑。
// 纯函数、可单测;措辞可后续微调,映射不中则回退原始 "cmd → result"。
export function fenceBreadcrumb(cmd, result) {
  const c = String(cmd || "").trim();
  const r = String(result || "").trim();
  if (c.startsWith("/open")) {
    const m = r.match(/session\s+(\S+)/);
    if (m) return `开了 ${m[1]}`;
    return r.startsWith("ok") ? "开了新会话" : `开会话失败: ${r}`;
  }
  if (c.startsWith("/relay")) {
    const m = c.match(/\/relay\s+(\S+)/);
    return m ? `连了 relay ${m[1]}` : "建了 relay";
  }
  if (c.startsWith("@")) {
    const m = c.match(/^@(\S+)/);
    return m ? `给 ${m[1]} 派了活` : "派了活";
  }
  return `${c} → ${r}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/breadcrumbs.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/breadcrumbs.mjs test/ui/tui/breadcrumbs.test.mjs
git commit -m "feat(tui): breadcrumbs.mjs — fence 命令转人话(纯函数)"
```

---

### Task 3: store — appendFence 额外推流内面包屑条目

**Files:**
- Modify: `src/ui/tui/store.mjs`(顶部 import + `appendFence`)
- Test: `test/ui/tui/store.fence.test.mjs`(追加用例)

- [ ] **Step 1: 追加失败测试**

在 `test/ui/tui/store.fence.test.mjs` 末尾追加:

```js
import { EventEmitter as EE2 } from "node:events";
test("appendFence 向发起会话 entries 推 breadcrumb 条目(每命令一条)", () => {
  const store = createStore();
  store.attachSession("omp#1", new EE2(), "omp", {});
  store.appendFence("omp#1", { commands: [
    { cmd: "/open --agent codex", result: "ok · session codex#1" },
    { cmd: "@codex#1 核对", result: "ok" },
  ], feedbackSent: true });
  const ent = store.getState().sessions["omp#1"].entries.filter((e) => e.type === "breadcrumb");
  assert.strictEqual(ent.length, 2);
  assert.strictEqual(ent[0].text, "开了 codex#1");
  assert.strictEqual(ent[1].text, "给 codex#1 派了活");
});
test("appendFence 对未 attach 的 label 不抛(无 entries 可推)", () => {
  const store = createStore();
  assert.doesNotThrow(() => store.appendFence("ghost", { commands: [{ cmd: "/open", result: "ok" }], feedbackSent: false }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/store.fence.test.mjs`
Expected: FAIL — `breadcrumb` 条目数为 0(尚未实现推送)。

- [ ] **Step 3: 实现**

在 `src/ui/tui/store.mjs` 顶部 import 区加:

```js
import { fenceBreadcrumb } from "./breadcrumbs.mjs";
```

把 `appendFence` 改为(保留原 fences 累积逻辑不动,新增推 entries):

```js
    appendFence(label, fence) {
      const f = state.fences[label] || { commands: [], feedbackSent: false, seen: true };
      f.commands = f.commands.concat(fence.commands || []);
      while (f.commands.length > MAX_FENCE_CMDS) f.commands.shift();
      f.feedbackSent = Boolean(fence.feedbackSent);
      f.seen = false;   // 新编排到达 → 触发 hot(旧 C 条遗留,无害)
      state.fences[label] = f;
      // 新:每条命令翻成流内面包屑条目(供对话流渲染;不再依赖底部 C 折叠条)
      const s = state.sessions[label];
      if (s) {
        for (const c of (fence.commands || [])) s.entries.push({ type: "breadcrumb", text: fenceBreadcrumb(c.cmd, c.result) });
        trimEntries(s);
      }
      notify();
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/store.fence.test.mjs`
Expected: PASS(原 5 用例 + 新 2 用例全绿)。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/store.mjs test/ui/tui/store.fence.test.mjs
git commit -m "feat(tui): appendFence 额外推流内 breadcrumb 条目"
```

---

### Task 4: store — awaiting 态 + 后台冒泡 + 聚焦清除 + firstAwaiting

**Files:**
- Modify: `src/ui/tui/store.mjs`(`apply` idle 分支、error 监听、`setFocus`、`focusNext`、新增 `firstAwaiting`、新增内部 `pushNudgeToFocus`)
- Test: `test/ui/tui/store.awaiting.test.mjs`(新建)

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/store.awaiting.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";

function turn(emitter) { // 模拟一个 turn:running → idle
  emitter.emit("status", { status: "running", isStreaming: true });
  emitter.emit("status", { status: "idle", isStreaming: false });
}

test("后台 session turn 结束 → awaiting + 焦点流出现 nudge 条目", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});   // 首个 attach → 自动成焦点
  store.attachSession("omp#2", b, "omp", {});
  turn(b);                                       // omp#2 是后台
  assert.strictEqual(store.getState().sessions["omp#2"].status, "awaiting");
  const nudges = store.getState().sessions["omp#1"].entries.filter((e) => e.type === "nudge");
  assert.strictEqual(nudges.length, 1);
  assert.strictEqual(nudges[0].target, "omp#2");
});
test("焦点 session 自己 turn 结束 → 不 awaiting、无 nudge", () => {
  const store = createStore();
  const a = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  turn(a);
  assert.strictEqual(store.getState().sessions["omp#1"].status, "idle");
  assert.strictEqual(store.getState().sessions["omp#1"].entries.filter((e) => e.type === "nudge").length, 0);
});
test("setFocus 到 awaiting 的 session → 清回 idle", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  turn(b);
  store.setFocus("omp#2");
  assert.strictEqual(store.getState().sessions["omp#2"].status, "idle");
});
test("focusNext 跨到 awaiting → 清回 idle", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  turn(b);
  store.focusNext();   // omp#1 → omp#2
  assert.strictEqual(store.getState().focusLabel, "omp#2");
  assert.strictEqual(store.getState().sessions["omp#2"].status, "idle");
});
test("firstAwaiting 返回首个 awaiting label,无则 null", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  assert.strictEqual(store.firstAwaiting(), null);
  turn(b);
  assert.strictEqual(store.firstAwaiting(), "omp#2");
});
test("后台 session error → awaiting + nudge", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  b.emit("error", new Error("boom"));
  assert.strictEqual(store.getState().sessions["omp#2"].status, "awaiting");
  assert.ok(store.getState().sessions["omp#1"].entries.some((e) => e.type === "nudge" && e.target === "omp#2"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/store.awaiting.test.mjs`
Expected: FAIL — awaiting/nudge/firstAwaiting 均未实现。

- [ ] **Step 3: 实现**

在 `src/ui/tui/store.mjs`,`apply` 函数内 `else if (ev.status === "idle")` 分支改为:

```js
      else if (ev.status === "idle") {
        s.turn += 1;
        if (s.turnStartAt != null) { s.ms = Date.now() - s.turnStartAt; s.turnStartAt = null; }
        if (label !== state.focusLabel) { s.status = "awaiting"; pushNudgeToFocus(label, "跑完了"); }
      }
```

在 `apply` 函数上方(`trimEntries` 之后)加内部函数:

```js
  function pushNudgeToFocus(fromLabel, what) {
    const fl = state.focusLabel;
    if (!fl || fl === fromLabel) return;
    const fs = state.sessions[fl];
    if (!fs) return;
    fs.entries.push({ type: "nudge", text: `${fromLabel} ${what}`, target: fromLabel });
    trimEntries(fs);
  }
```

把 `attachSession` 里的 error 监听改为(加 awaiting/nudge):

```js
      session.on("error", (err) => {
        state.system.push(`[${label}] ${err?.message ?? err}`); trimSystem();
        const es = state.sessions[label];
        if (es && label !== state.focusLabel) { es.status = "awaiting"; pushNudgeToFocus(label, "出错了"); }
        notify();
      });
```

把 `setFocus` / `focusNext` 改为(聚焦即清 awaiting),并加 `firstAwaiting`:

```js
    setFocus(label) {
      const s = state.sessions[label];
      if (s) { if (s.status === "awaiting") s.status = "idle"; state.focusLabel = label; notify(); }
    },
    focusNext() {
      if (state.order.length === 0) return;
      const i = state.order.indexOf(state.focusLabel);
      const nl = state.order[(i + 1) % state.order.length];
      state.focusLabel = nl;
      const s = state.sessions[nl];
      if (s && s.status === "awaiting") s.status = "idle";
      notify();
    },
    firstAwaiting() {
      for (const l of state.order) if (state.sessions[l] && state.sessions[l].status === "awaiting") return l;
      return null;
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/store.awaiting.test.mjs`
Expected: PASS(6 用例全绿)。

- [ ] **Step 5: 回归既有 store 测试**

Run: `node --test test/ui/tui/store.test.mjs test/ui/tui/store.timeline.test.mjs test/ui/tui/store.fence.test.mjs test/ui/tui/store.adapter-order.test.mjs`
Expected: PASS(awaiting 仅在"非焦点 + idle"触发,既有单 session 用例多为焦点态,不受影响)。

- [ ] **Step 6: 提交**

```bash
git add src/ui/tui/store.mjs test/ui/tui/store.awaiting.test.mjs
git commit -m "feat(tui): 后台 session awaiting 态 + 焦点流冒泡 + 聚焦清除"
```

---

### Task 5: AgentRail — 三行卡片 + 待你态 + Catppuccin

**Files:**
- Modify: `src/ui/tui/components/AgentRail.mjs`(去 `relays` 入参与 ▶/◀ 两行,加 awaiting,换色)
- Test: `test/ui/tui/components.agentrail.test.mjs`(新建,避免动既有 components.test.mjs 结构)

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/components.agentrail.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { AgentRail } from "../../../src/ui/tui/components/AgentRail.mjs";

const sessions = {
  "omp#1": { agent: "omp", status: "running", turn: 4, ms: 17000, lastLine: "分析中" },
  "codex#1": { agent: "codex", status: "awaiting", turn: 3, ms: 1200, lastLine: "评审完成" },
  "omp#2": { agent: "omp", status: "idle", turn: 1, ms: null, lastLine: "" },
};
test("列出所有 label + 各状态文案", () => {
  const f = render(html`<${AgentRail} sessions=${sessions} order=${["omp#1","codex#1","omp#2"]} focusLabel="omp#1" />`).lastFrame();
  assert.match(f, /omp#1/); assert.match(f, /codex#1/); assert.match(f, /omp#2/);
  assert.match(f, /running/);
  assert.match(f, /待你/);     // awaiting 显示"待你"
  assert.match(f, /idle/);
});
test("不再渲染 relay 箭头 ▶/◀", () => {
  const f = render(html`<${AgentRail} sessions=${sessions} order=${["omp#1","codex#1","omp#2"]} focusLabel="omp#1" />`).lastFrame();
  assert.ok(!f.includes("▶")); assert.ok(!f.includes("◀"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/components.agentrail.test.mjs`
Expected: FAIL — 当前仍渲染 ▶/◀ 且无"待你"。

- [ ] **Step 3: 实现 AgentRail.mjs(整体替换)**

```js
// src/ui/tui/components/AgentRail.mjs — 固定高卡片(每卡恒 3 行内容 + 边框 = 5 行,鼠标命中可推算)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function AgentRail({ sessions, order, focusLabel }) {
  return html`<${Box} flexDirection="column" width=${30} borderStyle="single" borderColor=${theme.border}>
    <${Box} paddingX=${1}><${Text} color=${theme.accent}>AGENTS · ${order.length}  ↹/点击<//><//>
    ${order.map((label) => {
      const s = sessions[label]; const sel = label === focusLabel;
      const dotColor = s.status === "running" ? theme.accent : s.status === "awaiting" ? theme.warn : theme.ok;
      const dot = s.status === "idle" ? "✓" : "●";
      const statusText = s.status === "running" ? `running${s.ms ? ` · ${(s.ms/1000).toFixed(1)}s` : ""}`
        : s.status === "awaiting" ? "待你" : "idle";
      const statusColor = s.status === "running" ? theme.accent : s.status === "awaiting" ? theme.warn : theme.ok;
      return html`<${Box} key=${label} flexDirection="column" paddingX=${1}
          borderStyle="single" borderColor=${sel ? theme.accent : theme.border}>
        <${Text} bold=${sel} color=${sel ? theme.accent : theme.text} wrap="truncate-end">
          <${Text} color=${dotColor}>${dot} <//>${label}  t${s.turn}<//>
        <${Text} color=${statusColor} wrap="truncate-end">${statusText}<//>
        <${Text} color=${theme.dim} wrap="truncate-end">${s.lastLine || " "}<//>
      <//>`;
    })}
  <//>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/components.agentrail.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/components/AgentRail.mjs test/ui/tui/components.agentrail.test.mjs
git commit -m "feat(tui): AgentRail 瘦身为三行卡 + 待你态 + Catppuccin"
```

---

### Task 6: index.mjs — computeRailRegions 卡高 7→5

**Files:**
- Modify: `src/ui/tui/index.mjs`(`computeRailRegions`)
- Test: `test/ui/tui/index.test.mjs`(改既有断言)

- [ ] **Step 1: 改测试为新卡高(先红)**

把 `test/ui/tui/index.test.mjs` 中那条 computeRailRegions 用例替换为:

```js
test("computeRailRegions:右栏宽 30 贴右,首卡 railTop+2,每卡高 5(1-based)", () => {
  const regs = computeRailRegions(["omp#1", "codex#1"], 100);
  assert.deepStrictEqual(regs["agent:omp#1"], { x: 71, y: 3, w: 30, h: 5 });
  assert.deepStrictEqual(regs["agent:codex#1"], { x: 71, y: 8, w: 30, h: 5 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/index.test.mjs`
Expected: FAIL — 当前返回 h:7 / y:10。

- [ ] **Step 3: 实现**

在 `src/ui/tui/index.mjs` 把 `computeRailRegions` 内的 `7` 改为 `5` 并更新注释:

```js
// 右栏 agent 卡矩形(1-based)。右栏宽 30 贴右;rail 顶边框 1 行 + header 1 行 → 首卡从第 3 行起;
// 每卡 borderStyle(上下边框 2)+ 内容 3 行 = 5 行(见 AgentRail 固定高说明)。纯函数,便于单测。
export function computeRailRegions(order, cols) {
  const x = (cols || 100) - 30 + 1;     // 1-based 左边界
  const regs = {};
  order.forEach((label, i) => { regs[`agent:${label}`] = { x, y: 3 + i * 5, w: 30, h: 5 }; });
  return regs;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/index.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/index.mjs test/ui/tui/index.test.mjs
git commit -m "fix(tui): 卡高 7→5 同步鼠标命中(AgentRail 瘦身)"
```

---

### Task 7: InputBar — 四边框改上下两线 + Catppuccin

**Files:**
- Modify: `src/ui/tui/components/InputBar.mjs`
- Test: `test/ui/tui/components.inputbar.test.mjs`(新建)

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/components.inputbar.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { InputBar } from "../../../src/ui/tui/components/InputBar.mjs";

test("显示前缀 + 文本", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="加测试" hints=${{kind:"none",items:[]}} />`).lastFrame();
  assert.match(f, /omp#1/); assert.match(f, /加测试/);
});
test("有提示时渲染候选", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="/op" hints=${{kind:"slash",items:[{value:"/open",desc:"新开"}]}} />`).lastFrame();
  assert.match(f, /\/open/);
});
test("只有上下通栏线(无左右竖边框字符 │)", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="x" hints=${{kind:"none",items:[]}} />`).lastFrame();
  assert.ok(!f.includes("│"), "不应有竖边框");
  assert.ok(f.includes("─"), "应有横线");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/components.inputbar.test.mjs`
Expected: FAIL — 当前是四边 `borderStyle="single"`,含竖边框 `│`。

- [ ] **Step 3: 实现 InputBar.mjs(整体替换)**

```js
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function InputBar({ focusLabel, value, hints }) {
  return html`<${Box} flexDirection="column">
    ${hints && hints.items.length ? html`<${Box} flexDirection="column" paddingX=${1}>
      ${hints.items.slice(0, 6).map((it) => html`<${Box} key=${it.value}>
        <${Text} color=${theme.tool}>${it.value}<//>${it.desc ? html`<${Text} color=${theme.dim}>  ${it.desc}<//>` : null}
      <//>`)}
    <//>` : null}
    <${Box} borderStyle="single" borderColor=${theme.borderBright} borderLeft=${false} borderRight=${false} paddingX=${1}>
      <${Text} color=${theme.accent} bold>[${focusLabel || "—"}] ❯ <//><${Text} color=${theme.text}>${value}▌<//>
    <//>
  <//>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/components.inputbar.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/components/InputBar.mjs test/ui/tui/components.inputbar.test.mjs
git commit -m "feat(tui): InputBar 改通栏上下两线 + Catppuccin"
```

---

### Task 8: StatusBar — agents/待你 计数 + ?帮助 + Catppuccin

**Files:**
- Modify: `src/ui/tui/components/StatusBar.mjs`(签名 `{running,mesh}` → `{agents,awaiting,mesh}`)
- Test: `test/ui/tui/components.statusbar.test.mjs`(新建);并改 `test/ui/tui/components.test.mjs` 里旧 StatusBar 用例

- [ ] **Step 1: 写失败测试 + 改旧用例**

新建 `test/ui/tui/components.statusbar.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { StatusBar } from "../../../src/ui/tui/components/StatusBar.mjs";

test("显示 agents 总数 + 待你计数 + mesh", () => {
  const f = render(html`<${StatusBar} agents=${3} awaiting=${1} mesh=${true} />`).lastFrame();
  assert.match(f, /3 agents/);
  assert.match(f, /1 待你/);
  assert.match(f, /mesh on/);
});
test("含 ?帮助 提示", () => {
  assert.match(render(html`<${StatusBar} agents=${0} awaiting=${0} mesh=${false} />`).lastFrame(), /\? 帮助/);
});
```

在 `test/ui/tui/components.test.mjs` 把旧用例(约 61-63 行)替换为新签名:

```js
test("StatusBar 显示 agents 与待你计数", () => {
  assert.match(render(html`<${StatusBar} agents=${2} awaiting=${0} mesh=${true} />`).lastFrame(), /2 agents/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/components.statusbar.test.mjs test/ui/tui/components.test.mjs`
Expected: FAIL — 当前 StatusBar 读 `running`,不渲染 agents/待你。

- [ ] **Step 3: 实现 StatusBar.mjs(整体替换)**

```js
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function StatusBar({ agents, awaiting, mesh }) {
  return html`<${Box} justifyContent="space-between" paddingX=${1}>
    <${Text} color=${theme.dim}>↹ 切  ^O 开  ^W 关  / 命令  ^C 中断  ^G 去看  ? 帮助<//>
    <${Text} color=${theme.warn}>${agents} agents · ${awaiting} 待你 · mesh ${mesh ? "on" : "off"}<//>
  <//>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/components.statusbar.test.mjs test/ui/tui/components.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/components/StatusBar.mjs test/ui/tui/components.statusbar.test.mjs test/ui/tui/components.test.mjs
git commit -m "feat(tui): StatusBar 改 agents/待你 计数 + ?帮助 + Catppuccin"
```

---

### Task 9: FocusPane — 删 C/D 折叠条 + 渲面包屑/冒泡 + Catppuccin

**Files:**
- Modify: `src/ui/tui/components/FocusPane.mjs`(去 `fence/relays/expandC/expandD` 入参与两条 CollapsibleStrip;entries 增 breadcrumb/nudge 渲染;换色)
- Test: `test/ui/tui/components.focuspane.test.mjs`(新建)

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/components.focuspane.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";

const sess = {
  agent: "omp", model: "m", effort: null, status: "running", isStreaming: true, turn: 1, ms: null,
  assistantText: "尾", lastLine: "尾",
  entries: [
    { type: "user", text: "做点事" },
    { type: "assistant", text: "好的我先读文件" },
    { type: "tool", id: "t1", name: "read_file", args: { path: "a" }, status: "done", ok: true, output: "x", diff: null, expanded: false },
    { type: "breadcrumb", text: "开了 codex#1" },
    { type: "nudge", text: "codex#1 跑完了", target: "codex#1" },
  ],
};
test("混排渲染 user/assistant/tool/breadcrumb/nudge", () => {
  const f = render(html`<${FocusPane} label="omp#1" sess=${sess} selectedIndex=${-1} />`).lastFrame();
  assert.match(f, /做点事/);
  assert.match(f, /我先读文件/);
  assert.match(f, /read_file/);
  assert.match(f, /开了 codex#1/);     // 面包屑
  assert.match(f, /codex#1 跑完了/);    // 冒泡
  assert.match(f, /去看/);              // 冒泡带 ^G 去看
});
test("不再渲染 C 编排意图 / D relay 折叠条", () => {
  const f = render(html`<${FocusPane} label="omp#1" sess=${sess} selectedIndex=${-1} />`).lastFrame();
  assert.ok(!f.includes("编排意图"));
  assert.ok(!f.includes("D relay"));
});
test("无会话给提示", () => {
  assert.match(render(html`<${FocusPane} label=${null} sess=${undefined} />`).lastFrame(), /无会话|\^O/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/components.focuspane.test.mjs`
Expected: FAIL — 仍含"编排意图";breadcrumb/nudge 未渲染。

- [ ] **Step 3: 实现 FocusPane.mjs(整体替换)**

```js
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { ToolCard } from "./ToolCard.mjs";
import { theme } from "../theme.mjs";
export function FocusPane({ label, sess, selectedIndex = -1 }) {
  if (!sess) return html`<${Box} flexGrow=${1} paddingX=${1}><${Text} color=${theme.dim}>无会话。^O 新开一个。<//><//>`;
  const meta = [sess.agent, sess.model || "default", sess.effort ? `effort ${sess.effort}` : null].filter(Boolean).join(" · ");
  const entries = Array.isArray(sess.entries) ? sess.entries : [];
  const lastAsstIdx = (() => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "assistant") return i; return -1; })();
  const headColor = sess.status === "running" ? theme.accent : sess.status === "awaiting" ? theme.warn : theme.ok;
  const body = html`<${Box} flexGrow=${1} flexDirection="column" paddingX=${1}>
    ${entries.length === 0 ? html`<${Text} color=${theme.dim}>(本会话暂无内容)<//>` : entries.map((e, i) => {
      if (e.type === "user") return html`<${Text} key=${i} color=${theme.you}>❯ ${e.text}<//>`;
      if (e.type === "tool") return html`<${ToolCard} key=${i} entry=${e} selected=${i === selectedIndex} />`;
      if (e.type === "breadcrumb") return html`<${Text} key=${i} color=${theme.breadcrumb}>· ${e.text}<//>`;
      if (e.type === "nudge") return html`<${Text} key=${i} color=${theme.nudge}>↳ ${e.text} · ^G 去看<//>`;
      return html`<${Text} key=${i} color=${theme.text}>${e.text}${(sess.isStreaming && i === lastAsstIdx) ? "▌" : ""}<//>`;
    })}
  <//>`;
  return html`<${Box} flexDirection="column" flexGrow=${1}>
    <${Box} flexDirection="column" borderStyle="single" borderColor=${theme.accent} paddingX=${1}>
      <${Box}>
        <${Text} color=${headColor}>● <//><${Text} bold color=${theme.accent}>${label}<//>
        <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color=${headColor}>
          ${sess.status} · turn ${sess.turn}${sess.ms ? ` · ${(sess.ms/1000).toFixed(1)}s` : ""}<//><//>
      <//>
      <${Text} color=${theme.dim}>${meta}<//>
    <//>
    ${body}
  <//>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/components.focuspane.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/components/FocusPane.mjs test/ui/tui/components.focuspane.test.mjs
git commit -m "feat(tui): FocusPane 删 C/D 折叠条 + 渲面包屑/冒泡 + Catppuccin"
```

---

### Task 10: app.mjs — 去 ^G/^T 展开,Ctrl-G 改跳 awaiting,接新签名

**Files:**
- Modify: `src/ui/tui/app.mjs`(去 expandC/expandD 状态与 ^G/^T 展开;Ctrl-G → `onSelect(store.firstAwaiting())`;FocusPane/StatusBar 新入参)
- Test: `test/ui/tui/app.test.mjs`(删 3 条 C/D 用例,加 1 条 awaiting 跳转用例)

- [ ] **Step 1: 改测试(删旧 C/D + 加 awaiting 跳转)**

删除 `test/ui/tui/app.test.mjs` 中三条用例:`Ctrl-G 展开 C 编排意图…`、`Ctrl-T 展开 D relay…`、`Ctrl-G 连按两次…`(约 84-117 行)。在文件末尾追加:

```js
test("Ctrl-G 跳到 awaiting 的后台 agent(经 onSelect)", async () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});   // 焦点
  store.attachSession("omp#2", b, "omp", {});
  b.emit("status", { status: "running", isStreaming: true });
  b.emit("status", { status: "idle", isStreaming: false });   // omp#2 → awaiting
  let picked = null;
  const props = { ...base(store), onSelect: (l) => { picked = l; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("\x07");   // Ctrl-G
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(picked, "omp#2");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ui/tui/app.test.mjs`
Expected: FAIL — 当前 Ctrl-G 走 expandC 分支,不调 onSelect;`picked` 仍为 null。

- [ ] **Step 3: 实现 app.mjs(整体替换)**

```js
// src/ui/tui/app.mjs — TUI 根组件:布局 + 键盘 + Ctrl-C + 焦点回调 + store 订阅。
import { useState, useEffect, useRef } from "react";
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
  const valueRef = useRef("");
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  const st = store.getState();
  const [selIdx, setSelIdx] = useState(-1);
  useEffect(() => { setSelIdx(-1); }, [st.focusLabel]);
  const hints = computeHints(value, hintsCtx);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onInterrupt(); return; }
    if (key.tab) { onCycle(); return; }
    if (key.return) {
      const line = valueRef.current.trim();
      valueRef.current = "";
      setValue("");
      if (line) {
        const r = dispatch(line, { source: "human" });
        if (r && r.exit) onInterrupt();
      }
      return;
    }
    if (key.backspace || key.delete) {
      const next = valueRef.current.slice(0, -1);
      valueRef.current = next;
      setValue(next);
      return;
    }
    if (key.ctrl && input === "o") { dispatch("/open", { source: "human" }); return; }
    if (key.ctrl && input === "w" && st.focusLabel) { dispatch(`/close ${st.focusLabel}`, { source: "human" }); return; }
    if (key.ctrl && input === "g") { const t = store.firstAwaiting(); if (t) onSelect(t); return; }   // 跳到"待你"的后台 agent
    if (key.ctrl && input === "e") {
      const st2 = store.getState();
      const ent = (st2.sessions[st2.focusLabel]?.entries) || [];
      let idx = (selIdx >= 0 && ent[selIdx]?.type === "tool") ? selIdx
        : (() => { for (let i = ent.length - 1; i >= 0; i--) if (ent[i].type === "tool") return i; return -1; })();
      if (idx >= 0) store.toggleEntry(st2.focusLabel, idx);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const st2 = store.getState();
      const ent = (st2.sessions[st2.focusLabel]?.entries) || [];
      const tools = ent.map((e, i) => e.type === "tool" ? i : -1).filter((i) => i >= 0);
      if (tools.length) {
        const cur = tools.indexOf(selIdx);
        const next = key.upArrow ? (cur <= 0 ? tools.length - 1 : cur - 1) : (cur < 0 || cur >= tools.length - 1 ? 0 : cur + 1);
        setSelIdx(tools[next]);
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const next = valueRef.current + input;
      valueRef.current = next;
      setValue(next);
    }
  });

  const agents = st.order.length;
  const awaiting = Object.values(st.sessions).filter((s) => s.status === "awaiting").length;
  return html`<${Box} flexDirection="column" width="100%">
    <${Box} flexGrow=${1}>
      <${FocusPane} label=${st.focusLabel} sess=${st.sessions[st.focusLabel]} selectedIndex=${selIdx} />
      <${AgentRail} sessions=${st.sessions} order=${st.order} focusLabel=${st.focusLabel} />
    <//>
    <${SystemStrip} messages=${st.system} />
    <${InputBar} focusLabel=${st.focusLabel} value=${value} hints=${hints} />
    <${StatusBar} agents=${agents} awaiting=${awaiting} mesh=${mesh} />
  <//>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui/tui/app.test.mjs`
Expected: PASS(原保留用例 + 新 awaiting 跳转用例全绿)。

- [ ] **Step 5: 提交**

```bash
git add src/ui/tui/app.mjs test/ui/tui/app.test.mjs
git commit -m "feat(tui): app 去 C/D 展开键,Ctrl-G 改跳待你 + 接新组件签名"
```

---

### Task 11: 清理 CollapsibleStrip + 全量回归

**Files:**
- Delete: `src/ui/tui/components/CollapsibleStrip.mjs`
- Modify: `test/ui/tui/components.test.mjs`(删 CollapsibleStrip 的 import 与用例)

- [ ] **Step 1: 删死代码**

删除文件 `src/ui/tui/components/CollapsibleStrip.mjs`。
在 `test/ui/tui/components.test.mjs` 删掉:第 7 行 `import { CollapsibleStrip } ...`,以及 "CollapsibleStrip 折叠只显摘要…" 那条用例(约 47-50 行)。

- [ ] **Step 2: 确认无残留引用**

Run: `grep -rn "CollapsibleStrip" src test`
Expected: 无输出(FocusPane 已在 Task 9 去引用)。

- [ ] **Step 3: 跑全部 TUI 单测**

Run: `node --test test/ui/tui/`
Expected: PASS(若报 `spawn EPERM` 改 `node --test --test-isolation=none test/ui/tui/`)。
关注:`components.test.mjs`(FocusPane/AgentRail 旧用例已被新专项测试覆盖,旧用例若因签名变化失败需顺手改;FocusPane 旧用例传了 `fence/relays` 多余 props,Ink 会忽略,应仍绿)。

- [ ] **Step 4: 跑 cli 相关回归(确认非 TTY/老 REPL 不受影响)**

Run: `node --test test/cli.tui-gate.test.mjs`
Expected: PASS(本计划只动渲染层,TTY 判定/降级未碰)。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(tui): 删 CollapsibleStrip 死代码 + 全量回归绿"
```

---

## 验证(人工,本环境无 PTY)

自动测试覆盖纯逻辑与组件渲染;**真 TTY 交互渲染**(配色实际观感、输入框两线、待你冒泡、Ctrl-G 跳转手感)需人工冒烟:`node src/cli.mjs`(或带 `--agent`),开两个会话、让后台那个跑一轮,观察:① 输入框只剩上下两线;② agent 栏出现"待你";③ 焦点流冒出 `↳ … 跑完了 · ^G 去看`;④ 按 Ctrl-G 跳过去且"待你"消失;⑤ 整体 Catppuccin 配色。

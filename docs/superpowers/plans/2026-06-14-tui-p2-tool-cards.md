# Synod TUI — P2 富工具调用卡片 + 时间线 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 synod TUI 焦点区从「只显当前 turn 的流式 assistant 文本」升级为**有序时间线**(user / assistant / **工具调用卡片** 混排),工具调用渲染成**可展开卡片**(收起显摘要、展开看 args/diff/output),数据取自 omp/codex 后端**不截断**的工具事件。

**Architecture:** 纯**加法**,不改 P1 已交付的内核语义。① `backend.mjs`:OmpSession/CodexSession 新增一条 `toolevent` EventEmitter 通道,发**未经 `compactEvent` 截断**的完整工具消息(现有 `event` 通道保持压缩不变 → agent-bridge 等既有消费者零影响)。② `events.mjs`:用 P1 已建的**注册制**为 omp/codex 各注册一个事件适配器,把 `toolevent`(及 delta/status)规范化成 `{kind:"tool.start"|"tool.end"|"message.delta"|"status"}`。③ `store.mjs`:每会话增加**有序 `entries` 时间线**(assistant/tool/user 条目 + 用户消息回显 + 每条 tool 卡的 `expanded` 状态),P1 字段(`assistantText`/`lastLine`/`status`/`turn`/`ms`,供 AgentRail)继续维护**不破坏**。④ 新 `ToolCard` 组件 + `FocusPane` 改渲时间线。⑤ `app.mjs`/`cli.mjs`:启动注册适配器、dispatch 人类消息时回显 user 条目、键盘展开/折叠当前 tool 卡。

**Tech Stack:** Node 20+ ESM(无构建);Ink 6 + htm(P1 已装);`node:test`。事件适配器走 P1 的注册制(`src/ui/tui/events.mjs` 的 `registerEventAdapter`/`getEventAdapter`)。

**前置:** P1 已交付(分支 `feat/tui-p1`)。本计划基于 P1 代码续作。配套 spec:`docs/superpowers/specs/2026-06-13-tui-page-design.md` §5/§7/§10。

> **范围裁定(writing-plans scope-check):** P2 = **工具卡片 + 时间线**(连贯、可独立交付、可测)。另三项较小且互相独立,**留作后续单独计划**,不在本计划内:**C「编排意图」接 control-wire 真实数据**(P1 已留 `store.setFence` 钩子,小改但依赖 control-wire 暴露 per-label fence 数据,单列);**flow 在 TUI 内 approve/question**(独立子系统,涉及 input-router/claim,单列);**`$` shell 命令**(用户本期已搁置)。理由见计划末「后续(不在本计划)」。

---

## 文件结构

| 文件 | 职责 | 新建/改 |
|---|---|---|
| `src/backend.mjs` | OmpSession/CodexSession 新增 `toolevent` 通道,发未截断的工具消息 | 改 |
| `src/ui/tui/events.mjs` | 新增 `ompAdapter`/`codexAdapter`(规范化 toolevent + delta/status);默认适配器加 `toolevent` 透传 | 改 |
| `src/ui/tui/adapters.omp.mjs` | omp 工具事件 → 规范 `tool.start`/`tool.end`(独立文件,便于单测与演进) | 新建 |
| `src/ui/tui/adapters.codex.mjs` | codex 工具 item → 规范 `tool.end`(一次性完成态) | 新建 |
| `src/ui/tui/store.mjs` | 每会话加 `entries` 有序时间线 + `pushUser` + `toggleEntry`;tool 按 id upsert;P1 字段不破坏 | 改 |
| `src/ui/tui/components/ToolCard.mjs` | 单个工具调用卡(收起摘要 / 展开 args+diff+output) | 新建 |
| `src/ui/tui/components/FocusPane.mjs` | 正文从 `assistantText` 改渲 `entries` 时间线(含 ToolCard) | 改 |
| `src/ui/tui/app.mjs` | 键盘展开/折叠当前 tool 卡(`Ctrl-E`)+ 选中条目游标(`↑/↓`) | 改 |
| `src/ui/tui/index.mjs` | 启动时 `registerEventAdapter("omp"/"codex", …)`(进 TUI 才注册) | 改 |
| `src/cli.mjs` | TUI 分支:dispatchWrapped 在普通文本 dispatch **成功**后 `store.pushUser(label, text)` 回显 | 改 |
| `test/ui/tui/adapters.omp.test.mjs` / `adapters.codex.test.mjs` / `store.timeline.test.mjs` / `components.toolcard.test.mjs` / `backend.toolevent.test.mjs` | 各单测 | 新建 |

**P2 规范工具事件模型(store 消费):**
- `{kind:"tool.start", id, name, args, intent}` — args 为对象或字符串(原样);intent 可空。
- `{kind:"tool.end", id, ok, output, diff}` — output 为字符串(结果文本,可长);diff 可空(写类工具的统一 diff 文本)。
- codex 一次性完成:发 `tool.end` 且带 `name`/`args`(因 start/end 不分离),store 的 upsert 容许「先见 end」。

**store `entries` 条目形状:**
- `{type:"user", text}`
- `{type:"assistant", text}`(turn 内增量累积;遇 tool 后的新文本另起一条 assistant)
- `{type:"tool", id, name, args, intent, status:"running"|"done", ok, output, diff, expanded:false}`

---

## Task 1:backend 新增 `toolevent` 通道(omp + codex,不截断)

**目标:** OmpSession 把 `tool_execution_start`/`tool_execution_end` 顶层消息**原样**(不经 `compactEvent`)发到新 `toolevent` 通道;CodexSession 把 `item/completed` 里**非 agentMessage** 的工具 item(当前被剥 payload)**完整 item** 发到 `toolevent`。现有 `event` 通道与所有既有行为不变。

**Files:**
- Modify: `src/backend.mjs`
- Create: `test/backend.toolevent.test.mjs`

- [ ] **Step 1: 读现状定位锚点**

阅读 `src/backend.mjs`:OmpSession 的 `handleMessage`(约 line 651:`this.#applyEvent(message); this.#emit(compactEvent(message));`)与 CodexSession 的 `case "item/completed":`(约 line 1244-1265:构造 `{type:"item.completed", itemType, phase, id}` 主动剥 payload)。两个类都 `extends EventEmitter`,已有 `this.emit("event", …)`/`this.emit("delta", …)`/`this.emit("status", …)`。新增 `this.emit("toolevent", …)` 同理。

- [ ] **Step 2: 写失败测试**

```js
// test/backend.toolevent.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";

// 用最小桩验证「派发逻辑」:把待测的纯函数从 backend.mjs 导出后直接调。
// 见 Step 3:backend.mjs 导出 emitToolEventFromOmp / emitToolEventFromCodexItem 两个纯函数。
import { emitToolEventFromOmp, emitToolEventFromCodexItem } from "../src/backend.mjs";

test("omp tool_execution_start → toolevent 原样(不截断)", () => {
  const em = new EventEmitter(); const seen = [];
  em.on("toolevent", (e) => seen.push(e));
  const longArgs = { path: "x".repeat(500) };  // >300,验证不被截断
  const msg = { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: longArgs, intent: "读文件" };
  const handled = emitToolEventFromOmp(em, msg);
  assert.strictEqual(handled, true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0], msg);                  // 同一引用 = 未拷贝未截断
  assert.strictEqual(seen[0].args.path.length, 500); // 未截断
});

test("omp tool_execution_end → toolevent 原样", () => {
  const em = new EventEmitter(); const seen = [];
  em.on("toolevent", (e) => seen.push(e));
  const msg = { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "ok".repeat(400) }] } };
  assert.strictEqual(emitToolEventFromOmp(em, msg), true);
  assert.strictEqual(seen[0].result.content[0].text.length, 800);
});

test("omp 非工具消息 → 不发 toolevent,返回 false", () => {
  const em = new EventEmitter(); let n = 0;
  em.on("toolevent", () => n++);
  assert.strictEqual(emitToolEventFromOmp(em, { type: "message_update" }), false);
  assert.strictEqual(n, 0);
});

test("codex 工具 item → toolevent 带完整 item;agentMessage/未知类型 → 不发(allowlist)", () => {
  const em = new EventEmitter(); const seen = [];
  em.on("toolevent", (e) => seen.push(e));
  const toolItem = { type: "commandExecution", id: "c1", command: "ls", aggregatedOutput: "a".repeat(500) };
  assert.strictEqual(emitToolEventFromCodexItem(em, toolItem), true);
  assert.strictEqual(seen[0].item, toolItem);
  assert.strictEqual(emitToolEventFromCodexItem(em, { type: "agentMessage", text: "hi" }), false);
  assert.strictEqual(emitToolEventFromCodexItem(em, { type: "reasoning", text: "思考" }), false); // 非工具 item 不冒伪卡
  assert.strictEqual(seen.length, 1);
});
```

- [ ] **Step 3: 跑测试看失败** → `node --test test/backend.toolevent.test.mjs` → FAIL(未导出)

- [ ] **Step 4: 实现 — 两个纯函数 + 接线**

4a. 在 `backend.mjs` 顶层(helpers 区,`compactEvent` 附近)加并 `export` 两个纯派发函数(便于单测,且让两个类共用):

```js
// P2:把工具事件原样(不经 compactEvent 截断)发到 emitter 的 "toolevent" 通道。
// 返回是否命中工具事件(供调用方决定后续)。纯函数,便于单测。
export function emitToolEventFromOmp(emitter, message) {
  const t = message && message.type;
  if (t === "tool_execution_start" || t === "tool_execution_end") {
    emitter.emit("toolevent", message);   // 同一引用,不拷贝不截断
    return true;
  }
  return false;
}
// codex:仅「工具类」item 发 toolevent(allowlist),避免把 reasoning/todoList/agentMessage 等
// 非工具 item 误当工具卡。实施前用真实日志确认取值集合;未知/非工具类型保守地不发(返回 false)。
const CODEX_TOOL_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "patchApply", "webSearch"]);
export function emitToolEventFromCodexItem(emitter, item) {
  if (!item || !CODEX_TOOL_ITEM_TYPES.has(item.type)) return false;
  emitter.emit("toolevent", { type: "tool.item", item });
  return true;
}
```

4b. OmpSession `handleMessage`:在现有 `this.#emit(compactEvent(message));` **之前**加一行(不改原行):

```js
    this.#applyEvent(message);
    emitToolEventFromOmp(this, message);   // P2:工具事件另走 toolevent(完整),event 通道仍压缩
    this.#emit(compactEvent(message));
```

4c. CodexSession `case "item/completed":`:在构造最小事件**之前**(`item` 已取出后)加:

```js
        const item = params.item || {};
        emitToolEventFromCodexItem(this, item);   // P2:工具 item 完整发 toolevent;原最小 #emit 不动
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
          // …原逻辑不变…
        }
```

> **插入点必须在 staleTurn 早退之后(刻意):** `case "item/completed":` 顶部已有 `if (staleTurn) { this.#emit({type:"item.completed",stale:true}); return; }`。`emitToolEventFromCodexItem` 须插在该早退**之后**(即 `const item = params.item` 之后,见上),这样**旧 turn 的工具 item 不会发 toolevent**——这是刻意的,避免上一 turn 的尾包污染当前 TUI。**不要**把它前移到 staleTurn 检查之前。
>
> 说明:`toolevent` 仅在有人监听时有意义;EventEmitter 对无监听器的非 `error` 事件是 no-op,故对 agent-bridge / `--task` 等不接 toolevent 的消费者**零副作用**。

- [ ] **Step 5: 跑测试看通过 + 既有 backend 测试不回归**

Run: `node --test test/backend.toolevent.test.mjs` → PASS
Run: `node --test test/backend.contract.test.mjs --test-timeout=20000`(契约不回归;本机若 omp 真错误用例超时属既有环境现象,关注其余用例)

- [ ] **Step 6: Commit**

```bash
git add src/backend.mjs test/backend.toolevent.test.mjs
git commit -m "feat(backend): un-truncated toolevent channel for omp/codex (P2 task1)"
```

---

## Task 2:omp / codex 事件适配器(注册制)

**目标:** 用 P1 的注册制把后端事件规范化。omp 适配器消费 `toolevent`(start/end)+ delta/status;codex 适配器消费 `toolevent`(一次性 end)+ delta/status。未注册时仍回退 `defaultAdapter`(P1 行为)。

**Files:**
- Create: `src/ui/tui/adapters.omp.mjs`
- Create: `src/ui/tui/adapters.codex.mjs`
- Modify: `src/ui/tui/events.mjs`(`defaultAdapter` 增对 `toolevent` 通道返回 null;不改既有分支)
- Create: `test/ui/tui/adapters.omp.test.mjs`, `test/ui/tui/adapters.codex.test.mjs`

- [ ] **Step 1: 写失败测试(omp)**

```js
// test/ui/tui/adapters.omp.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { ompAdapter } from "../../../src/ui/tui/adapters.omp.mjs";

test("delta/status 与默认一致", () => {
  assert.deepStrictEqual(ompAdapter({ channel: "delta", payload: "hi" }), { kind: "message.delta", text: "hi" });
  assert.deepStrictEqual(ompAdapter({ channel: "status", payload: { status: "running", isStreaming: true } }),
    { kind: "status", status: "running", isStreaming: true });
});
test("toolevent tool_execution_start → tool.start", () => {
  const ev = ompAdapter({ channel: "toolevent", payload: { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: { path: "a" }, intent: "读" } });
  assert.deepStrictEqual(ev, { kind: "tool.start", id: "t1", name: "read_file", args: { path: "a" }, intent: "读" });
});
test("toolevent tool_execution_end → tool.end(取 result.content[].text 拼接)", () => {
  const ev = ompAdapter({ channel: "toolevent", payload: { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "line1" }, { text: "line2" }] } } });
  assert.strictEqual(ev.kind, "tool.end");
  assert.strictEqual(ev.id, "t1");
  assert.match(ev.output, /line1[\s\S]*line2/);
  assert.strictEqual(ev.ok, true);
});
test("event 通道(压缩流)P2 仍不消费 → null(工具走 toolevent)", () => {
  assert.strictEqual(ompAdapter({ channel: "event", payload: { type: "tool_execution_start" } }), null);
});
```

- [ ] **Step 2: 跑失败** → FAIL

- [ ] **Step 3: 实现 omp 适配器**

> **实施前先用真实日志核字段路径**(事件 shape 可能随 omp 版本微调):读最近一个 `~/.agent-bridge/logs/omp-*.log`,确认 `tool_execution_start` 顶层有 `toolCallId`/`toolName`/`args`/`intent`、`tool_execution_end` 有 `toolCallId` 与 `result.content[].text`。若字段名不同,以**真实日志为准**调整下方提取(测试同步改)。备忘:已于 2026-06-13 探针验证为上述路径。

```js
// src/ui/tui/adapters.omp.mjs — omp 事件适配器(注册到 events 注册表)。
// toolevent 走完整(未截断)工具消息;delta/status 同默认。
function ompText(result) {
  const parts = (result && Array.isArray(result.content) ? result.content : [])
    .map((c) => (c && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean);
  return parts.join("\n");
}
export function ompAdapter({ channel, payload }) {
  if (channel === "delta" && typeof payload === "string") return { kind: "message.delta", text: payload };
  if (channel === "status" && payload && typeof payload === "object")
    return { kind: "status", status: payload.status, isStreaming: Boolean(payload.isStreaming) };
  if (channel === "toolevent" && payload && typeof payload === "object") {
    if (payload.type === "tool_execution_start")
      return { kind: "tool.start", id: payload.toolCallId, name: payload.toolName, args: payload.args ?? null, intent: payload.intent ?? null };
    if (payload.type === "tool_execution_end")
      return { kind: "tool.end", id: payload.toolCallId, ok: payload.error == null, output: ompText(payload.result), diff: payload.diff ?? null };
  }
  return null; // event(压缩流)P2 不消费
}
```

- [ ] **Step 4: 跑通过(omp)** → PASS

- [ ] **Step 5: 写失败测试(codex)**

```js
// test/ui/tui/adapters.codex.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { codexAdapter } from "../../../src/ui/tui/adapters.codex.mjs";

test("delta/status 同默认", () => {
  assert.deepStrictEqual(codexAdapter({ channel: "delta", payload: "hi" }), { kind: "message.delta", text: "hi" });
});
test("toolevent tool.item(commandExecution)→ tool.end 一次性完成", () => {
  const item = { type: "commandExecution", id: "c1", command: "ls -la", aggregatedOutput: "total 0", status: "completed" };
  const ev = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item } });
  assert.strictEqual(ev.kind, "tool.end");
  assert.strictEqual(ev.id, "c1");
  assert.strictEqual(ev.name, "commandExecution");
  assert.match(ev.output, /total 0/);
  assert.strictEqual(ev.ok, true);
});
test("toolevent fileChange → 带 diff", () => {
  const item = { type: "fileChange", id: "f1", changes: [{ path: "a.js", diff: "@@ -1 +1 @@" }] };
  const ev = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item } });
  assert.strictEqual(ev.kind, "tool.end");
  assert.match(ev.diff, /@@ -1 \+1 @@/);
});
```

- [ ] **Step 6: 跑失败** → FAIL

- [ ] **Step 7: 实现 codex 适配器**

> **实施前用真实日志核字段**:读最近 `~/.agent-bridge/logs/*codex*` 或经 agent-bridge 跑一次带工具调用的 codex turn,确认 `item.type` 的取值集合(如 `commandExecution`/`fileChange`/`mcpToolCall`)与各自 payload 字段(命令/输出/diff)。下方按常见形状提取,缺字段时优雅降级(不抛)。

```js
// src/ui/tui/adapters.codex.mjs — codex 事件适配器。
// codex 工具 item 是「一次性完成」,故规范成 tool.end(带 name/args 供 store 直接成卡)。
function codexOutput(item) {
  if (typeof item.aggregatedOutput === "string") return item.aggregatedOutput;
  if (typeof item.output === "string") return item.output;
  if (typeof item.text === "string") return item.text;
  return "";
}
function codexDiff(item) {
  if (Array.isArray(item.changes))
    return item.changes.map((c) => (c && c.diff) ? c.diff : `${c?.path ?? ""}`).filter(Boolean).join("\n");
  if (typeof item.diff === "string") return item.diff;
  return null;
}
export function codexAdapter({ channel, payload }) {
  if (channel === "delta" && typeof payload === "string") return { kind: "message.delta", text: payload };
  if (channel === "status" && payload && typeof payload === "object")
    return { kind: "status", status: payload.status, isStreaming: Boolean(payload.isStreaming) };
  if (channel === "toolevent" && payload && payload.type === "tool.item" && payload.item) {
    const item = payload.item;
    const out = codexOutput(item);
    return {
      // id 优先 item.id/callId;**都无时返回 null**——store 对 null id 不 upsert、直接追加一张已完成卡
      // (比"类型+前缀"回退更保守:fileChange 这类 out 空、无 command 的 item 不会塌成同一 id 误合并)。
      kind: "tool.end", id: item.id ?? item.callId ?? null, name: item.type,
      args: item.command ?? item.arguments ?? null,
      ok: item.status ? item.status === "completed" : true,
      output: out, diff: codexDiff(item),
    };
  }
  return null;
}
```

> 注:codex 卡的 `id` 优先 `item.id`/`item.callId`;**都无时为 `null`**——store 的 tool.end 分支对 `ev.id == null` 跳过 upsert、直接追加一张已完成卡(见 Task3 `apply`:`ev.id != null ? find : null`),避免不同 item 因回退 id 相同而误合并。codex item 通常带 `item.id`(backend `item/completed` 已透出),null 仅兜底。

- [ ] **Step 8: events.mjs 的 defaultAdapter 加 toolevent → null(显式)**

改 `defaultAdapter` 末尾注释并确保 `toolevent` 通道返回 null(当前 `return null` 已覆盖,补一行显式分支增强可读性即可,不改语义):

```js
  if (channel === "toolevent") return null; // 默认不消费工具事件;由 omp/codex 适配器接管
  return null;
```

并加一个 **test-only** 重置(注册表是模块级全局;`node --test` 默认按文件进程隔离,故跨文件不污染,但同文件多用例或 `--test-isolation=none` 时需要可清):

```js
export function resetEventAdapters() { _adapters.clear(); }   // 仅供测试隔离用
```

> 测试纪律:Task3/Task6 的 timeline/app 测试在文件顶部 `registerEventAdapter("omp", ompAdapter)` 自备所需适配器。注意 ompAdapter 的 delta/status 行为与 `defaultAdapter` **完全一致**,故即便注册了 "omp",P1 的 `store.test.mjs`(另一进程、用默认)也不受影响。需要干净起点的用例可先 `resetEventAdapters()`。

- [ ] **Step 9: 跑全部新适配器测试通过 + events 既有测试不回归**

Run: `node --test test/ui/tui/adapters.omp.test.mjs test/ui/tui/adapters.codex.test.mjs test/ui/tui/events.test.mjs` → PASS

- [ ] **Step 10: Commit**

```bash
git add src/ui/tui/adapters.omp.mjs src/ui/tui/adapters.codex.mjs src/ui/tui/events.mjs test/ui/tui/adapters.omp.test.mjs test/ui/tui/adapters.codex.test.mjs
git commit -m "feat(tui): omp/codex event adapters incl tool.start/tool.end (P2 task2)"
```

---

## Task 3:store 有序时间线(entries + 用户回显 + 工具 upsert + 展开态)

**目标:** 每会话新增 `entries` 有序时间线;`apply` 处理新规范事件(message.delta→末尾 assistant 条增量、tool.start→新 tool 条、tool.end→按 id upsert);新增 `pushUser(label,text)`、`toggleEntry(label,index)`。**P1 字段(assistantText/lastLine/status/turn/ms)继续维护**(AgentRail 仍依赖)。

**Files:**
- Modify: `src/ui/tui/store.mjs`
- Create: `test/ui/tui/store.timeline.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/store.timeline.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { registerEventAdapter } from "../../../src/ui/tui/events.mjs";
import { ompAdapter } from "../../../src/ui/tui/adapters.omp.mjs";

registerEventAdapter("omp", ompAdapter);   // 用真 omp 适配器驱动 toolevent

const sess = () => new EventEmitter();

test("assistant 增量进 entries;遇 tool 后文本另起 assistant 条", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "前段");
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: { path: "a" } });
  s.emit("delta", "后段");
  const e = store.getState().sessions["omp#1"].entries;
  assert.deepStrictEqual(e.map((x) => x.type), ["assistant", "tool", "assistant"]);
  assert.strictEqual(e[0].text, "前段");
  assert.strictEqual(e[1].name, "read_file");
  assert.strictEqual(e[1].status, "running");
  assert.strictEqual(e[2].text, "后段");
});

test("tool.end 按 id upsert 同一张卡为 done + output", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  s.emit("toolevent", { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "done-out" }] } });
  const tools = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "tool");
  assert.strictEqual(tools.length, 1);            // upsert 不新增
  assert.strictEqual(tools[0].status, "done");
  assert.match(tools[0].output, /done-out/);
});

test("只见 tool.end(codex 一次性)也成一张 done 卡", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});   // 用 ompAdapter,但直接灌 end 验证 upsert 新建
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_end", toolCallId: "z9", result: { content: [{ text: "x" }] } });
  const tools = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "tool");
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].status, "done");
});

test("tool.end 无 id(undefined/null)→ 不 upsert,各自追加一张卡(codex 无 id 回退的回归保护)", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  // 无 toolCallId → ompAdapter 产出 id:undefined → store `ev.id != null` 为 false → 不合并,各追加一张
  s.emit("toolevent", { type: "tool_execution_end", result: { content: [{ text: "out1" }] } });
  s.emit("toolevent", { type: "tool_execution_end", result: { content: [{ text: "out2" }] } });
  const tools = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "tool");
  assert.strictEqual(tools.length, 2);
});

test("pushUser 在时间线追加 user 条;P1 assistantText 仍随 delta 维护", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  store.pushUser("omp#1", "给它加测试");
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "好的");
  const sObj = store.getState().sessions["omp#1"];
  assert.strictEqual(sObj.entries[0].type, "user");
  assert.strictEqual(sObj.entries[0].text, "给它加测试");
  assert.match(sObj.assistantText, /好的/);     // P1 字段不破坏(AgentRail 依赖)
  assert.strictEqual(sObj.lastLine, "好的");
});

test("toggleEntry 翻转某条 expanded;subscribe 收到通知", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  let hits = 0; store.subscribe(() => hits++);
  const idx = store.getState().sessions["omp#1"].entries.findIndex((x) => x.type === "tool");
  store.toggleEntry("omp#1", idx);
  assert.strictEqual(store.getState().sessions["omp#1"].entries[idx].expanded, true);
  assert.ok(hits >= 1);
});

test("新 turn(running)不清空既有 entries(完整 timeline)", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "turn1");
  s.emit("status", { status: "idle", isStreaming: false });
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "turn2");
  const e = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "assistant");
  assert.strictEqual(e.length, 2);                // 两个 turn 两条 assistant,旧的不清
  assert.strictEqual(e[0].text, "turn1");
  assert.strictEqual(e[1].text, "turn2");
});
```

- [ ] **Step 2: 跑失败** → FAIL

- [ ] **Step 3: 实现 — 改 `store.mjs`**

3a. `ensure(label)` 的初始对象增加 `entries: []`(保留所有 P1 字段):

```js
      state.sessions[label] = {
        agent: "", model: null, effort: null, status: "idle", isStreaming: false,
        turn: 0, assistantText: "", lastLine: "", turnStartAt: null, ms: null,
        entries: [], _newAsst: false,     // P2:有序时间线 + 新-assistant-条 标志(turn 边界)
      };
```

3b. 加常量与时间线辅助(文件顶部 `MAX_SYSTEM` 旁):

```js
const MAX_ENTRIES = 300;   // 时间线条目上限,防内存无界
```

3c. 改 `apply(label, ev)`:在原有 status/message.delta 分支基础上,**追加** entries 维护与 tool 分支。完整替换 `apply`:

```js
  function trimEntries(s) { while (s.entries.length > MAX_ENTRIES) s.entries.shift(); }
  function apply(label, ev) {
    if (!ev) return;
    const s = ensure(label);
    if (ev.kind === "status") {
      s.status = ev.status; s.isStreaming = ev.isStreaming;
      if (ev.status === "running") { s.assistantText = ""; s.lastLine = ""; s.turnStartAt = Date.now(); s._newAsst = true; }
      else if (ev.status === "idle") {
        s.turn += 1;
        if (s.turnStartAt != null) { s.ms = Date.now() - s.turnStartAt; s.turnStartAt = null; }
      }
    } else if (ev.kind === "message.delta") {
      // P1 字段(AgentRail 依赖)
      s.assistantText += ev.text;
      const nl = s.assistantText.lastIndexOf("\n");
      s.lastLine = nl === -1 ? s.assistantText : s.assistantText.slice(nl + 1);
      // P2 时间线:同一 turn 内追加到末条 assistant;新 turn(running 后首段,_newAsst)或遇 tool 后另起一条。
      const last = s.entries[s.entries.length - 1];
      if (!s._newAsst && last && last.type === "assistant") last.text += ev.text;
      else { s.entries.push({ type: "assistant", text: ev.text }); s._newAsst = false; trimEntries(s); }
    } else if (ev.kind === "tool.start") {
      s.entries.push({ type: "tool", id: ev.id, name: ev.name, args: ev.args ?? null,
        intent: ev.intent ?? null, status: "running", ok: null, output: "", diff: null, expanded: false });
      trimEntries(s);
    } else if (ev.kind === "tool.end") {
      let card = ev.id != null ? s.entries.find((x) => x.type === "tool" && x.id === ev.id) : null;
      if (!card) {  // 只见 end(codex 一次性 / 漏 start):新建一张已完成卡
        card = { type: "tool", id: ev.id, name: ev.name ?? "tool", args: ev.args ?? null,
          intent: null, status: "done", ok: null, output: "", diff: null, expanded: false };
        s.entries.push(card); trimEntries(s);
      }
      card.status = "done"; card.ok = ev.ok ?? null;
      if (ev.output) card.output = ev.output;
      if (ev.diff) card.diff = ev.diff;
      if (ev.name && card.name === "tool") card.name = ev.name;
    }
    notify();
  }
```

3d. `attachSession` 加订阅 `toolevent` 通道(其余订阅不变):

```js
      session.on("toolevent", (e) => apply(label, normalize({ channel: "toolevent", payload: e, agent })));
```

3e. 返回对象新增两个方法(与既有方法并列):

```js
    pushUser(label, text) { const s = ensure(label); s.entries.push({ type: "user", text }); trimEntries(s); notify(); },
    toggleEntry(label, index) {
      const s = state.sessions[label];
      if (s && s.entries[index] && s.entries[index].type === "tool") { s.entries[index].expanded = !s.entries[index].expanded; notify(); }
    },
```

- [ ] **Step 4: 跑通过 + P1 store 测试不回归**

Run: `node --test test/ui/tui/store.timeline.test.mjs test/ui/tui/store.test.mjs` → PASS（P1 的 6 个 store 测试须仍绿)

> AgentRail 只读 `lastLine`/`assistantText`/`status`/`turn`/`ms`——本任务全部继续维护这些字段(`entries` 是**新增**,不替换),故 AgentRail/P1 components 测试不受影响(Task5 跑 components.test.mjs 时复核)。

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/store.mjs test/ui/tui/store.timeline.test.mjs
git commit -m "feat(tui): ordered timeline entries (assistant/tool/user) + tool upsert (P2 task3)"
```

---

## Task 4:ToolCard 组件

**目标:** 渲染单张工具卡。收起:`▸ name(args 摘要) · 状态`;展开:多显 args(紧凑)、diff(有则)、output(截断到合理行数,带「…」提示)。

**Files:**
- Create: `src/ui/tui/components/ToolCard.mjs`
- Create: `test/ui/tui/components.toolcard.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/ui/tui/components.toolcard.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { ToolCard } from "../../../src/ui/tui/components/ToolCard.mjs";

const running = { type: "tool", id: "t1", name: "read_file", args: { path: "src/a.js" }, status: "running", output: "", diff: null, expanded: false };
const done = { type: "tool", id: "t2", name: "bash", args: { cmd: "ls" }, status: "done", ok: true, output: "file1\nfile2\nfile3", diff: null, expanded: false };

test("收起:显名称 + 状态符,不显 output", () => {
  const f = render(html`<${ToolCard} entry=${running} selected=${false} />`).lastFrame();
  assert.match(f, /read_file/);
  assert.match(f, /▸/);
});
test("展开:显 output 明细", () => {
  const f = render(html`<${ToolCard} entry=${{ ...done, expanded: true }} selected=${false} />`).lastFrame();
  assert.match(f, /▾/);
  assert.match(f, /file1/);
  assert.match(f, /file2/);
});
test("收起态不含 output 文本", () => {
  const f = render(html`<${ToolCard} entry=${done} selected=${false} />`).lastFrame();
  assert.ok(!f.includes("file2"));
});
test("selected 高亮不报错", () => {
  assert.doesNotThrow(() => render(html`<${ToolCard} entry=${done} selected=${true} />`));
});
test("args 为字符串(codex command)也能渲染", () => {
  const f = render(html`<${ToolCard} entry=${{ type:"tool", id:"c1", name:"commandExecution", args:"ls -la", status:"done", ok:true, output:"", diff:null, expanded:true }} selected=${false} />`).lastFrame();
  assert.match(f, /ls -la/);
});
```

- [ ] **Step 2: 跑失败** → FAIL

- [ ] **Step 3: 实现**

```js
// src/ui/tui/components/ToolCard.mjs — 工具调用卡:收起摘要 / 展开 args+diff+output。
import { Box, Text } from "ink";
import { html } from "../html.mjs";

const MAX_OUT_LINES = 12;

function argsSummary(args) {
  if (args == null) return "";
  if (typeof args === "string") return args.length > 48 ? args.slice(0, 48) + "…" : args;
  try {
    const s = JSON.stringify(args);
    return s.length > 48 ? s.slice(0, 48) + "…" : s;
  } catch { return ""; }
}
function clampLines(text, n) {
  const lines = String(text || "").split("\n");
  if (lines.length <= n) return { body: lines.join("\n"), more: 0 };
  return { body: lines.slice(0, n).join("\n"), more: lines.length - n };
}

export function ToolCard({ entry, selected }) {
  const mark = entry.expanded ? "▾" : "▸";
  const statusColor = entry.status === "running" ? "yellow" : (entry.ok === false ? "red" : "green");
  const statusText = entry.status === "running" ? "running" : (entry.ok === false ? "failed" : "done");
  const head = html`<${Text} wrap="truncate-end" color=${selected ? "blue" : undefined} bold=${selected}>
    ${mark} 🔧 <${Text} bold>${entry.name}<//>${argsSummary(entry.args) ? html`<${Text} dimColor>(${argsSummary(entry.args)})<//>` : null} <${Text} color=${statusColor}>· ${statusText}<//><//>`;
  if (!entry.expanded) return html`<${Box} paddingX=${1}>${head}<//>`;
  const out = clampLines(entry.output, MAX_OUT_LINES);
  return html`<${Box} flexDirection="column" paddingX=${1} borderStyle="round" borderColor=${selected ? "blue" : "gray"}>
    ${head}
    ${entry.args != null ? html`<${Text} dimColor wrap="truncate-end">args: ${typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args)}<//>` : null}
    ${entry.diff ? html`<${Box} flexDirection="column"><${Text} color="cyan">diff:<//><${Text}>${entry.diff}<//><//>` : null}
    ${entry.output ? html`<${Box} flexDirection="column"><${Text} dimColor>output:<//><${Text}>${out.body}<//>${out.more ? html`<${Text} dimColor>… (+${out.more} 行)<//>` : null}<//>` : null}
  <//>`;
}
```

- [ ] **Step 4: 跑通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/components/ToolCard.mjs test/ui/tui/components.toolcard.test.mjs
git commit -m "feat(tui): ToolCard component (collapsed summary / expanded args+diff+output) (P2 task4)"
```

---

## Task 5:FocusPane 改渲时间线

**目标:** 焦点区正文从「只渲 `assistantText`」改为**渲 `entries` 时间线**:user 条灰显前缀、assistant 条原样、tool 条用 `ToolCard`。流式光标仍跟最后一条 assistant。`selectedIndex`(P2 Task6 注入)高亮当前选中的 tool 卡。**头部 B/E 元信息、C/D 折叠条不变;无 sess 提示不变。**

**Files:**
- Modify: `src/ui/tui/components/FocusPane.mjs`
- Modify: `test/ui/tui/components.test.mjs`(更新 FocusPane 正文断言为「渲 entries」)

- [ ] **Step 1: 改/加失败测试**(在 `test/ui/tui/components.test.mjs` 追加;原 FocusPane 用例若断言 `assistantText` 正文,改为基于 `entries`)

```js
// 追加到 test/ui/tui/components.test.mjs
test("FocusPane 渲 entries 时间线:user/assistant/tool 混排", () => {
  const sess = {
    agent: "omp", model: "m", effort: null, status: "running", isStreaming: true, turn: 1, ms: null,
    assistantText: "尾", lastLine: "尾",
    entries: [
      { type: "user", text: "做点事" },
      { type: "assistant", text: "好的,我先读文件" },
      { type: "tool", id: "t1", name: "read_file", args: { path: "a" }, status: "done", ok: true, output: "x", diff: null, expanded: false },
      { type: "assistant", text: "读完了" },
    ],
  };
  const f = render(html`<${FocusPane} label="omp#1" sess=${sess} fence=${null} relays=${[]} selectedIndex=${-1} />`).lastFrame();
  assert.match(f, /做点事/);          // user
  assert.match(f, /我先读文件/);       // assistant
  assert.match(f, /read_file/);        // tool 卡
  assert.match(f, /读完了/);           // 第二段 assistant
});
```

> 同时**修正**原 `components.test.mjs` 里 `FocusPane 头部含 model/turn,正文含 assistantText` 用例:该用例的 sess 现在需带 `entries`(用 assistantText 文本放进一条 assistant entry),断言正文文本来自 entries。无 sess 的提示用例不变。

- [ ] **Step 2: 跑失败** → FAIL

- [ ] **Step 3: 实现 — 改 FocusPane 正文区**

把 FocusPane 中部「正文区」(原 `<${Text}>${sess.assistantText||""}${sess.isStreaming?"▌":""}<//>`)替换为渲 entries:

```js
import { ToolCard } from "./ToolCard.mjs";
// …组件签名加 selectedIndex = -1:
export function FocusPane({ label, sess, fence, relays, expandC = false, expandD = false, selectedIndex = -1 }) {
  // …前面 meta/out/inn/cSummary/dSummary 不变…
  const entries = Array.isArray(sess.entries) ? sess.entries : [];
  const lastAsstIdx = (() => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "assistant") return i; return -1; })();
  const body = html`<${Box} flexGrow=${1} flexDirection="column" paddingX=${1}>
    ${entries.length === 0 ? html`<${Text} dimColor>(本会话暂无内容)<//>` : entries.map((e, i) => {
      if (e.type === "user") return html`<${Text} key=${i} color="green">❯ ${e.text}<//>`;
      if (e.type === "tool") return html`<${ToolCard} key=${i} entry=${e} selected=${i === selectedIndex} />`;
      return html`<${Text} key=${i}>${e.text}${(sess.isStreaming && i === lastAsstIdx) ? "▌" : ""}<//>`;
    })}
  <//>`;
```

并把原正文 `<${Box}>` 整块换成 `${body}`(头部 B/E 与 C/D 折叠条保留)。

- [ ] **Step 4: 跑通过 + 组件既有测试不回归**

Run: `node --test test/ui/tui/components.test.mjs` → PASS（含更新后的 FocusPane 用例 + 其余组件原用例)

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/components/FocusPane.mjs test/ui/tui/components.test.mjs
git commit -m "feat(tui): FocusPane renders ordered timeline with ToolCards (P2 task5)"
```

---

## Task 6:App / index / cli 接线(注册适配器 + 用户回显 + 键盘展开)

**目标:** ① 进 TUI 时注册 omp/codex 适配器;② cli 在普通文本 dispatch **成功**后 `store.pushUser(label, text)` 回显;③ App **内部**维护「选中条目游标」`selIdx`(`↑/↓` 在 tool 条间跳)与 `Ctrl-E`,直接调 `store.toggleEntry(label,index)`(store 在 App props 里,**不另加** onToggle 回调);FocusPane 传 `selectedIndex`。

**Files:**
- Modify: `src/ui/tui/index.mjs`(注册适配器)
- Modify: `src/ui/tui/app.mjs`(选中游标 + Ctrl-E + 传 selectedIndex)
- Modify: `src/cli.mjs`(TUI 分支:dispatchWrapped 里 pushUser;App 已通过 store 取 toggle,无需额外 props——见下)
- Modify: `test/ui/tui/app.test.mjs`(新增 Ctrl-E/箭头交互断言)

- [ ] **Step 1: 写失败测试(App 交互)**

```js
// 追加到 test/ui/tui/app.test.mjs
test("Ctrl-E 切换当前选中 tool 卡的 expanded(经 store.toggleEntry)", async () => {
  const store = createStore();
  const s = new EventEmitter();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  // 需先注册 omp 适配器以解析 toolevent:
  const props = { ...base(store) };
  const { stdin } = render(html`<${App} ...${props} />`);
  // 选中游标默认指向最后一条 tool;按 Ctrl-E 展开
  stdin.write("\x05");  // Ctrl-E
  await new Promise((r) => setTimeout(r, 20));
  const tool = store.getState().sessions["omp#1"].entries.find((x) => x.type === "tool");
  assert.strictEqual(tool.expanded, true);
});
```

> 该测试顶部需 `import { registerEventAdapter } from ".../events.mjs"` 与 `import { ompAdapter } from ".../adapters.omp.mjs"` 并 `registerEventAdapter("omp", ompAdapter)`,否则 toolevent 不被解析成 tool 条。

- [ ] **Step 2: 跑失败** → FAIL

- [ ] **Step 3: 实现**

3a. `src/ui/tui/index.mjs` 的 `startTui` 开头(动态 import 后)注册适配器:

```js
  const { registerEventAdapter } = await import("./events.mjs");
  const { ompAdapter } = await import("./adapters.omp.mjs");
  const { codexAdapter } = await import("./adapters.codex.mjs");
  registerEventAdapter("omp", ompAdapter);
  registerEventAdapter("codex", codexAdapter);
```

3b. `src/ui/tui/app.mjs`:增加选中游标 state + Ctrl-E + ↑/↓,传 `selectedIndex` 给 FocusPane。App 直接用 `store.toggleEntry`(store 在 props 里)。在 `useInput` 内加(置于 return 之前的按键分支):

```js
  const [selIdx, setSelIdx] = useState(-1);
  // selIdx 是「当前会话 entries 的下标」,切焦点/会话即失效 → 重置(防 Ctrl-E 误折叠另一会话同下标卡)。
  useEffect(() => { setSelIdx(-1); }, [st.focusLabel]);
  // …在 useInput 里:
    if (key.ctrl && input === "e") {
      const st2 = store.getState();
      const ent = (st2.sessions[st2.focusLabel]?.entries) || [];
      // 用前校验 selIdx 仍指向一张 tool 卡;否则回退到当前会话最后一张 tool。
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
```

并把 FocusPane 调用加 `selectedIndex=${selIdx}`。

> 注意:`↑/↓` 在 P1 未被占用(P1 useInput 只处理 Ctrl-C/Tab/Enter/Backspace/Ctrl-O/Ctrl-W/普通字符)。新增分支须放在「普通字符累加」**之前** return,避免方向键转义被当文本输入。

3c. `src/cli.mjs` TUI 分支:`dispatchWrapped` 在发出**人类**消息后回显 user 条目(仅当不是斜杠/@命令的纯文本时——回显发给当前会话的内容)。最小实现:在 `dispatchWrapped` 里,对不以 `/`、`@`、`$` 开头的行,`store.pushUser(smTui.currentLabel, line)`:

```js
    const dispatchWrapped = (line, opts) => {
      const source = opts?.source ?? "human";   // createReplDispatch 默认 human;不传 opts 也算 human(否则漏回显)
      const label = smTui.currentLabel;          // dispatch 前捕获目标 label(dispatch 期间 currentLabel 可能变)
      const r = dispatchTui(line, opts);
      // 仅当普通文本「真的 enqueue 成功」才回显:普通文本成功返回 {redraw:false},失败(无会话/忙)
      // 返回 {redraw:true}(见 repl-dispatch.mjs:230-232)。斜杠/@/$ 是命令不回显。普通文本同步返回(非 Promise)。
      if (source === "human" && label && !/^[/@$]/.test(line) && r?.redraw === false) store.pushUser(label, line);
      Promise.resolve(r).finally?.(syncFocus); syncFocus(); return r;
    };
```

> 说明:斜杠/@/$ 是命令,不算「发给 agent 的话」,不回显;普通文本即发往当前会话的消息,回显成 user 条。

- [ ] **Step 4: 跑通过 + 既有 app/UI/cli 测试不回归**

Run: `node --test test/ui/tui/app.test.mjs test/ui/tui/components.test.mjs test/cli.tui-gate.test.mjs` → PASS

- [ ] **Step 5: 手动冒烟(真 TTY)**

`node src/cli.mjs` → 给 omp 发「读一下 README 第一段」类带工具调用的指令 → 焦点区出现 🔧 工具卡(running→done);`↑/↓` 选卡、`Ctrl-E` 展开看 args/output;用户消息以 `❯` 回显在时间线;codex 同理(`/open --agent codex`)。

- [ ] **Step 6: 全量受影响测试 + Commit**

Run: `node --test test/ui/tui/*.test.mjs test/cli.tui-gate.test.mjs test/backend.toolevent.test.mjs`
Expected: PASS

```bash
git add src/ui/tui/index.mjs src/ui/tui/app.mjs src/cli.mjs test/ui/tui/app.test.mjs
git commit -m "feat(tui): wire adapters + user echo + keyboard tool-card expand (P2 task6)"
```

---

## 后续(不在本计划,各自单列)

- **C「编排意图」真实数据**:P1 已留 `store.setFence(label,data)` 钩子(FocusPane 的 C 折叠条已会渲 `fence.commands`)。只差 cli 把 control-wire 的 per-label fence(命令 + 回喂结果)喂进 `setFence`。小改,但需先确认 control-wire 是否按 label 暴露 fence 数据;单列一个小计划。
- **flow 在 TUI 内 approve/question**:独立子系统——P1 的 TUI 不接 input-router 的 `claim`/flow io。要让 `/flow` 的审批/提问在全屏内完成,需把 flow 的 approve()/question() 重路由到 TUI 的输入栏(而非 readline)。涉及面较大,单列。
- **`$` shell 命令**:P1 已识别 `$` 前缀不触发;语义(在哪执行、输出去向、安全边界)需先定,用户本期已搁置。

---

## 自检(对照 spec §5/§7/§10 + P1 留门)

- **spec 覆盖**:工具调用渲染成可展开卡(Task4 ToolCard ✓)、点击/键展开看 args/diff/output(Task6 Ctrl-E + Task4 展开态 ✓)、内容前端渲染成对应工具显示(Task2 适配器 + Task5 FocusPane ✓)、完整有序 timeline + 用户回显(Task3 entries + pushUser ✓)、omp/codex 注册制适配器(Task2 ✓)、不被 compactEvent 截断的原始通道(Task1 toolevent ✓)。C 真实数据/flow approve/$ 明确单列(见上)。
- **加法不破坏 P1**:backend 现有 `event`/`delta`/`status` 通道与 agent-bridge/`--task` 路径不变(toolevent 是新增、无监听器即 no-op);store 的 P1 字段(assistantText/lastLine/status/turn/ms)继续维护,AgentRail/P1 组件测试须仍绿;events 默认适配器回退不变。
- **占位扫描**:无 TODO/TBD;每步含可运行代码与命令;事件字段提取在 Task2 标注「实施前用真实日志核对」并给已验证的默认路径(非占位,是抗漂移的校验步)。
- **类型一致**:规范事件 `tool.start{id,name,args,intent}`/`tool.end{id,ok,output,diff,name?}` 在 adapters(产出)、store.apply(消费 upsert)、ToolCard(`entry.{name,args,status,ok,output,diff,expanded}`)、FocusPane(按 `entry.type` 分发)四处一致;`store.toggleEntry(label,index)`/`pushUser(label,text)` 在 app/cli 调用与 store 定义一致;`selectedIndex` 在 app→FocusPane 一致。

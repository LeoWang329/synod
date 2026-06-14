# C「编排意图」接真实数据 + C/D 折叠条展开键 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TUI 焦点区「C 编排意图」从永远的空「—」变成真显示某 agent 通过控制 fence 编排别人(`/open`/`/relay`/`@`)发的命令 + 各自结果(按会话累积),并加 Ctrl-G/Ctrl-T 展开 C/D 折叠条 + 未读 hot 高亮。

**Architecture:** 纯加法。control-wire 的 `onTurnComplete` 已算出 fence 命令+结果,只差暴露:给 `wireControl` 加可选 UI 无关回调 `onFence(label,{commands,feedbackSent})`,cli 的 TUI 分支接 `onFence → store.appendFence`(累积+trim+置未读)。app 加 Ctrl-G/Ctrl-T 展开 C/D 并在展开 C 时 `markFenceSeen` 清 hot。FocusPane 的 C/D 渲染契约 P1 已具备,不改。

**Tech Stack:** Node 20+ ESM,Ink 6 + htm,`node:test`,ink-testing-library。配套 spec:`docs/superpowers/specs/2026-06-14-tui-c-orchestration-intent-design.md`。

---

## 文件结构

| 文件 | 职责 | 新建/改 |
|---|---|---|
| `src/control-wire.mjs` | `wireControl` 加可选 `onFence`;`onTurnComplete` 构造结构化 `commands` + 真实 `feedbackSent`,fence task 末 emit | 改 |
| `src/ui/tui/store.mjs` | `appendFence`(累积+trim+seen=false)+ `markFenceSeen`;`dropSession` 删 `fences[label]` | 改 |
| `src/cli.mjs` | TUI 分支 `wireControl({…, onFence: (l,f)=>store.appendFence(l,f) })` | 改 |
| `src/ui/tui/app.mjs` | `expandC/expandD` state + Ctrl-G/Ctrl-T + 传 FocusPane + 展开 C 清 seen | 改 |
| `scripts/smoke-tui.mjs` | 扩冒烟:appendFence→C 摘要/未读,Ctrl-G 展开读明细+清 hot,Ctrl-T 展开 D | 改 |
| `test/control-wire.test.mjs` | onFence 被调 / commands shape / feedbackSent / 不传不炸 / 无 fence 不调 | 改 |
| `test/ui/tui/store.fence.test.mjs` | appendFence 累积+trim+seen / markFenceSeen / dropSession 清 fence | 新建 |
| `test/ui/tui/app.test.mjs` | Ctrl-G 展开 C+清 seen、Ctrl-T 展开 D | 改 |

**规范数据模型(三处一致):** `onFence(label, fence)` 的 `fence = { commands:[{cmd:string, result:string}], feedbackSent:boolean }`。store 累积后 `fences[label] = { commands:[{cmd,result}]…累积, feedbackSent, seen:boolean }`。FocusPane 读 `{commands:[{cmd,result}], feedbackSent, seen}`(P1 既有,不改)。

---

## Task 1: control-wire 加 `onFence` 回调(+结构化 commands + 真实 feedbackSent)

**Files:**
- Modify: `src/control-wire.mjs`(`wireControl` 签名 + `onTurnComplete` fence task)
- Modify: `test/control-wire.test.mjs`

- [ ] **Step 1: 写失败测试**(追加到 `test/control-wire.test.mjs` 末尾,沿用文件顶部的 `fakeSm`/`fakeRegistry`/`fakeDispatch`/`captureStream`)

```js
describe("wireControl onFence (C 编排意图数据)", () => {
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };

  it("fence turn → onFence(label, {commands:[{cmd,result}], feedbackSent:true})", async () => {
    const sm = fakeSm({ _sessions: [["omp#1", {}]] });
    const seen = [];
    const dispatch = fakeDispatch({ "/open --agent codex|0": { ok: true, label: "codex#1" } });
    const { onTurnComplete } = wireControl({
      sm, registry: fakeRegistry(), stderr: captureStream(), dispatch,
      onFence: (label, fence) => seen.push({ label, fence }),
    });
    await onTurnComplete("omp#1", { text: "```synod\n/open --agent codex\n```" });
    await flush();
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].label, "omp#1");
    assert.deepStrictEqual(seen[0].fence.commands, [{ cmd: "/open --agent codex", result: "ok · session codex#1" }]);
    assert.strictEqual(seen[0].fence.feedbackSent, true);
  });

  it("feedbackSent=false when originator gone (enqueue returns false)", async () => {
    const sm = fakeSm({ _sessions: [["omp#1", {}]], enqueueResult: false });
    const seen = [];
    const dispatch = fakeDispatch({ "/open --agent codex|0": { ok: true, label: "codex#1" } });
    const { onTurnComplete } = wireControl({
      sm, registry: fakeRegistry(), stderr: captureStream(), dispatch,
      onFence: (label, fence) => seen.push(fence),
    });
    await onTurnComplete("omp#1", { text: "```synod\n/open --agent codex\n```" });
    await flush();
    assert.strictEqual(seen[0].feedbackSent, false);
  });

  it("rejected command → result 带 error reason", async () => {
    const sm = fakeSm({ _sessions: [["omp#1", {}]] });
    const seen = [];
    const dispatch = fakeDispatch({ "/open --write|0": { ok: false, reason: "write denied" } });
    const { onTurnComplete } = wireControl({
      sm, registry: fakeRegistry(), stderr: captureStream(), dispatch,
      onFence: (label, fence) => seen.push(fence),
    });
    await onTurnComplete("omp#1", { text: "```synod\n/open --write\n```" });
    await flush();
    assert.deepStrictEqual(seen[0].commands, [{ cmd: "/open --write", result: "error: write denied" }]);
  });

  it("不传 onFence → fence turn 不抛", async () => {
    const sm = fakeSm({ _sessions: [["omp#1", {}]] });
    const { onTurnComplete } = wireControl({
      sm, registry: fakeRegistry(), stderr: captureStream(), dispatch: fakeDispatch(),
    });
    await assert.doesNotReject(async () => {
      await onTurnComplete("omp#1", { text: "```synod\n/open --agent omp\n```" });
      await flush();
    });
  });

  it("fence-less turn → onFence 不被调", async () => {
    const seen = [];
    const sm = fakeSm({ _sessions: [["omp#1", {}]] });
    const { onTurnComplete } = wireControl({
      sm, registry: fakeRegistry(), stderr: captureStream(), dispatch: fakeDispatch(),
      onFence: () => seen.push(1),
    });
    await onTurnComplete("omp#1", { text: "just prose" });
    await flush();
    assert.strictEqual(seen.length, 0);
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `node --test test/control-wire.test.mjs`
Expected: 新 describe 块 FAIL(onFence 未被调 / commands undefined)。原有用例仍 PASS。

- [ ] **Step 3: 实现 — 改 `wireControl` 签名 + `onTurnComplete` fence task**

3a. 签名加 `onFence`(默认 no-op),`src/control-wire.mjs:24`:

```js
export function wireControl({ sm, registry, stderr, dispatch, onFence = () => {} }) {
```

3b. 替换 `onTurnComplete` 里的 fence task 体(`src/control-wire.mjs` 现 61-106 行,`const task = (async () => { … })();` 内部)为下面版本——并行构造结构化 `commands`、捕获 enqueue 返回值算 `feedbackSent`、task 末 `onFence`。`feedback` 字符串格式与原版逐字相同(保留既有回喂测试):

```js
    const task = (async () => {
      const depth = _depthMap.get(label) ?? 0;
      const feedback = [];
      const commands = [];   // C 编排意图:结构化命令+结果,喂给 onFence

      for (const line of lines) {
        let result;
        let r;
        try {
          r = await dispatch(line, { source: "agent-fence", depth });
        } catch {
          result = "error: dispatch threw";
          feedback.push(`${line} → ${result}`);
          commands.push({ cmd: line, result });
          continue;
        }

        if (r && r.ok && r.label) {
          _depthMap.set(r.label, depth + 1);
          result = `ok · session ${r.label}`;
        } else if (r && r.ok) {
          result = "ok";
        } else if (r && !r.ok && r.reason) {
          stderr.write(`[control warn] ${r.reason}\n`);
          result = `error: ${r.reason}`;
        } else {
          result = "error: unknown result";
        }
        feedback.push(`${line} → ${result}`);
        commands.push({ cmd: line, result });
      }

      let feedbackSent = false;
      if (feedback.length) {
        const sent = sm.enqueue({ target: label, msg: `[synod fence result]\n${feedback.join("\n")}` });
        feedbackSent = sent !== false;   // 发起 agent 仍在 = 真回喂到;已关停 = false
      }
      onFence(label, { commands, feedbackSent });
    })();
```

> 注:`onFence` 默认 no-op → 对不传它的消费者(REPL/`--task`/既有测试)零影响。`feedback` 字符串格式不变 → 既有「fence result feedback」用例不回归。

- [ ] **Step 4: 跑测试看通过 + 既有 control-wire 不回归**

Run: `node --test test/control-wire.test.mjs`
Expected: 全 PASS(新 5 用例 + 原有全部)。

- [ ] **Step 5: Commit**

```bash
git add src/control-wire.mjs test/control-wire.test.mjs
git commit -m "feat(control-wire): onFence callback exposing fence commands+results (C task1)"
```

---

## Task 2: store 加 `appendFence` + `markFenceSeen` + dropSession 清 fence

**Files:**
- Modify: `src/ui/tui/store.mjs`
- Create: `test/ui/tui/store.fence.test.mjs`

- [ ] **Step 1: 写失败测试** — 新建 `test/ui/tui/store.fence.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";

test("appendFence 累积 commands 跨两 turn + seen=false + feedbackSent", () => {
  const store = createStore();
  store.appendFence("omp#1", { commands: [{ cmd: "/open --agent codex", result: "ok · session codex#1" }], feedbackSent: true });
  store.appendFence("omp#1", { commands: [{ cmd: "@codex#1 hi", result: "ok" }], feedbackSent: true });
  const f = store.getState().fences["omp#1"];
  assert.strictEqual(f.commands.length, 2);
  assert.strictEqual(f.commands[0].cmd, "/open --agent codex");
  assert.strictEqual(f.commands[1].cmd, "@codex#1 hi");
  assert.strictEqual(f.seen, false);
  assert.strictEqual(f.feedbackSent, true);
});

test("appendFence trim 到 MAX_FENCE_CMDS=200(留最新)", () => {
  const store = createStore();
  for (let i = 0; i < 250; i++) store.appendFence("omp#1", { commands: [{ cmd: `c${i}`, result: "ok" }], feedbackSent: true });
  const f = store.getState().fences["omp#1"];
  assert.strictEqual(f.commands.length, 200);
  assert.strictEqual(f.commands[f.commands.length - 1].cmd, "c249");
});

test("markFenceSeen 置 seen=true + subscribe 收到通知", () => {
  const store = createStore();
  store.appendFence("omp#1", { commands: [{ cmd: "/open", result: "ok" }], feedbackSent: true });
  let hits = 0; store.subscribe(() => hits++);
  store.markFenceSeen("omp#1");
  assert.strictEqual(store.getState().fences["omp#1"].seen, true);
  assert.ok(hits >= 1);
});

test("markFenceSeen 对不存在的 label 不抛", () => {
  const store = createStore();
  assert.doesNotThrow(() => store.markFenceSeen("nope"));
});

test("dropSession 清除 fences[label](不悬挂)", () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  store.appendFence("omp#1", { commands: [{ cmd: "/open", result: "ok" }], feedbackSent: true });
  assert.ok(store.getState().fences["omp#1"]);
  store.dropSession("omp#1");
  assert.strictEqual(store.getState().fences["omp#1"], undefined);
});
```

- [ ] **Step 2: 跑失败**

Run: `node --test test/ui/tui/store.fence.test.mjs`
Expected: FAIL(`appendFence`/`markFenceSeen` 未定义;dropSession 不删 fence)。

- [ ] **Step 3: 实现 — 改 `src/ui/tui/store.mjs`**

3a. 文件顶部常量区(`MAX_ENTRIES` 旁)加:

```js
const MAX_FENCE_CMDS = 200;   // C 编排意图累积命令上限,防无界
```

3b. 返回对象里(与 `setFence` 并列,`setFence` 之后)加两个方法:

```js
    appendFence(label, fence) {
      const f = state.fences[label] || { commands: [], feedbackSent: false, seen: true };
      f.commands = f.commands.concat(fence.commands || []);
      while (f.commands.length > MAX_FENCE_CMDS) f.commands.shift();
      f.feedbackSent = Boolean(fence.feedbackSent);
      f.seen = false;   // 新编排到达 → 触发 hot
      state.fences[label] = f;
      notify();
    },
    markFenceSeen(label) {
      const f = state.fences[label];
      if (f) { f.seen = true; notify(); }
    },
```

3c. `dropSession` 里(`delete state.sessions[label];` 旁)加清理:

```js
    dropSession(label) {
      delete state.sessions[label];
      delete state.fences[label];
      state.order = state.order.filter((l) => l !== label);
      if (state.focusLabel === label) state.focusLabel = state.order[state.order.length - 1] ?? null;
      notify();
    },
```

- [ ] **Step 4: 跑通过 + P1 store 测试不回归**

Run: `node --test test/ui/tui/store.fence.test.mjs test/ui/tui/store.test.mjs test/ui/tui/store.timeline.test.mjs`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/store.mjs test/ui/tui/store.fence.test.mjs
git commit -m "feat(tui): store appendFence/markFenceSeen + dropSession fence cleanup (C task2)"
```

---

## Task 3: cli TUI 分支接线 onFence → store.appendFence

**Files:**
- Modify: `src/cli.mjs`(TUI 分支 `wireControl` 调用,现 `src/cli.mjs:457`)

> 说明:这是 TUI 分支闭包里的一行接线(与 P2 T6 的 pushUser 回显同类),无法独立单测(`main()` 整块需全栈);由 Task 5 真接线冒烟 + control-wire(T1)/store(T2)单测共同覆盖。codex 评审静态核对。

- [ ] **Step 1: 改 `src/cli.mjs:457`**

把:

```js
    const wired = wireControl({ sm: smTui, registry, stderr: cap, dispatch: dispatchTui });
```

改为:

```js
    const wired = wireControl({
      sm: smTui, registry, stderr: cap, dispatch: dispatchTui,
      onFence: (label, fence) => store.appendFence(label, fence),   // C:编排意图喂进 store
    });
```

- [ ] **Step 2: 既有 cli/TUI 门测试不回归**

Run: `node --test test/cli.tui-gate.test.mjs`
（若报 `spawn EPERM` 隔离 → 重跑加 `--test-isolation=none`。)
Expected: PASS(接线是纯加法,不改既有流)。

- [ ] **Step 3: Commit**

```bash
git add src/cli.mjs
git commit -m "feat(tui): wire control-wire onFence into store.appendFence (C task3)"
```

---

## Task 4: app.mjs 加 Ctrl-G/Ctrl-T 展开 C/D + 展开 C 清 seen

**Files:**
- Modify: `src/ui/tui/app.mjs`
- Modify: `test/ui/tui/app.test.mjs`

- [ ] **Step 1: 写失败测试**(追加到 `test/ui/tui/app.test.mjs`;文件顶部已 import `createStore`/`App`/`EventEmitter`/`render`/`html`,并已 `registerEventAdapter("omp", ompAdapter)`)

```js
test("Ctrl-G 展开 C 编排意图折叠条并标记 fence 已读", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  store.appendFence("omp#1", { commands: [{ cmd: "/open --agent codex", result: "ok · session codex#1" }], feedbackSent: true });
  const { stdin, lastFrame } = render(html`<${App} ...${base(store)} />`);
  stdin.write("\x07");  // Ctrl-G
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(store.getState().fences["omp#1"].seen, true);   // 展开即已读
  assert.match(lastFrame(), /\/open --agent codex/);                  // 明细可见
});

test("Ctrl-T 展开 D relay 折叠条", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  store.attachSession("codex#1", new EventEmitter(), "codex", {});
  store.setRelays([{ from: "omp#1", to: "codex#1" }]);
  const { stdin, lastFrame } = render(html`<${App} ...${base(store)} />`);
  stdin.write("\x14");  // Ctrl-T
  await new Promise((r) => setTimeout(r, 20));
  assert.match(lastFrame(), /out: codex#1/);                          // D 明细展开
});
```

- [ ] **Step 2: 跑失败**

Run: `node --test test/ui/tui/app.test.mjs`
Expected: 两新用例 FAIL(无 Ctrl-G/Ctrl-T 处理,明细不展开)。原用例仍 PASS。

- [ ] **Step 3: 实现 — 改 `src/ui/tui/app.mjs`**

3a. 在 `const [selIdx, setSelIdx] = useState(-1);` 与其重置 effect 旁加 C/D 展开 state + 切焦点重置:

```js
  const [expandC, setExpandC] = useState(false);
  const [expandD, setExpandD] = useState(false);
  useEffect(() => { setExpandC(false); setExpandD(false); }, [st.focusLabel]);
```

3b. `useInput` 内,在「普通字符累加」分支(`if (input && !key.ctrl && !key.meta)`)**之前**加(各自 return):

```js
    if (key.ctrl && input === "g") {
      const willExpand = !expandC;
      setExpandC(willExpand);
      if (willExpand && st.focusLabel) store.markFenceSeen(st.focusLabel);   // 展开 C = 读过 → 清 hot
      return;
    }
    if (key.ctrl && input === "t") { setExpandD((v) => !v); return; }
```

3c. FocusPane 调用加 `expandC`/`expandD`(在现有 `selectedIndex` 旁):

```js
      <${FocusPane} label=${st.focusLabel} sess=${st.sessions[st.focusLabel]} fence=${st.fences[st.focusLabel] || null} relays=${st.relays} selectedIndex=${selIdx} expandC=${expandC} expandD=${expandD} />
```

> 注:`expandC` 从闭包读(与 selIdx 同理——Ink 每 render 重订阅 useInput,跨 render 读到最新)。Ctrl-G=`\x07`、Ctrl-T=`\x14`,P1 未占用。

- [ ] **Step 4: 跑通过 + 既有 app 测试不回归**

Run: `node --test test/ui/tui/app.test.mjs test/ui/tui/components.test.mjs`
Expected: 全 PASS(新 2 + 既有 8 app 用例 + components)。

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/app.mjs test/ui/tui/app.test.mjs
git commit -m "feat(tui): Ctrl-G/Ctrl-T expand C/D strips + clear fence hot on read (C task4)"
```

---

## Task 5: 扩 smoke 验真接线(appendFence→C→键盘)

**Files:**
- Modify: `scripts/smoke-tui.mjs`

- [ ] **Step 1: 在现有 smoke 末尾(`try { tui.teardown … }` 之前)插入 C 段**

```js
  // 7) C 编排意图:appendFence → C 摘要 + 未读 hot;Ctrl-G 展开读明细 + 清 hot;Ctrl-T 展开 D。
  store.appendFence("omp#1", { commands: [{ cmd: "/open --agent codex", result: "ok · session codex#1" }], feedbackSent: true });
  await sleep(40);
  ok("C 摘要显示命令数 + 未读(seen=false)", stdout.text().includes("1 cmds") && store.getState().fences["omp#1"].seen === false);

  stdin.write("\x07");  // Ctrl-G 展开 C
  await sleep(50);
  ok("Ctrl-G 展开 C → 明细显示 cmd → result", stdout.text().includes("/open --agent codex"));
  ok("Ctrl-G 标记 fence 已读(hot 清除)", store.getState().fences["omp#1"].seen === true);

  stdin.write("\x14");  // Ctrl-T 展开 D(本会话无 relay,验不崩 + 焦点仍在)
  await sleep(40);
  ok("Ctrl-T 切换 D 不崩(焦点仍渲染)", stdout.text().includes("omp#1"));
```

- [ ] **Step 2: 跑 smoke**

Run: `node scripts/smoke-tui.mjs`
Expected: 全部 PASS(原 9 + 新 4 = 13/13),`SMOKE PASS`,exit 0。

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-tui.mjs
git commit -m "test(tui): extend smoke with C orchestration-intent + Ctrl-G/T (C task5)"
```

---

## 交付门(全 task 后)

- [ ] **Step 1: 全量受影响测试**

Run: `node --test test/control-wire.test.mjs test/ui/tui/store.fence.test.mjs test/ui/tui/store.test.mjs test/ui/tui/store.timeline.test.mjs test/ui/tui/app.test.mjs test/ui/tui/components.test.mjs`
Run: `node scripts/smoke-tui.mjs`
Expected: 全 PASS。

- [ ] **Step 2: codex 完整 review(agent-bridge,write:false)** — 端到端贯通:control-wire onFence 产出 → cli 接线 → store 累积 → FocusPane 渲染 → app 键盘;字段 `{cmd,result}/feedbackSent/seen` 三处一致;`onFence` 默认 no-op 对 REPL/`--task` 零影响;Ctrl-G/T 不撞既有键。真缺陷修到绿再复审。

- [ ] **Step 3: 全量单测 + e2e 不回归**

Run: `node --test --test-timeout=30000`(已知既有环境产物:Windows symlink EPERM 的 `*.integration.test.mjs` + backend.contract 真 omp 超时,与 C 无关)
Run: `node scripts/acceptance.mjs`(非 TUI 路径,验 C 接线对核心零影响;期望 54/54,win32 跳 SIGINT)
Expected: 新增/受影响用例全绿;无 C 引入的新失败。

---

## Self-Review(对照 spec)

- **spec 覆盖**:onFence 通道(T1)、store 累积+seen(T2)、cli 接线(T3)、Ctrl-G/T 展开+清 seen(T4)、smoke(T5)、尾门 codex+e2e(交付门)——逐项有 task。
- **无占位**:每步含可运行代码 + 命令 + 期望。
- **类型一致**:`{commands:[{cmd,result}], feedbackSent}` 在 T1 产出、T2 store 消费、T4 FocusPane 渲染(P1 契约)、T5 smoke 一致;`appendFence`/`markFenceSeen`/`onFence` 在 store 定义(T2)、cli 接线(T3)、app 调用(T4)签名一致;Ctrl-G=`\x07`/Ctrl-T=`\x14`。
- **加法不破坏**:`onFence` 默认 no-op、`feedback` 字符串格式不变(既有回喂测试不回归)、`setFence` 保留、FocusPane 契约不变。

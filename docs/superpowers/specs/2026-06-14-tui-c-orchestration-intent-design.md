# Synod TUI — C「编排意图」接真实数据 + C/D 折叠条展开键 设计

> 状态:设计已定(用户授权「你来做主」)。下一步:writing-plans 出实施计划 → 子 agent TDD 实施 + codex 评审。
> 前置:P2(工具卡片 + 时间线)已交付(分支 `feat/tui-p1`,末 commit `8832b72`)。本设计是 P2 计划末「后续(不在本计划)」里 **C 项**的展开。

## 目标(一句话)

让焦点区那条 **「C 编排意图」**从永远的空「—」变成**真有内容**:当某 agent 通过**控制 fence**(`/open`、`/relay` 等)去编排别的 agent 时,把它本会话发过的**编排命令 + 每条的结果(ok/建会话/error)累积**显示;并新增 **Ctrl-G/Ctrl-T** 展开/收起 C、D 折叠条,使明细可读;有新编排未读时 C 摘要行 hot 高亮,展开读过即清。

## 现状(已查证的事实)

- `store.setFence(label, data)`(`store.mjs:96`)= `state.fences[label] = data; notify()`,初始 `fences:{}`。**当前没有任何地方调用它** → C 条永远 `—`。
- `FocusPane` C 条契约(P1 已实现,不改):渲 `fence = { commands:[{cmd,result}], feedbackSent, seen }`。
  - 摘要 `cSummary = ${fence.commands.length} cmds${feedbackSent ? " · 回喂已发" : ""}`(无 fence → `—`)。
  - hot 高亮 = `Boolean(fence && !fence.seen)`。
  - 展开明细 = `fence.commands.map(c => \`${c.cmd} → ${c.result}\`).join("\n")`,仅当 `expandC` 为真才显。
- `app.mjs` **未把 `expandC`/`expandD` 传给 FocusPane**(一直 false)→ C/D 明细当前根本展不开,用户只见摘要行。`useInput` 现占用键:Ctrl-C/Tab/Enter/Backspace/Ctrl-O/Ctrl-W/Ctrl-E/↑↓/普通字符。**Ctrl-G、Ctrl-T 空闲**。
- `control-wire.mjs` 的 `onTurnComplete(label, result)`(`control-wire.mjs:41`)**已经算出了 C 需要的全部数据**:`extractFenceCommands(text)` 得到命令行 `lines`;detached task 里对每条 `dispatch(line,{source:"agent-fence",depth})`,按结果 push `feedback`(`line → ok · session X` / `line → ok` / `line → error: reason`);最后 `sm.enqueue({target:label, msg:"[synod fence result]\n"+feedback})` 回喂发起 agent。**但这些数据只活在那个闭包里,没暴露给 store/TUI。**
- cli 的 TUI 分支已把 control-wire 的 `onTurnComplete` 接进 session manager(`composed = wired.onTurnComplete`,在 `onTurnComplete` 回调里调用)。

**结论:gap 只是一条「暴露通道」。** control-wire 已有数据,只差一个 UI 无关的回调把它交给 store。属小改(control-wire ~十行 + cli 接线 + store 累积方法 + app 两个键),非 control-wire 架构改动。

## 架构选型

**方案 1(采用):wireControl 加 UI 无关回调 `onFence(label, fence)`。** 在 `onTurnComplete` 的 fence task 末尾 emit;cli TUI 分支接 `onFence → store.appendFence`。control-wire 不认识 TUI store——与现有 `registry`/`onSessionOpen`/`onTurnComplete` 回调一致,cli 统一接线,可独立单测。
方案 2(`onTurnComplete` 返回 fence 数据)✗:fence dispatch 是 fire-and-forget 的 detached task,返回时结果未就绪,要拿到须 await dispatch → 改 turn 时序/阻塞,有回归风险。
方案 3(wireControl 改 EventEmitter,store 订阅)✗:单消费者用事件总线过度设计(YAGNI)。

## 设计细节

### ① control-wire:`onFence` 回调
- `wireControl(deps)` 新增**可选** `deps.onFence`(默认 no-op;不传则零影响,`--task`/非 TUI 不受影响)。
- `onTurnComplete` 的 fence task 里,与 `feedback[]` 并行构造结构化 `commands`:每条 `{ cmd: line, result: <该条结果文本> }`(结果文本 = 去掉 `line → ` 前缀后的部分,如 `ok · session codex#2` / `error: <reason>`)。
- `sent = sm.enqueue(...)`(捕获返回值);**`feedbackSent = sent !== false`**(发起 agent 仍在 = 真回喂到;已关停 = false)。这比「永远 true」有意义(每条 line 都会 push 一条 feedback,故旧的 `feedback.length>0` 恒真)。
- task 末尾:`onFence(label, { commands, feedbackSent })`。仅在 `lines.length>0` 时(本就是 task 入口条件)。
- 不传 `onFence` 时一切照旧(纯加法)。

### ② store:`appendFence` 累积 + `markFenceSeen`
- `appendFence(label, { commands, feedbackSent })`:把本 turn 的 `commands` **追加**到 `fences[label].commands`(累积本会话编排历史);更新 `feedbackSent`(记最近一 turn);置 `seen=false`(新编排 → 触发 hot);`MAX_FENCE_CMDS = 200` trim(超出从头 shift,防无界)。`fences[label]` 不存在则初始化 `{ commands:[], feedbackSent:false, seen:true }`。
- `markFenceSeen(label)`:`fences[label].seen = true; notify()`(展开读过即清 hot;无该 label 则 no-op)。
- `setFence` 保留(P1 既有,其他潜在用途;C 用 append 不动它)。
- `dropSession` 当前**不清** `state.fences[label]`(已查证 `store.mjs:97-102`,会悬挂)→ 在 `dropSession` 里加 `delete state.fences[label];`。

### ③ cli TUI 分支接线
- `wireControl({ ..., onFence: (label, fence) => store.appendFence(label, fence) })`(仅 TUI 分支;REPL/`--task` 不传)。

### ④ app.mjs:Ctrl-G / Ctrl-T 展开 + 清 seen
- 新增 state `expandC`、`expandD`(默认 false);切焦点(`st.focusLabel` 变)重置二者为 false(与 selIdx 一致)。
- `useInput` 内(置于普通字符累加分支**之前**,各自 return):
  - `Ctrl-G`:`setExpandC(v => !v)`;若变为展开,`store.markFenceSeen(st.focusLabel)`(展开即已读)。
  - `Ctrl-T`:`setExpandD(v => !v)`。
- `<${FocusPane} ... expandC=${expandC} expandD=${expandD} />`。
- 键位可调(Ctrl-C/Ctrl-D 已被 interrupt/EOF 占用,故 C/D 条用 Ctrl-G/Ctrl-T 这两个空闲键)。

### ⑤ hot/seen 语义
- 新 fence 到达(`appendFence`)→ `seen=false` → C 摘要 hot。
- 展开 C(Ctrl-G 展开)→ `markFenceSeen` → `seen=true` → 不 hot。
- 再来新编排 → 又 `seen=false` 重新 hot(新活动重新提醒)。

## 文件改动

| 文件 | 改动 | 新建/改 |
|---|---|---|
| `src/control-wire.mjs` | `wireControl` 加可选 `onFence`;`onTurnComplete` 构造结构化 `commands` + 真实 `feedbackSent`,task 末 emit | 改 |
| `src/ui/tui/store.mjs` | `appendFence` + `markFenceSeen`;`dropSession` 清 fences(核对) | 改 |
| `src/cli.mjs` | TUI 分支 `wireControl({..., onFence})` 接 `store.appendFence` | 改 |
| `src/ui/tui/app.mjs` | `expandC`/`expandD` state + Ctrl-G/Ctrl-T + 传 FocusPane + 清 seen | 改 |
| `scripts/smoke-tui.mjs` | 扩冒烟:appendFence → C 摘要/hot,Ctrl-G 展开读明细+清 hot,Ctrl-T 展开 D | 改 |
| `test/control-wire*.test.mjs` | onFence 被调 / shape / feedbackSent / 不传不炸 | 改/新建 |
| `test/ui/tui/store.*.test.mjs` | appendFence 累积+trim+seen / markFenceSeen | 改/新建 |
| `test/ui/tui/app.test.mjs` | Ctrl-G 展开+清 seen、Ctrl-T 展开 D | 改 |

## 规范数据模型

- control-wire → cli → store 的 `onFence(label, fence)`:`fence = { commands: [{cmd:string, result:string}], feedbackSent:boolean }`。
- store `fences[label]`(累积):`{ commands:[{cmd,result}]…累积, feedbackSent:boolean(最近turn), seen:boolean }`。
- FocusPane 读取(不变):`{ commands:[{cmd,result}], feedbackSent, seen }`。三处字段名一致。

## 测试策略

- **control-wire 单测**:给 `onFence` 桩,跑一个带 fence 的 `onTurnComplete`,断言 `onFence(label, {commands:[{cmd,result}], feedbackSent})` 被调、cmd/result 配对正确、feedbackSent 随 enqueue 成功/失败;不传 `onFence` 不抛。
- **store 单测**:`appendFence` 跨两 turn 累积 commands、`seen=false`、trim 到 MAX;`markFenceSeen` 置 true + notify。
- **app 单测**:Ctrl-G 展开(FocusPane 收到 `expandC=true`,且 `markFenceSeen` 被调)、再按收起;Ctrl-T 展开 D;切焦点重置。
- **smoke 扩展**(`scripts/smoke-tui.mjs`):真 startTui 下 appendFence → C 摘要含命令数 + hot,Ctrl-G 展开渲出 `cmd → result` 明细且 hot 清除。
- 本机 `node --test` 受影响文件全绿;codex 独立评审每个 task;尾门 codex 完整 review。

## 非目标(明确排除)

- 不在 timeline 里渲染编排命令(C 条专管编排意图,timeline 专管 assistant/tool/user;两者分工不变)。
- 不改 control fence 的解析/dispatch/回喂语义(只**旁路读出**已算好的数据)。
- 不动 D「relay」的数据来源(D 已有 relay 图;本设计只给 D 加展开键,数据不变)。
- 鼠标点击展开 C/D 暂不做(P2 鼠标只命中右栏 agent 卡;键盘 Ctrl-G/T 足够,鼠标单列后续)。

## 自检

- 占位扫描:无 TBD/TODO。
- 字段一致:`{commands:[{cmd,result}], feedbackSent, seen}` 在 control-wire 产出 / store 累积 / FocusPane 消费 三处对齐;`appendFence`/`markFenceSeen`/`onFence` 在 store 定义、cli 接线、app 调用一致。
- 加法不破坏:`onFence` 可选默认 no-op → control-wire 对 REPL/`--task` 零影响;`setFence` 保留;FocusPane 契约不变。
- 范围聚焦:单一连贯特性(C 真实数据 + C/D 展开键),可独立交付、可测。

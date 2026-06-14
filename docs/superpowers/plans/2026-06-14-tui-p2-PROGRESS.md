# P2 TUI 执行进度 / 交接(2026-06-14)

> 给接手的模型:读这一份就能从 **Task 5** 续上,不用重建上下文。配套实现计划(含每个 task 的完整代码与测试)在 [`2026-06-14-tui-p2-tool-cards.md`](2026-06-14-tui-p2-tool-cards.md)。本文只补「当前到哪了 + 怎么接着干 + 已踩的坑 + 硬查到的事实」。

## ✅ P2 已交付(2026-06-14 完成)

**全部 6 个实施 task + 交付门完成。** 分支 `feat/tui-p1`,工作区干净(末 commit `42eb6b2`),未合并未推送。
- T5 `f82bd27` / T6 `f5a4dd0` / 适配器懒解析修 `42eb6b2`,每个均过 codex(agent-bridge,write:false)独立审 + 本机实跑。
- 交付门:codex 完整 review = **SHIP-IT**(端到端契约无断点);全量单测 **915 pass**(7 fail 全是与 P2 无关的既有环境产物:Windows symlink 权限 EPERM 的 `*.integration.test.mjs` 建项 + backend.contract 真 omp 错误用例 30s 超时;经与 P2 前基线 `7c8be47^` diff 为空证明这些文件 P2 未碰);e2e acceptance **54/54**(win32 跳 A4b SIGINT,既有基线一致;A1 首跑冷启动 120s 超时,warm 复跑通过=瞬态 flake)。
- 待用户拍板:合并 / 开 PR / 继续后续计划(C 真实数据、flow approve、`$` shell,见计划末「后续」)。

---

## 一句话现状

P2 = 给 synod 全屏 TUI 加「富工具调用卡片 + 有序时间线」,分 6 个实施 task + 1 个交付门。**Task 1–4 已完成并提交、每个都过了 codex(agent-bridge)独立审核 + 我本机实跑测试验收**。**剩 Task 5(FocusPane 改渲时间线)、Task 6(app/index/cli 接线)、交付门(codex 完整 review + e2e)。**

- 分支:`feat/tui-p1`(未合并未推送)。工作区干净(截至 `777626a`)。
- 跑起来:有 TTY 时 `node src/cli.mjs` 进 TUI;`--no-tui` 回退老 REPL。非 TTY / `--task` 走原路径不变。

## 执行流程(用户拍板的「套路」,务必照此)

```
每个 task:
  1. 派 fresh subagent 实施(按难度选模型:机械/单文件→sonnet;多文件集成/最绕→opus),走 TDD 红-绿。
  2. 实施者报 DONE 后,我先自己 git diff + 本机跑测试核一遍(不盲信回传)。
  3. 拉 codex(agent-bridge,write:false)做独立第二意见:静态审查 + 字段/逻辑核对。
     —— codex 沙箱是只读,跑不了写日志的测试;测试以「我本机实跑」为准,codex 做静态审 + 真 schema 核对。
  4. codex 提的问题分诊:真缺陷 → 打回同一实施 subagent 修 + 补回归测试 + 新建 commit(不 amend)→ codex 复审。
     —— 注意按「单 task 职责」审,别拿整特性端到端卡单 task(见下「task 边界」)。
  5. codex APPROVE + 本机测试绿 → 点亮该 task → 下一个。
全部 6 个 task 后:拉 codex 做完整 review + e2e/acceptance 测试,有问题修到全绿才算交付。
```

**task 边界(避免 codex 用端到端卡单 task)**:Task 2 只写适配器纯函数;「store 监听/消费 toolevent」是 Task 3;「生产代码注册适配器」是 Task 6。审 Task N 时按 Task N 的职责审。

## 进度表

| # | Task | 模型 | 状态 | commit |
|---|---|---|---|---|
| T1 | backend `toolevent` 不截断通道 | sonnet | ✅ codex APPROVE | `7c8be47` + `b9b6ee7`(allowlist 修) |
| T2 | omp/codex 事件适配器(注册制) | sonnet | ✅ codex APPROVE | `4eb73dd` + `b0c906e`(字段提取修) |
| T3 | store 有序时间线 entries | opus | ✅ codex APPROVE | `eb824c1` |
| T4 | ToolCard 组件 | sonnet | ✅ codex APPROVE | `4edbfce` + `777626a`(safe stringify+截行修) |
| T5 | FocusPane 改渲时间线 | sonnet | ✅ codex APPROVE | `f82bd27` |
| T6 | app/index/cli 接线 | opus | ✅ codex APPROVE | `f5a4dd0` + `42eb6b2`(适配器懒解析修) |
| 门 | codex 完整 review + e2e | — | ✅ **通过**:codex 完整 review=**SHIP-IT**(无 finding);单测 915 pass(全部 P2 用例绿);e2e acceptance **54/54**(win32 跳 A4b SIGINT) | — |
| (计划本身) | P2 plan | — | ✅ codex 3 轮闭环 | `b078d39` |

**T6 codex 复审揪出的真缺陷(已修 `42eb6b2`)**:`store.attachSession` 在 attach 当下 `const normalize = getEventAdapter(agent)` **冻结**适配器,而 cli 先 `smTui.open()`→attachSession、后在 `startTui` 注册 omp/codex 适配器 → 默认会话永久绑 `defaultAdapter`(toolevent→null),真机首个会话的工具卡永不渲染(单测因「先注册后 attach」漏掉)。**根因不是注册晚,而是 store 冻结适配器制造了隐式时序耦合**;正解=store **按事件惰性解析**适配器(每事件 O(1) Map 查,`getEventAdapter` 永远回退 default 不 undefined),彻底消除耦合;注册位置不动。新增独立回归 `test/ui/tui/store.adapter-order.test.mjs`(单进程模拟「先 attach 后 register」)。codex 复审认可此改法优于「前移注册」(把契约放回 registry 本身)。

## 已交付内容(T1–T4 干了什么)

- **T1 `src/backend.mjs`**:OmpSession/CodexSession 新增 `toolevent` EventEmitter 通道,发**未经 `compactEvent` 截断**的完整工具消息。导出纯函数 `emitToolEventFromOmp(emitter,message)`(命中 `tool_execution_start/end`)与 `emitToolEventFromCodexItem(emitter,item)`(allowlist 过滤后发 `{type:"tool.item",item}`)。omp 接线在 `#emit(compactEvent)` 之前;codex 接线在 `item/completed` 的 staleTurn 早退之后(旧 turn 工具 item 不发)。现有 `event`/`delta`/`status` 通道与 agent-bridge/`--task` 零影响(无监听 = no-op)。
- **T2 `src/ui/tui/adapters.omp.mjs` + `adapters.codex.mjs`**:把后端事件规范成 `{kind:"status"|"message.delta"|"tool.start"|"tool.end", …}`。`events.mjs` 的 `defaultAdapter` 加 `toolevent→null` + 新增 `resetEventAdapters()`(清内部 `_adapters` Map,测试隔离用)。注册制沿用 P1 的 `registerEventAdapter`/`getEventAdapter`。
- **T3 `src/ui/tui/store.mjs`**:每会话加 `entries` 有序时间线(user/assistant/tool 混排)、`pushUser(label,text)`、`toggleEntry(label,index)`、tool 按 id upsert(null id 不合并各自追加)、`_newAsst` turn 边界标志、`MAX_ENTRIES=300` trim。`attachSession` 加 `session.on("toolevent", …)`。**P1 字段 assistantText/lastLine/status/turn/ms 继续维护**(AgentRail 依赖)。
- **T4 `src/ui/tui/components/ToolCard.mjs`**:单张工具卡(收起 `▸ 🔧 name(args摘要) · 状态`;展开 `▾` + args + diff + output 截 12 行)。`safeStringify`(防循环引用让 render 抛错)、`clampLines` 先按 `MAX_LINE_CHARS=200` 截每行再截行数。

**store 的 tool 条目形状**(T4/T5 渲染、T3 产出):
```
{ type:"tool", id, name, args, intent, status:"running"|"done", ok, output, diff, expanded:false }
```
`args` 可能是对象(omp)或字符串(codex command)。

## 下一步:Task 5(FocusPane 改渲时间线)

完整 task 文本见计划 Task 5 节。要点:焦点区正文从「只渲 `sess.assistantText`」改为**渲 `entries` 时间线**(user 条绿色 `❯` 前缀、assistant 条原样带流式光标、tool 条用 `ToolCard`),组件签名加 `selectedIndex = -1`(高亮选中的 tool 卡)。**头部 B/E 元信息 + C/D 折叠条不变;无 sess 提示不变。**

**改 `src/ui/tui/components/FocusPane.mjs`**:现状正文区是(第 20–22 行)
```js
    <${Box} flexGrow=${1} flexDirection="column" paddingX=${1}>
      <${Text}>${sess.assistantText || ""}${sess.isStreaming ? "▌" : ""}<//>
    <//>
```
换成渲 entries(并在文件顶部 `import { ToolCard } from "./ToolCard.mjs";`,签名加 `selectedIndex = -1`):
```js
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
然后把原正文 `<${Box}>` 整块换成 `${body}`。

**改 `test/ui/tui/components.test.mjs`**:加一个「FocusPane 渲 entries 时间线 user/assistant/tool 混排」用例(计划 Task 5 Step 1 有完整代码);并**修正**原「FocusPane 头部含 model/turn,正文含 assistantText」用例——它的 sess 现在要带 `entries`(把原 assistantText 文本放进一条 assistant entry),断言正文文本来自 entries。无 sess 提示用例不变。

验证:`node --test test/ui/tui/components.test.mjs` 全绿(含更新后的 FocusPane 用例 + 其余组件原用例)。commit:`feat(tui): FocusPane renders ordered timeline with ToolCards (P2 task5)`。

## 之后:Task 6(app/index/cli 接线)

完整文本见计划 Task 6。三件事:① `src/ui/tui/index.mjs` 的 `startTui` 动态 import 后 `registerEventAdapter("omp", ompAdapter)` + `registerEventAdapter("codex", codexAdapter)`;② `src/cli.mjs` 的 `dispatchWrapped` 在普通文本 dispatch **成功**(`r?.redraw === false`,见 `repl-dispatch.mjs:230-232`)后 `store.pushUser(label, line)` 回显(`/`@`$` 开头不回显;dispatch 前先捕获 `label`);③ `src/ui/tui/app.mjs` 加选中游标 `selIdx`(`↑/↓` 在 tool 条间跳,切焦点 `useEffect` 重置)+ `Ctrl-E` 调 `store.toggleEntry`,FocusPane 传 `selectedIndex=${selIdx}`。**含真 TTY 手测**(本环境无 PTY,需人工 `node src/cli.mjs` 冒烟)。

## 交付门(全 task 后)

拉 codex 完整 review(看 6 个 task 整体一致性)+ 跑 e2e/acceptance。已知:P1 全单测 878 pass、e2e acceptance 54/54(win32 跳 shutdown)。修到全绿才算交付。

## 硬查到的事实(别再猜,这些是 codex introspect 真实 schema / 日志得来的)

**codex v2 `ThreadItem` 工具型 type(codex-cli 0.138.0)** —— allowlist 就这 6 个:
`commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`。
- ⚠️ `patchApply` **不是**合法 `ThreadItem.type`(补丁状态挂在 `fileChange.status` 的 PatchApplyStatus 上)。图片类 `imageView`/`imageGeneration` 本期不做卡。
- 字段名:`commandExecution` 输出=`aggregatedOutput`、命令=`command`;`mcpToolCall` args=`arguments`、输出=`result.content[].text`;`dynamicToolCall` args=`arguments`、输出=`contentItems[].text`;`fileChange`=`changes:[{diff,kind,path}]`;`webSearch` args=`query`;`collabAgentToolCall` args=`prompt`。
- `status` 枚举:commandExecution/fileChange = `inProgress|completed|failed|declined`;mcp/dynamic/collab = `inProgress|completed|failed`。`ok = status === "completed"`。
- id 取 `item.id ?? item.callId ?? null`(真实是 `item.id`,callId 仅无害兜底)。

**omp**:`tool_execution_end` 顶层有 `isError` 字段(`result.content` 是 `[{type:"text",text}]`)。`ok = error == null && isError !== true`。

## 环境坑(Windows)

- 跑测试:**前台** `node --test <file>` 正常。若报 `spawn EPERM`(node test runner 隔离)→ 加 `--test-isolation=none`。codex 沙箱是只读,跑不了写 `~/.agent-bridge/logs` 的测试(如 backend.contract),所以测试验收以**主 agent 本机实跑**为准。
- ⚠️ **PowerShell 后台命令别管道 `Select-Object`**——会缓冲假死(看不到输出、像卡住)。要看 tail 就前台跑,或重定向到文件再读。
- agent-bridge codex 评审会话(本次):`codex-mqd7u4ji-33ya35`(pid 26040,effort high,write:false)。会话活在当前客户端的 MCP server 进程内,**换客户端/会话就没了**——接手模型按需 `agent_bridge_open_session({agent:"codex", cwd:"D:\\cc\\synod", write:false})` 新开即可,把上面「硬查到的事实」当上下文带上。

## 验证当前绿态(接手先跑这些确认没坏)

```
node --test test/backend.toolevent.test.mjs                                  # 5/5
node --test test/ui/tui/adapters.omp.test.mjs test/ui/tui/adapters.codex.test.mjs test/ui/tui/events.test.mjs   # 12 + (events 既有)
node --test test/ui/tui/store.timeline.test.mjs test/ui/tui/store.test.mjs   # 7 + 6
node --test test/ui/tui/components.toolcard.test.mjs                          # 7/7
git log --oneline -8                                                          # 应见 7c8be47→777626a 这串
```

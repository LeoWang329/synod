# flow 群聊视图 设计增量

> 这是对 `2026-06-16-flow-in-tui-design.md` 的**渲染模型增量**(非新功能)。引擎接缝(`flow.mjs` 注入 `progress`/`io`/`signal`)、focus 路由(`cli.mjs` 按 `kind:"flow"` 判定)、approve 经输入框作答的交互——全部不变。只改"flow 内部 agent 怎么在 rail 与焦点区呈现"。

**日期:** 2026-06-17 · 分支 `feat/tui-p1`

## 为什么改(第一性原理)

flow 本就是**一件事**(一次编排)。当前实现把它内部的 N 个 agent 投影成 N 张并列的会话卡(`⑂planner`、`⑂review`…),等于把"一个编排"画成"一堆散兵":既挤占右栏 AGENTS 名单(一个 5-agent 的 flow = 5 行),又丢了"这些 agent 同属一个 flow"的归属感。

目标模型:**flow = 单位,agent = 参与者**。一个 flow 在 rail 占**一行**;切进去是一个**独立群聊页**,该 flow 的所有 agent 在同一条时间线里按发言人归属显示,像群聊。flow 内部 agent **不**再单独出现在 rail。

## 数据模型:每 flowId 一张卡(原为每 agent 一张)

底层已有 `flowId` 作分组键(`endFlow`/`dropFlow` 本就按它走)。改动是把"每 (agent, flowId) 一卡"收成"每 flowId 一卡",**条目带发言人字段**。

flow 卡(`kind:"flow"`)字段:

| 字段 | 含义 |
|---|---|
| `flowId` | 分组键(不变) |
| `flowName` | flow 名(rail/头部显示 `⑂<flowName>`) |
| `agent` | = `flowName`(复用 FocusPane/AgentRail 既有的 `sess.agent` 显示位) |
| `agents` | 参与者花名册(有序去重数组,群聊头部列出) |
| `status` | `running` / `awaiting`(有待答)/ `done` / `failed` |
| `pendingQuestion` | `null` 或 `{ agent, prompt }`(原为裸字符串) |
| `entries[]` | 时间线;每条带 `agent` 字段(发言人) |
| `assistantText`/`lastLine` | 跨发言人累积(供 rail 22 列预览,沿用) |

label 形状:`⑂<flowName>#<flowId>`(原为 `⑂<agent>:<model>#<flowId>`)。

## store API(`src/ui/tui/store.mjs`)

```
attachFlow(label, { flowId, flowName })       // 建唯一 flow 卡;首卡默认聚焦
noteFlowAgent(label, agent)                   // 幂等登记参与者到 agents 花名册
appendFlowDelta(label, agent, text)           // 发言人变 → 另起 assistant 段;登记花名册;更新 assistantText/lastLine
appendFlowOutput(label, agent, text)          // 追加 {type:"output", agent, text};登记花名册
setFlowQuestion(label, agent, prompt)         // 追加 {type:"approve", agent, text:prompt};pendingQuestion={agent,prompt};status awaiting;登记花名册;pushNudgeToFocus
resolveFlowQuestion(label)                     // pendingQuestion=null;awaiting→running
endFlow(flowId, { ok, summary })              // 不变(按 flowId)
dropFlow(flowId)                               // 不变(按 flowId)
```

发言人分段规则(`appendFlowDelta`):末条是 `assistant` **且** `last.agent === agent` → 追加;否则 push 新 `{type:"assistant", agent, text}`。这就是群聊气泡按发言人分组的来源。

`attachFlowAgent`(旧名,每 agent 一卡)**删除**,由 `attachFlow` 取代。

## flow-tui 投影(`src/ui/tui/flow-tui.mjs`)

- `keyOf(agent…)` → `flowLabelOf(flowId, flowName) = ⑂<flowName>#<flowId>`(一 flow 一 label)。
- `makeSink(flowId, flowName)`:首个事件 `attachFlow` 一次;`opening`/`start` 调 `noteFlowAgent`;`delta` 调 `appendFlowDelta(label, ev.agent, ev.text)`。`last()` 返回 `{ label, agent: lastAgent }`(当前发言人 = 最近事件的 agent)。
- `makeIo(flowId, sink, flowName)`:`cap`/`question` 的发言人取 `sink.last().agent ?? flowName`;`question` 调 `setFlowQuestion(label, agent, prompt)`,`pending` Map **按 flow label** 存(一 flow 一条)。
- `answer`/`handleHumanLine` 按 flow label(= `focusLabel`)寻址,逻辑不变。
- `start`/`activeFlows`/`abortAll`/`endFlow`/`dropFlow`/`resumeFlow`/`flowNameOf` 不变。

## 渲染

### 焦点区群聊页(`FocusPane.mjs`,仅 `kind:"flow"` 分支)

- 头部:`⑂<flowName>` + 参与者花名册 `sess.agents.join(" · ")` + 右侧 `statusText`。
- 时间线:遍历 `entries`,维护 `prevAgent`;当 `e.agent` 与 `prevAgent` 不同,在该条之前插一行**发言人名**(`<Text bold color=theme.dim>`,暗色加粗,选 A 方案);连续同发言人不重复插名。其下沿用既有 per-type 渲染(assistant/output/approve/tool/breadcrumb/nudge/user)。
- 流式光标 `▌` 仍跟最后一条 assistant(= 当前发言人末段)。
- **非 flow 分支逐字节不变。**

### 右栏 rail 行(`AgentRail.mjs`,仅 `kind:"flow"` 分支)

- `name = ⑂<flowName>`;名字后不带 `t<turn>`(flow 无 turn 概念)。
- 状态行:`待你`(awaiting)/ `failed` / `done` / `running · <N> agents`(N = `agents.length`)。
- 预览行 `lastLine` 沿用。**非 flow 分支不变。**

### 不变

`cli.mjs`(focus 路由按 `kind:"flow"`)、`app.mjs`(`approve = fa.kind==="flow" && fa.pendingQuestion`,对象仍真值)、`InputBar`(`approve ❯`)、Ctrl-G/待你/状态栏计数(一 flow 卡 awaiting 计一次,反而更准)。

## 测试

| 文件 | 改动 |
|---|---|
| `test/ui/tui/store.flow.test.mjs` | 改写为新 API:一卡、agent 分段、花名册、`pendingQuestion` 对象 |
| `test/ui/tui/flow-tui.test.mjs` | label `⑂<flowName>`、一卡多 agent 投影、`pending` 按 flow label、`pendingQuestion.prompt` |
| `test/ui/tui/focuspane.flow.test.mjs` | 群聊:头部花名册 + 发言人分段头 + 连续同发言人不重复 |
| `test/ui/tui/components.agentrail.test.mjs` | 加 flow 行断言(`⑂<flowName>` + `running · N agents` / `待你`) |
| `scripts/smoke-tui.mjs` 第 8 节 | 假 flowMain 多 agent → 群聊页 + 作答 + 撤卡;label `⑂demo` |

## 已知边界(v1 可接受)

- **并行 agent 同时提问**:`pending` 按 flow label 存,一 flow 同刻仅一待答(flow 引擎多为顺序提问)。并行提问罕见,留作后续。
- **聚焦带待答的 flow 卡**:`setFocus` 会把 `awaiting→idle`(沿用"焦点 session 永不 awaiting"),但 `pendingQuestion` 仍在并驱动 `approve ❯` 与群聊里的 approve 块——状态点变化是既有语义,不在本次范围。
- **跨发言人流式交错**:并行 agent 的 delta 会按事件顺序交错成多段——v1 接受。

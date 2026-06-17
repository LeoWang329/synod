# flow-in-TUI 设计

**目标:** 让 synod 全屏 TUI 里的 `/flow`(及 `/resume`)真正能跑——把一个运行中的 flow 投影成 TUI 里的「只读会话卡」,复用现有 rail / 焦点流 / 待你 / 输入框;同时支持自主跑完型与交互 approve 型。

**架构:** 不改 flow 引擎核心。`flow.mjs` 的 `main()` 早已把 `progress`(进度事件汇)、`io`(approve/question)、`signal`(中止)作为可注入依赖透传给 `createRuntime`。TUI 侧新增一个驱动模块,装出这三个依赖——`progress` 投影成 store 里的 flow 伪会话,`io.question` 把 approve 提示挂成「待你」并由输入框作答,`signal` 接 Ctrl-C。唯一碰引擎处:`main()` 增加一个可注入的 `progress` 入参(现在它内部从 `stdout` 自建)。

**技术栈:** Node ESM、Ink ^6、现有 `src/ui/tui/*`(store/app/components)、现有 flow 引擎(`src/flow.mjs` + `src/flow/runtime.mjs`)。

---

## 1. 背景与根因

TUI 里敲 `/flow …` 报 `flow runner not available`。根因:`cli.mjs` 有两套独立 dispatch——

- 非 TUI 的 REPL(`cli.mjs:650`)接了完整 `runFlow`/`resumeFlow`/`flowStatus`,所以**不开 TUI 直接 `synod` 跑 flow 是好的**;
- TUI 这套(`cli.mjs:451` `dispatchTui`)创建时**没传 `runFlow`**,于是 `/flow` 落到兜底桩(`repl-dispatch.mjs:176-179`)打印「flow runner not available」。旁边 `flowStatus: () => "none"`(`cli.mjs:453`)写死,佐证 flow-in-TUI 当初是有意没做,而非漏参。

没做的真问题有三:flow 输出往哪去(全屏 alt-screen 不能让 flow 乱写真 stdout)、交互 approve 怎么接到输入框、Ctrl-C 怎么中止 flow。本设计逐一解决。

## 2. 范围

**做(in):**
- TUI 内 `/flow <name> [input]` 与 `/resume <runId>` 可跑。
- 自主跑完型 flow:卡片冒出 → 流式 → 完成,结果上屏。
- 交互 approve 型 flow:撞 approve/question 门 → 该 flow 置「待你」+ 冒泡 → 用户在输入框作答 → 续跑。
- 并发多 flow;Ctrl-C 中止在跑的 flow(复用既有 Ctrl-C 双击语义)。

**不做(out,见 §12):** flow 步骤图/DAG 可视化;flow 内部 agent 的可交互对话(只读);flow 输出的持久滚动回看(依赖尚未实现的滚动视图);headless/CI 行为(沿用引擎现状)。

## 3. 设计原则

1. **复用优先**:flow 伪会话进**同一个** `sessions`/`order` 表,让 AgentRail/FocusPane/`firstAwaiting`/Ctrl-G 直接白嫖,不新建一套渲染。
2. **架构钉死、像素留轻**:卡片具体摆位/字形依赖仍在改的 TUI 布局,故 spec 钉接口与数据流,像素层只给最小约定。
3. **引擎零侵入**:只加一个可注入 `progress` 入参;approve/abort 用现成 seam。
4. **只读寻址**:flow 内部 agent 由 flow 驱动,人不能直接给它发消息;唯一例外是回答它打开的 approve/question 门。

## 4. 架构与数据流

```
/flow … 或 /resume …(dispatchTui,human 路径)
   └─ flowTui.runFlow(argv)  ──►  flowMain({
          progress: tuiSink,        // ① 事件 → store 投影
          io: tuiIo,                // ② approve/question → 待你 + 输入框作答
          signal: ctrl.signal,      // ③ Ctrl-C → abort
          stdout: capSink, stderr: capSink,   // 杂散写入 → store(不污染屏幕)
          openBackend, workflowsRoot, cwd, config,
        })
        │
        ├─ progress.emit({type,agent,model,text})
        │     → store.attachFlowAgent / appendFlowDelta / setFlowAgentStatus
        │
        ├─ io.question(prompt,{signal})
        │     → store.setFlowQuestion(flowId, agentLabel, prompt) + 置 awaiting + 冒泡
        │     → 返回 Promise,挂进 flowTui 的待答登记表
        │     → 用户在输入框对该 flow agent 作答 → resolveFlowQuestion → Promise resolve
        │
        └─ flow 结束(resolve/reject)
              → store.endFlow(flowId, 结果)  → 系统消息 + 流内面包屑;卡片标完成后撤
```

## 5. 三个注入接缝(已核实)

| 接缝 | 引擎位置 | 事件/契约 |
|---|---|---|
| `progress` 事件汇 | `createRuntime({progress})`,`flow.mjs:366`;实证 `flow.progress.test.mjs:58` | `emit(ev)`,`ev` ∈ `{type:"opening",agent,model}` / `{type:"start",agent,model}` / `{type:"delta",agent,model,text}`(`agent.mjs:131/182/192`、`agentLoop.mjs:131/156`)。**无独立 session id**,投影键取 `flowId+agent+model`。 |
| `io.question` | `createRuntime({io})`,`flow.mjs:368`;REPL 注入形状 `{stdout,stdin,question}`,`cli.mjs:595` | `question(prompt,{signal})` 返回 `Promise<string>`。approve/reviseWithHuman 均经此(REPL 仅注入 `question`,故 approve 必然走它)。 |
| `signal` | `createRuntime({signal})`,`flow.mjs:369` | 标准 `AbortSignal`;触发即让在跑步骤取消。 |

**引擎唯一改动**:`main()` 当前内部自建 `progressSink`(`flow.mjs:344-348`,从 `stdout`)。改为接受可注入 `progress`:
```js
// main(opts) 解构新增 progress:injectedProgress
const progressSink = injectedProgress ?? (view ? view.countingSink(baseSink) : baseSink);
```
签名 + 一行;非 TUI 路径不传则行为不变(回归保护)。

## 6. 组件分解

### 6.1 `src/flow.mjs`(改)
- `main()` 入参增加 `progress`(默认 `undefined`)。
- `progressSink` 计算改为 `injectedProgress ?? 原有`。
- 其余不动。`createDefaultProgressSink` 仍导出(测试在用)。

### 6.2 `src/ui/tui/flow-tui.mjs`(新)
职责:用注入的 `store` 造出三件套依赖 + flow 登记表,对外暴露给 cli 接线。

导出 `createFlowTui({ store, openBackend, workflowsRoot, cwd, config, env })` → 返回:
- `runFlow(argv): Promise<number>` —— 生成 `flowId`,建 `AbortController`,调 `flowMain({progress, io, signal, stdout, stderr, openBackend, workflowsRoot, cwd, config})`;登记到 `activeFlows`;`finally` 时 `store.endFlow` + 注销。
- `resumeFlow(runId): Promise<void>` —— 同上,走 `flowMain({resume:…})`(参照 `cli.mjs:619-646`)。
- `flowStatus(): string` —— `activeFlows.size>0 ? "${n} running" : "none"`。
- `abortAll(): void` —— 遍历 `activeFlows` 调 `ctrl.abort()`;并 reject 所有待答问题。
- `answer(flowId, agentLabel, text): boolean` —— 由 dispatch 调用,resolve 对应待答 Promise;无待答返回 false。

内部三件套:
- **tuiSink**(`progress`):
  - `opening` → `store.attachFlowAgent(label, {flowId, agent, model})`(label = `flowKey(flowId,agent,model)`,卡状态 `running`)。
  - `start` → 确保卡存在 + 开一段新 assistant 条目。
  - `delta` → `store.appendFlowDelta(label, text)`(打字机式追加当前 assistant 条目)。
- **tuiIo**:`{ stdout: capSink, stdin: noopStdin, question }`。
  - `question(prompt,{signal})`:取「当前该 flow 正在产出的 agentLabel」(最近活跃卡;无则建一张 flow 主控卡),`store.setFlowQuestion(label, prompt)` + 置 `awaiting` + `store.pushFlowNudge`(焦点流冒「flow X 要你确认 · ^G 去看」);把 `{resolve,reject}` 存入 `pendingQuestions[label]`;`signal` 上挂 abort → reject(`new Error("flow aborted")`)。返回该 Promise。
- **capSink**(`stdout`/`stderr`):按行把写入投影成对应 flow 卡的 output 条目(approve 正文/diff 等非 delta 文本经此可见);避免任何真 stdout 写入。

`flowKey(flowId, agent, model)` = `⑂${agent}${model?":"+model:""}#${flowId的短号}`(展示用 `⑂${agent}`;同 flow 内同 agent+model 复用同卡,见 §5 取舍)。

### 6.3 `src/ui/tui/store.mjs`(改:flow 伪会话模型)
flow 伪会话进**同一个** `sessions` 映射 + `order`,带额外字段 `kind:"flow"`、`flowId`、`pendingQuestion`(`null` 或 `string`)。无活适配器、无真 session 对象。新增方法(均触发 `subscribe` 通知):

- `attachFlowAgent(label, {flowId, agent, model})` —— 若不存在则建 `{kind:"flow", flowId, agent, model, status:"running", entries:[], turn:0, isStreaming:true}` 并入 `order`;存在则置 `running`。
- `appendFlowDelta(label, text)` —— 追加到末个 assistant 条目(无则建),`isStreaming=true`。
- `setFlowAgentStatus(label, status)` —— `running|awaiting|done|failed`。
- `setFlowQuestion(label, prompt)` —— 置 `pendingQuestion=prompt`、`status="awaiting"`、追加一条 `type:"nudge"` 或 `type:"approve"` 提示条目。
- `resolveFlowQuestion(label)` —— 清 `pendingQuestion`、`status="running"`(实际 resolve 在 flowTui,本方法只更新视图态)。
- `endFlow(flowId, {ok, summary})` —— 对该 `flowId` 的所有卡置 `done|failed`、清 `pendingQuestion`、`isStreaming=false`;`pushSystem` 结果摘要;焦点流 `appendFence` 风格面包屑;**延时**从 `order`/`sessions` 撤掉这些卡(见 §9 清理)。

`firstAwaiting()` 不改——flow 卡的 `status:"awaiting"` 天然被它选中,**Ctrl-G 白嫖跳转**。`setFocus`/`focusNext` 清 awaiting 的既有规则对 flow 卡同样适用(聚焦即清回 idle 视图态;但 `pendingQuestion` 仍在 → 见 §6.5 输入路由不依赖 awaiting 而依赖 `pendingQuestion`)。

### 6.4 `src/cli.mjs`(改:接线 + abort)
- TUI 分支构造 `const flowTui = createFlowTui({ store, openBackend, workflowsRoot: flowsRootTui, cwd, config, env })`。
- `dispatchTui = createReplDispatch({ …, runFlow: flowTui.runFlow, resumeFlow: flowTui.resumeFlow, flowStatus: flowTui.flowStatus })`(补 `cli.mjs:451` 缺的三参,去掉写死的 `flowStatus:()=>"none"`)。
- `onInterrupt`(`cli.mjs:497`)在 abort 各 session 的同时调 `flowTui.abortAll()`;双击退出语义不变。

### 6.5 `app.mjs` / dispatch(改:输入路由)
**只读寻址 + 作答**规则,在 `dispatchWrapped`(`cli.mjs:470`)与/或 store 协作判定(纯文本行、`source:"human"`):
- 设 `label = smTui.currentLabel`;取 `st.sessions[label]`。
- 若该会话 `kind==="flow"`:
  - 有 `pendingQuestion` → 调 `flowTui.answer(flowId, label, line)`(resolve 引擎 Promise)+ `store.resolveFlowQuestion(label)`;**不** `pushUser`、**不** enqueue。
  - 无 `pendingQuestion` → 拒绝:`store.pushSystem("⑂ 这是 flow 会话,不能直接发消息(只能在它请求确认时作答)")`,不 enqueue。
- 否则走原有逻辑(发往 smTui 当前会话 + 回显 `❯`)。

输入框提示(`InputBar`)当焦点在待答 flow agent 上时显 `[⑂plan] approve ❯`(像素层,自适应,后置微调)。

`app.mjs` 的 Enter 主体不变(它只 `dispatch(line)`);路由判定集中在 dispatch 层,App 不感知 flow。

### 6.6 `FocusPane` / `AgentRail`(改:标记,极小)
- AgentRail:`kind==="flow"` 的卡标签前缀 `⑂`,其余渲染(running/awaiting/done 颜色、待你点)复用。
- FocusPane:头部 meta 标 `flow`;`pendingQuestion` 时把提示渲成醒目条(可复用 nudge 样式)。无新组件。

## 7. 关键数据结构

```
// store.sessions[label] 对 flow 卡:
{
  kind: "flow",
  flowId: "f3",            // 本次 flow 运行的短号
  agent: "planner",        // 步骤/角色名(来自 progress 事件)
  model: "deepseek-v4-pro",
  status: "running" | "awaiting" | "done" | "failed",
  entries: [ {type:"assistant", text}, {type:"nudge"|"approve", text}, {type:"output", text} ],
  pendingQuestion: null | "是否接受这个 diff?(y/n)",
  isStreaming: bool, turn, ms,
}

// flowTui 内部:
activeFlows: Map<flowId, { ctrl: AbortController, p: Promise<number> }>
pendingQuestions: Map<label, { resolve, reject }>
```

## 8. 端到端交互流程

**A. 自主跑完型** `/flow refactor`:
1. dispatch → `flowTui.runFlow(["refactor"])`;`flowId=f1`。
2. 引擎 `opening`/`start`/`delta` → `⑂planner`、`⑂impl` 卡冒出并流式(右栏可见,聚焦看正文)。
3. 引擎结束 resolve(exit 0)→ `store.endFlow(f1,{ok:true,summary})` → 系统消息「flow refactor 完成」+ 面包屑;卡片标 done 后撤。

**B. 交互 approve 型** `/flow review`:
1–2. 同上至撞 approve 门。
3. 引擎 `io.question("接受 diff?(y/n)", {signal})` → `⑂review` 卡 `awaiting` + 焦点流冒「flow review 要你确认 · ^G 去看」+ 状态栏 `1 flow`。
4. 用户 `Ctrl-G` 跳到 `⑂review`(`firstAwaiting`),看 capSink 投影的 diff 正文,输入框敲 `y` ⏎。
5. dispatch 命中 `kind==="flow"` + 有 `pendingQuestion` → `flowTui.answer(f1,"⑂review","y")` → 引擎 Promise resolve `"y"` → 续跑。
6. 结束同 A.3。

**C. 中止** 跑动中 `Ctrl-C`:第一次 → `onInterrupt` abort 各 session **且** `flowTui.abortAll()` → 在跑 flow 取消、待答问题 reject、卡标 failed/aborted;系统消息提示;1.5s 内再按一次才退出(既有语义)。

## 9. 错误处理与边界

- **flow 失败**(引擎 reject / 非 0 退出):`endFlow({ok:false})`;`stderr` 摘要经 capSink/系统消息可见;卡标 `failed`。
- **abort 时有待答**:`pendingQuestions` 全部 reject(`"flow aborted"`),引擎据 `signal` 收口;不悬挂。
- **重复作答 / 无待答作答**:§6.5 已规定(拒绝并提示),不会误发给后端。
- **并发**:多 flow → 多组卡(`flowId` 区分);`firstAwaiting` 仍只跳第一个待你,符合「逐个处理」。
- **卡片清理**:`endFlow` 后保留卡片至结果上屏,**延时 ~3s 后**从 `order`/`sessions` 撤掉(避免堆积);若期间被聚焦,延到失焦后撤。撤卡须同步 `syncFocus`(`cli.mjs:467`)逻辑,避免焦点指向已撤 label。
- **焦点指针**:`syncFocus` 已会把不在 `smTui._sessions` 的 label 从 store 撤掉——flow 卡不在 smTui 里,故 `syncFocus` 的现有 drop 逻辑必须改为**只撤「非 flow 且不在 smTui」**的 label(否则会误撤 flow 卡)。这是接线时的关键回归点。
- **resume**:`/resume <runId>` 经 `flowTui.resumeFlow`;runsRoot 与既有 `SYNOD_HOME` 对齐(参照 `cli.mjs:620`)。

## 10. 测试策略

**单测(node:test,跟随 `test/ui/tui/*` 约定):**
- `store`:`attachFlowAgent`/`appendFlowDelta`/`setFlowAgentStatus`/`setFlowQuestion`/`endFlow` 各自行为 + `firstAwaiting` 选中 flow 待你 + 清理后 `order` 不含该卡。
- `flow-tui`:tuiSink 三事件 → 正确 store 调用;`io.question` 收到 `answer()` 即 resolve、收到 `abortAll()`/signal 即 reject;`flowStatus` 计数。
- dispatch 路由:flow 会话 + 有待答 → 走 `answer` 不 enqueue;flow 会话 + 无待答 → 拒绝;非 flow 会话 → 原逻辑不变(回归)。
- `flow.mjs`:注入 `progress` 时用注入的、不传时用默认(回归)。

**冒烟扩展(`scripts/smoke-tui.mjs`,真 startTui + 假 flow):**
- 注入一个假 `runFlow`(直接驱动 tuiSink + 一次 `io.question`),断言:`⑂` 卡冒出 → 流式文本上屏 → approve 门置 `awaiting` 且冒泡 → 输入框作答后 `pendingQuestion` 清空、卡续跑 → `endFlow` 后系统消息含结果、卡片撤掉。

**门禁:** TUI 套件(`node --test --test-isolation=none test/ui/tui/*.test.mjs`)+ 冒烟全绿;非 TUI flow 既有套件(`test/flow*.mjs`、`test/cli.integration.test.mjs`)单文件隔离跑不回归。

## 11. 已定小决策

1. flow 伪会话用**同一个** `sessions` 表 + `kind:"flow"` 标记(最大复用)。
2. 作答 = 焦点在待答 flow agent 上按 **Enter**(输入框提示 `[⑂plan] approve ❯`)。
3. flow 结束后**延时自动撤卡**(结果已上屏),不留手动关。

## 12. 不在本期范围

- flow 步骤 DAG/进度图可视化(本期只逐 agent 卡 + 文本流)。
- flow 内部 agent 的自由对话(只读;仅能回答 approve/question)。
- flow 长输出的可滚动回看(依赖尚未实现的滚动视图,见 TUI 复制/滚动议题)。
- headless/CI(`--headless`、退出码 5、断点重放)行为变更——沿用引擎现状,TUI 不改。
- 同 flow 内同 `agent:model` 并发多 session 的分卡(并卡即可,v1 取舍;与现有文本 reporter 同口径)。

## 13. 开放问题 / 风险

- **`io.question` 归属哪张卡**:approve 时「当前活跃 agentLabel」需可靠判定(取最近 `delta`/`start` 的 label;若 approve 在任何 agent 产出前触发,则建一张 flow 主控卡 `⑂<flowName>` 承载)。实现时确认 approve.mjs 是否在 `io.question` 前有 `delta`。
- **approve 正文来源**:确认 approve 正文/diff 是经 `io.stdout`(→ capSink → 卡 output)还是 progress;两条路都已投影到 store,故可见性不受影响,但条目归类需对齐。
- **`syncFocus` 误撤**:§9 已标——接线时必须把「撤非 smTui label」收窄为「撤非 flow 的非 smTui label」,否则 flow 卡每次 dispatch 后被误撤。**最高优先回归点。**
- **像素层后置**:`⑂` 字形、卡内 approve 条样式、输入框 approve 提示,待 TUI 布局稳定后微调,不阻塞架构落地。

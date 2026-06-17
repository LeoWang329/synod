# flow 结束后续聊 设计

**日期:** 2026-06-17 · 分支 `feat/tui-p1` · 接 `2026-06-16-flow-groupchat-view` + `2026-06-17` 根因修正之后。

## 诉求与背景

真 TTY 实测反馈:"flow 运行结束后不要退出,可能还需要多轮对话。" 现状:flow `run()` 跑完后群聊卡 3s 自动撤除,且 flow 卡只读不能再发消息。

**架构事实(Explore 已查证):** flow 内部 agent 会话在 `run()` 返回时被强制释放——`src/flow/runner.mjs` 的 finally → `runtime.disposeRun()`(`runtime.mjs:233-253`)对所有 reuse 会话 `.close()`,外加 `closeAllLiveSessionsSync()` 全局兜底。**没有存活会话可接管**,故不走"接管真线程"(那需改引擎释放生命周期 + session-manager 加 adopt,~200 行、高风险)。session 契约(`.on/.send/.close/.summary`)flow 与 smTui 一致。

## 方案:另起真会话喂 transcript 续聊(纯加法,不碰引擎)

用户在**已结束**的 flow 卡里输入消息时:用该 flow **最后发言 turn 的真 agent+model** 新开一个 smTui 真会话,把刚才群聊的可见 transcript 作为首轮上下文喂进去,聚焦它。从此是普通交互会话——真正多轮续聊(流式/工具卡/Ctrl-G 全复用)。flow 卡留作只读历史,Ctrl-W 手动关。

**已确认决策:** ① 续聊对**最后发言 agent**;② **新开一张真会话卡 + 聚焦**,flow 卡留历史(不原地改造)。

**取舍(诚实):** 续聊会话不继承 flow 内部真线程(已释放),只带文字记录——"知道刚才聊了什么"但不继承变量/工具上下文。对"针对结果追问"够用;真线程级延续是后续(路径 a)。

## 改动

### 1. 不自动撤卡(`flow-tui.mjs`)
删 `.finally` 里的 `setTimeout(() => store.dropFlow(flowId), dropDelayMs)`。flow 结束后卡片以 `done`/`failed` 态保留。移除 `dropDelayMs` 参数(及 2 处测试/ smoke 调用)。`dropFlow` 保留作手动关闭机制。

### 2. 记录续聊身份(`store.mjs` + `flow-tui.mjs`)
flow 卡新增 `lastAgent: null, lastModel: null`(**真后端身份**,如 `omp` / `minimax/MiniMax-M3`,非展示用的 model 短名)。新增 store 方法 `noteFlowTurn(label, { speaker, agent, model })`:登记花名册(speaker)+ 记 `lastAgent=agent, lastModel=model`。flow-tui 在 `start` 事件调它(替代 `noteFlowAgent`);`opening` 仍调 `noteFlowAgent`(仅花名册)。

### 3. 续聊构造(新模块 `src/ui/tui/flow-continue.mjs`,纯函数,可单测)
```
buildContinuation(card, line, { defaultAgent, maxEntries = 60 }) → { agent, model, seed }
```
- `agent = card.lastAgent || defaultAgent`;`model = card.lastModel || null`。
- transcript:取 `card.entries` 末 `maxEntries` 条,按类型转文本(`assistant`→`<speaker>: <text>`、`output`→`[输出] …`、`approve`→`[确认] …`、`user`→`你: …`)。
- `seed = 以下是刚才 flow「<flowName>」的对话记录:\n\n<transcript>\n\n请基于以上继续。用户追问:\n<line>`。

### 4. cli.mjs 接线(`dispatchWrapped` flow 卡分支)
聚焦 flow 卡、纯文本 human 行:
- `pendingQuestion != null` → `flowTui.handleHumanLine`(作答,既有)。
- `status === "done"/"failed"` → **续聊**:`const {agent,model,seed}=buildContinuation(fs,line,{defaultAgent})`;`const label=await smTui.open({agent,model})`(触发 `onSessionOpen`→`store.attachSession`);失败 `pushSystem`;否则 `smTui.use(label)`+`store.setFocus(label)`+`store.pushUser(label,line)`(回显用户原话)+`smTui.enqueue({target:label,msg:seed})`(后端收带上下文的 seed)。`pushSystem(续聊 <flowName> → <label>)` 面包屑。
- 其它(running 无待答)→ `handleHumanLine`(拒绝系统消息,既有)。

`/close <flowlabel>`(含 Ctrl-W 触发的)→ 若目标是 flow 卡,`store.dropFlow(fs.flowId)`(flow 卡不在 smTui,普通 `/close` 走不通)。

### 5. FocusPane 提示(`FocusPane.mjs`)
flow 卡 `done`/`failed` 时,流末尾加一行 dim 提示:`flow 已结束 · 输入消息可继续与 <最后发言人> 对话(将新开会话)· ^W 关`。

### 6. 测试 + smoke
- `flow-continue.test.mjs`(新):`buildContinuation` 取 agent/model/seed 正确、transcript 含各类型、空 lastAgent→defaultAgent、maxEntries 截断。
- `store.flow.test.mjs`:`noteFlowTurn` 记 lastAgent/lastModel + 花名册。
- `flow-tui.test.mjs`:flow 结束后卡片**保留**(不自动撤);start 经 `noteFlowTurn` 落 lastAgent/lastModel。移除 dropDelayMs 相关。
- `smoke-tui.mjs` 第 8 节:把"结束后撤卡"改为"结束后留卡 + 卡上有 lastAgent/lastModel";续聊本身(走真 dispatchWrapped+smTui)由单测 + 人工 TTY 覆盖(smoke 的 dispatch 是 mock,不含 cli 续聊接线)。

## 已知限制(不在本次)
- 续聊不继承 flow 内部真线程(只喂文字记录)。
- transcript 过长按 `maxEntries` 截断(取末段)。
- 续聊固定对最后发言 agent;选参与者留后续。
- `/resume` 历史不重建(既有限制)。

## 门禁
TUI 套件 + flow+cli + smoke 全绿;经 agent-bridge codex 复核。

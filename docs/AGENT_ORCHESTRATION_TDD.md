# Agent 编排(转发 + 受控拉起)— TDD 开发计划

> 把 [`TODO.md`](TODO.md) 的两条 agent 自主编排需求落成测试先行的开发增量:
> **A. agent 间自动转发 / 编排(relay)**;**B. agent 受控拉起 / 管理另一个会话(标记驱动)**。
> 这两条都改 `src/cli.mjs`(REPL),纪律是:**先把纯逻辑抽出来单元测,再接进 REPL,最后真 agent e2e**。
> 起草 2026-06-07。状态:计划。已纳入 codex / deepseek 评审(R0 抽够厚 + 注入 openBackend、relay 按真实 turn 触发、B1 抗"agent 自述语法"误触发)。

## 0. 测试策略 + 先决重构

- **Tier 1 单元**:`test/*.test.mjs`,纯函数 + fake 会话(EventEmitter),对齐 `parse-args.test.mjs` 的"抽纯函数测"风格。
- **Tier 2 e2e**:`scripts/acceptance.mjs` 追加用例,`doctor()` skip-if-missing,`runCli()` 喂 stdin 断言 stdout 路由。

**先决重构(R0,characterization-first)**:relay 和 marker 派发都要复用"开会话 / 入队 / 列表 / 关"。当前这些内嵌在 `cli.mjs` 的 REPL 闭包里、且 `openBackend` **写死(无注入)**,难单测。
- **两点必须一起做(评审采纳——否则抽出来太薄,单元绿、接回真 CLI 就炸)**:
  - ① **让 `openBackend` 可注入**:把入口参数化成 `main({ openBackend, stdin, stdout })`,默认真实。
  - ② 抽出的 `session-manager` 要**够厚**——含**事件接线**(lineBuf、sendQueue、`status`→flush→重绘 prompt),**不只是 Map 增删**(否则核心复杂度没被测到)。
- **Red — 刻画测试补全**(不能只锁 `/sessions`):`scripts/acceptance.mjs` 加 ① 单会话发消息→拿到输出;② `@label` 定向正确 + `@all` 广播;③ `/use` 切换;④ `Ctrl-D` 退出**无残留子进程**。锁死现状(绿)。
- **重构**:抽 `src/session-manager.mjs`(open/enqueue/get/list/closeAll **+ 事件接线**),`cli.mjs` 调它;`openBackend` 走注入。
- **Green**:刻画测试仍绿 + `test/session-manager.test.mjs`(注入 fake `openBackend`,测 open/enqueue/list/close **及事件接线**)。
- **DoD**:行为不变,**含事件接线**的逻辑可单测。A、B 的共同地基。

---

# A. agent 间自动转发 / 编排(relay)

> **设计决定(写进测试)**:relay 在源会话**一轮结束时**(`status` 转 idle)取 `result()` 的**完整文本**,作为新 prompt 入队到目标会话——**不转发原始 delta 流**(逐字转发会让两个 agent 输出交织成乱码)。这与"节点=send→result"模型一致。

## A1 · relay 指令解析(纯函数)
- **Red** — `test/relay-parse.test.mjs`:`parseRelay("/relay omp->codex")` → `{from:'omp', to:'codex'}`;非法(无 `->`、空端、自指 `a->a`)→ 报错。仿 `parseArgs` 风格。
- **Green**:`parseRelay` 纯函数。

## A2 · relay 接线(turn 完成 → 转发)
- **Red** — `test/relay.test.mjs`(两个 fake 会话):
  - 建 A→B relay;A **完成一次真实 turn**(`sendQueue.enqueue(...)` resolve)→ 断言 B 的 `enqueue` 收到 **A 这轮的 result 文本**(不是逐 delta)。
  - **不能在裸 `status:idle` 上转发**:断言 A 的 ready / abort / close 引起的 idle **不触发**转发(否则空转/重复转发——codex#3)。
  - **防回声环**:B 的输出**不**回流给 A(除非显式建 B→A);断言无意外入队。
  - **防成环**:已存在 A→B 时建 B→A,断言被拒(成环检测)。
  - 转发的消息带来源标注(便于 B 知道这是 A 的产物)。
- **Green**:`src/relay.mjs`——挂在源会话的 **turn 完成点**(`enqueue(...).then(result)`),**非裸 `status` 事件** → 目标 `enqueue`;注册表防环。
- **DoD**:Tier 1 绿;只按**真实 turn** 转发、无环无回声。

## A3 · REPL 命令 + 生命周期 + e2e
- **Red**:
  - 单元 `test/relay-registry.test.mjs`:`/relay`、`/unrelay`、`/relays`(增删列),会话 close 时自动解绑(断言不向已关会话转发)。
  - e2e(`acceptance.mjs`,skip-if-missing):开 omp+codex、`/relay omp->codex`、给 omp 发任务 → 断言 codex 收到并产出。
- **Green**:`cli.mjs` 接 `src/relay.mjs` + 命令。
- **DoD**:单元绿;有 agent 时 e2e happy-path 过。

---

# B. agent 受控拉起 / 管理另一个会话(标记驱动)

> **设计决定**:agent 在输出里放**严格唯一的标记**表达控制意图;Synod 在 `session.on("event"|"delta")` 旁路扫描、解析、派发到**已有的** open/enqueue 路径。不走 MCP/tool-call。

## B1 · 标记解析(纯函数,bug 高发区 → 测试最重)
- **设计要求(评审采纳)**:标记文法必须**抗误触发**——agent 被告知语法后,**会在解释/引用时原样输出标记**(deepseek#4,上线第一天就踩)。可能要 **nonce/握手**(本轮被显式授权才认),B1 的文法设计必须正面解决,不能假装散文不撞。
- **Red** — `test/control-marker.test.mjs`:
  - `extractControlCommands(text)` 识别约定标记,返回命令数组;多个 → 按序全解析。
  - **假阳性(关键)**:① 散文出现"synod";② 代码块里贴的示例标记;③ **agent 正在解释"怎么用这个标记"而原样输出 `@@synod {...}`** → 全部**不**当指令(断言空)。**第③条是真杀手,必须测。**
  - **分片重组**:标记被 delta 切成两段 → 只在**完整 turn 文本**上解析(不在裸 delta 上),断言重组后正确(codex#5)。
  - **去重**:重复 event/result 携带同一标记 → 只派发一次。
  - **健壮**:标记内 JSON 损坏 → 跳过该条 + warning,不抛、不影响其余。
- **Green**:`src/control-marker.mjs` 纯解析器(严格、抗误触发文法)。
- **DoD**:Tier 1 绿,覆盖"agent 自述语法"/分片/去重/损坏。

## B2 · 派发器(命令 → 复用 open/enqueue)+ 护栏
- **Red** — `test/control-dispatch.test.mjs`(fake session-manager):
  - `{cmd:'open', agent:'omp', task}` → 调 manager.open + enqueue(断言)。
  - `{cmd:'send', to, msg}` → enqueue 到已有会话;目标不存在 → **记错误不崩**。
  - **护栏**:超过最大会话数 / 超嵌套深度 / `agent|model` 不在白名单 / 请求 `write` 但默认只读 → **拒绝并记 log**(逐条断言)。
- **Green**:`src/control-dispatch.mjs` 复用 R0 的 session-manager。
- **DoD**:Tier 1 绿;护栏逐条生效。

## B3 · 接线(在完整 turn 文本上派发)+ 输出处理
- **Red** — `test/control-wire.test.mjs`(fake 会话):
  - 一次 turn 完成后,在**组装好的完整 turn 文本**上 extract+dispatch(**不**在裸 delta/event 上——避免分片/重复,与 A2、relay 同样按 turn 粒度)。
  - **输出去向策略**:子会话产物按选定默认(回给人 / 喂回发起 agent)路由——断言走选定路径。
  - **人侧输出(坦白)**:delta 是**实时逐字**给人的,标记在流里**当时无法剥离**;本期接受"标记会出现在流里、但只在 turn 结束解析后才 dispatch",**不假装能 mid-stream 剥离**(避免过度承诺)。
- **Green**:`cli.mjs` 在 turn 完成点(同 relay)取完整文本 → marker 通道。
- **DoD**:Tier 1 绿;按 turn 派发、路由明确。

## B4 · 防失控 + e2e
- **Red**:
  - 单元 `test/control-safety.test.mjs`:一连串标记"风暴" → 受最大并发/深度上限钳制,**不 fork 炸**(断言被拒计数);read-only 默认下请求 write 会话被挡。
  - e2e(`acceptance.mjs`,skip-if-missing):用 prompt 引导真 agent 输出一个 `open` 标记 → 断言 Synod 真开出子会话并能拿到结果。
- **Green**:护栏阈值 + e2e 接线。
- **DoD**:单元绿;有 agent 时 e2e happy-path 过。

---

## 增量依赖与顺序

```
R0(抽 session-manager,刻画测试) ─┬─ A1→A2→A3   (relay)
                                  └─ B1→B2→B3→B4 (标记驱动)
```
R0 是公共地基,先做。A 与 B 之后可并行;B1(解析器)是 B 的核心、测试最密。

## 风险(进 Red 测试覆盖)

- **逐 delta 转发/派发会乱码、分片、重复** → A2 与 B 全部固定为"按**完整 turn** 处理",测试锁死分片重组 + 去重。
- **agent 自述标记语法 → 误开会话**(真杀手)→ B1 抗误触发文法(可能 nonce/握手)+ "agent 解释语法"假阳性测试。
- **session-manager 抽太薄 → 单元绿、接回真 CLI 炸** → R0 抽够厚(含事件接线)+ 注入 `openBackend`,刻画测试补 `@label`/`@all`/`/use`/`Ctrl-D`。
- **agent fork 炸会话** → B4 上限钳制测试。
- **改 cli.mjs 回归** → R0 刻画测试先锁现状,重构保持绿。

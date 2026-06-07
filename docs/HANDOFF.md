# 交接手册(Synod)

> 给"清空上下文后的我 / 另一个接手 agent"。读完这份就能接着干,不用重建上下文。
> 写于 2026-06-07,**最后更新 2026-06-07(地基1/2 + relay A1–A3 + flow F0–F2 全部落地并提交)**。**先读本文,再读下面「文档地图」里的具体文档。**

## TL;DR(一句话现状)

Synod 在落地**用原生 JS 编排固定工作流的引擎** + 两条 **agent 自主编排**能力,用 **deepseek 开发 / codex 审核 / Claude Code 规划验收** 的三方协作建。**已完成并提交**(都过 codex 多轮审 + 亲跑测试验收):**地基1**(flow 测试替身)、**地基2/R0**(cli 可注入 + 抽 session-manager)、**编排 relay**(A1+A2 核心 + A3 接 cli + 真 agent e2e)、**flow 引擎 F0–F2**(ctx+logger+DI、`agent()`/`bash()` 原语、loader+词法 import lint+runner)。
**两条分支,均已本地提交、未推送**:Track1(地基2+relay)在 `flow-engine-foundations`(主树 `/Users/leo/projects/synod`,`npm test` 104 + `acceptance` 42 = A1–A8);Track2(flow F0–F2)在 `flow-engine-core`(worktree `/Users/leo/projects/synod-flow`,`npm test` 146)。
**下一步**:编排 **B 支(标记驱动 B1–B4)** + flow **F3–F7**(见末尾「下一步待办」)。daemon 已是 0.6.0 且稳定。

## Synod 是什么(够用版)

自包含的多 agent 协作流式 CLI(纯 Node 20+,零三方依赖,**刻意不用 MCP**)。内置后端 `src/backend.mjs` 用子进程拉起本机 `omp`/`codex`,`session` 是 EventEmitter,`session.send(prompt,{wait:true})` 等一轮跑完返回完整文本。入口 `src/cli.mjs` 是多会话 REPL。详见 `README.md` / `docs/PROTOTYPE.md` / `docs/USAGE.md`。MVP1 已落地。

## 本次会话做了什么(全景)

1. 答疑 Synod 用法 → 写了 `docs/USAGE.md`。
2. 讨论一系列需求,沉淀成设计文档:**flow 工作流引擎** + **agent 间转发/编排** + **agent 受控拉起会话**。
3. 给 flow 引擎写了**设计**(`WORKFLOW_ENGINE.md`)+ **写法规则/模板**(`FLOW_AUTHORING.md`),两次拉 codex+deepseek 评审并采纳修订。
4. 把两块需求写成两份 **TDD 开发计划**,又经 codex+deepseek 评审采纳修订。
5. 把两条公共地基拆成 **开工 checklist**(`FOUNDATIONS_CHECKLIST.md`),按**角色分工**开始执行:**deepseek 开发 / codex 审核 / 我规划协调验收**。
6. 完成地基 1(见下)。
7. (并行的另一件事)从消费方角度给 agent-bridge MCP 写了反馈清单 → `/Users/leo/projects/agent-bridge/docs/CONSUMER_FEEDBACK.md`,**用户已据此自行实现 0.6.0**(别动那文件)。

## 文档地图(按这个顺序理解)

| 文档 | 是什么 | 状态 |
|---|---|---|
| `docs/TODO.md` | 待办索引:工作流引擎 + 两条编排需求,链到下面各文档 | 索引 |
| `docs/WORKFLOW_ENGINE.md` | flow 引擎**设计**:节点模型、原语、三种回退粒度、人在环修订(方案A)、run log、ctx 约束、M0–M4 计划 | 设计定稿 |
| `docs/FLOW_AUTHORING.md` | **怎么写一个 flow**:目录/命名、必须导出、可用原语、硬规则(防 agent 乱写)、模板、自检清单 | 定稿 |
| `docs/WORKFLOW_ENGINE_TDD.md` | flow 引擎 **TDD 计划** F0–F7(Red→Green→Refactor,对齐现有测试约定) | 已过评审 |
| `docs/AGENT_ORCHESTRATION_TDD.md` | relay + 标记驱动编排的 **TDD 计划**(R0 地基 + A/B 两支) | 已过评审 |
| `docs/FOUNDATIONS_CHECKLIST.md` | 两条公共地基的**开工 checklist** + 角色分工 + 编排协议 | **地基1✅ / 地基2✅** |
| `docs/USAGE.md` | Synod 使用手册 | 定稿 |
| `docs/HANDOFF.md` | 本文 | — |

> 注意:以上设计/计划 docs 已在 `bc53ed6` 提交。Track1 的代码在 `flow-engine-foundations`(主树),Track2 的 flow 代码在 `flow-engine-core`(worktree `synod-flow`),**均已本地提交、未推送**。`git worktree list` 可见两棵树。

## 当前执行状态(全部已交付 + 提交)

**Track 1 · `flow-engine-foundations`(主树)** — `npm test` 104 / `acceptance` 42(A1–A8):
- **地基1**:`test/helpers/fake-backend.mjs`(`makeFakeOmpProc` 进程级 + `FakeSession`/`fakeOpenBackend` 会话级 + 契约注释)、`test/helpers/fake-backend.test.mjs`。
- **地基2 / R0**:`src/cli.mjs` 入口改为可注入 `main({openBackend,stdin,stdout,stderr,argv})`;抽出 `src/session-manager.mjs`(open/enqueue/use/list/drainAll/flushAll/closeAll + 事件接线 lineBuf/sendQueue/status→flush+onIdle,`agentCounters` 实例内,`drainAll` quiescence 循环 size+1 上限超限 throw);`test/session-manager.test.mjs`(注入 fake 测事件接线);`scripts/acceptance.mjs` 加 A6/A7(交互路由刻画)。
- **编排 relay(A1–A3)**:`src/relay.mjs`(`parseRelay` + `createRelayRegistry`:DFS 防环、方向性防回声、`[relay from X]` 来源标注、`removeForLabel`);在源会话**真实 turn 完成点**(session-manager `onTurnComplete` 钩子)转发完整 result 文本(非裸 delta/idle);cli 接 `/relay /unrelay /relays` + 关会话解绑 + 退出 quiescence drain;`test/relay-parse|relay|relay-registry.test.mjs` + `acceptance` A8(真 agent relay e2e)。

**Track 2 · `flow-engine-core`(worktree `synod-flow`)** — `npm test` 146:
- **F0**:`src/flow/ctx.mjs`(纯数据工厂,递归校验拒绝 function/Date/Map/循环引用)、`src/flow/logger.mjs`(JSONL step 生命周期 + `logSession` + 大产物 `outputRef`/`inputRef` artifact 分离 + 必填字段校验 + `meta` 保留键/纯数据校验)、`src/flow/runtime.mjs`(`createRuntime` DI 容器)。
- **F1**:`src/flow/api/agent.mjs`(`agent()`:open→send(wait)→text→close;`reuse` 存 `runtime._runs` per-run 活态、`disposeRun` 收尾;泄漏安全 try/finally;成功路径 logStep loud)。
- **F2**:`src/flow/loader.mjs`(发现/命名/校验 + **手写状态机词法 import/export 白名单 lint**,跳注释/字符串/模板、排除 `import()`/`import.meta`、堵静态 re-export 与本地导出后接坏 import;regex 字面量是已知文档化限制)、`src/flow/runner.mjs`(`runFlow` 设/清 current-run + `disposeRun`)、`src/flow/api/bash.mjs`、`src/flow/current-run.mjs`(模块级活态,顺序单 run;并发需 AsyncLocalStorage)、`src/flow/index.mjs`(`synod/flow` 入口,经 `package.json` exports 自引用);fixtures + `flow.discovery|run|bash.test.mjs`。

**任务清单**(harness 内 Task,清空上下文后会没,以此为准):T1.1–T1.3 ✅、T2.1–T2.4 ✅、relay A1+A2 ✅、A3 ✅、flow F0 ✅、F1 ✅、F2 ✅。**全部完成并提交。**

## 角色分工(三方,务必照此)

这套 build 用三个角色协作,**职责严格分开,不串**:

### 1. Claude Code(我)= 规划 + 协调调度 + 监控 + 验收
- 把 checklist 拆成带边界和验收标准的**任务规格**;决定先做哪个、依赖顺序。
- **派活**给 deepseek、把审核**派**给 codex;`Task` 工具跟踪进度。
- **亲自验收**:每步自己跑 `npm test` + 查 `git diff` 看产物,**不信任 agent 的回传文本**。
- 对 codex 的审核意见**分诊**:判断哪些采纳、哪些反驳,再决定是否打回 deepseek。
- 闭环把关;遇 daemon 冲会话时按"查盘 + 只补还差的"恢复。
- **不亲自写实现代码**——实现交给 deepseek(这是用户定的分工)。

### 2. deepseek-v4-pro = 开发(写代码 + 写测试)
- 会话:`agent:"omp"` + `model:"deepseek/deepseek-v4-pro"` + `effort:"xhigh"` + **`write:true`**。
- 按我给的任务规格写代码和测试;**只动任务范围内的文件**(我会在规格里写死边界,如"不碰 `src/`")。
- 完成后报告:改/建了哪些文件 + 自跑 `npm test` 结果。
- **不做审核、不自行扩大范围**。

### 3. codex = 审核(只读,挑问题)
- 会话:`agent:"codex"` + **`write:false`**(只读,**不改代码**)。
- 审 deepseek 产出的代码与测试质量:挑 fidelity 不对齐、"测了等于没测"的假信心、漏测、过度设计;给**具体位置 + 怎么改**。
- 通过就明确回 "OK";有问题就列清单。**不写实现代码。**
- (实战印证:codex 在 T1.2 审出 5 处 FakeSession 与真实 Session 不对齐,正是它的价值所在。)

### 每个任务的闭环
```
我写任务规格
  → deepseek 开发(write,非阻塞派发,短超时轮询)
  → 我 git diff + 跑 npm test 验产物（不信回传）
  → codex 审（只读，挑问题）
  → 有问题 → 我分诊 → 打回 deepseek 修 → codex 复审
  → 无问题 + 测试绿 → 我验收 → 下一任务
```

## agent-bridge 运维要点(踩过的坑,务必遵守)

- 用 `agent_bridge_*` MCP 工具派活。开发用 deepseek = `agent:"omp"` + `model:"deepseek/deepseek-v4-pro"` + `effort:"xhigh"` + `write:true`;审核用 `agent:"codex"` + `write:false`。
- **派活 `wait:false` + 短超时 `agent_bridge_wait`(5–10 分钟)轮询**,没完返回 `{timed_out/timedOut,...}` 不报错,再 wait;别死等。
- **产物以盘为准**:`git diff` + 自己跑 `npm test`,**不信回传文本**(回传 text 不含 filesChanged)。
- **daemon 重启会冲掉会话**(0.6.0 已稳,但仍可能发生):遇到 "Unknown session" 先 `agent_bridge_status mine:true` 看是否被冲;**文件已落盘,只补"还差的部分",别从头来**。0.6.0 返回值是 camelCase(sessionId/logFile/lastTurn/charCount/textRef…);别对 omp 会话拉全量 recentEvents,用 `result`/`wait`。
- **别 `pkill omp`**(会误杀开发会话);清理用 `close_session`。用完**必须关**自己开的会话。
- 别对 omp 会话调 `agent_bridge_status` 带全量 `recentEvents`——回传巨大(P1 体积问题);用 `result`/`wait`。
- 详细用法见 skill:`~/.claude/plugins/cache/agent-bridge/agent-bridge/0.5.7/skills/agent-bridge/SKILL.md`。

## 不要重新争论的关键决定(已拍板)

- **Synod=底座(执行+原语+日志+清理),flow `.mjs`=控制核心**;控制流用原生 JS(await/Promise.all/while/if),**不发 DSL、不引 MCP**。
- **回退 = 把"错在哪"喂回 agent 让它定向修正**;**整段回滚(snapshot/worktree)已否决**;附带副作用用 `defer` 清。
- **会话默认一次性**,打磨/修订型显式复用;**复用=优化非依赖**(每轮全文显式传入,会话掉了也正确)。
- **人在环修订 = 方案A**(自然语言定位,不做结构化寻址)。
- **run log = day-one JSONL**(step 生命周期+会话事件+大产物 artifact 分离);**`ctx` 纯数据可序列化**(为以后持久化留门)。
- **import 白名单 = AST lint 级,非安全边界**(动态 `import()` 不拦,文档写明)。
- **relay 与标记驱动都按"完整 turn"处理**,不在裸 delta 上(避免分片/重复);标记文法要**抗 agent 自述语法误触发**(可能 nonce/握手)。
- 本期**不做**持久化/恢复(留门)、**不做** agent 自主编排(那是 TODO 里的两条,本期先做人写死的确定性引擎)。

## 下一步待办(接手从这里开始)

两条线都可继续并行(文件不相交:Track1 改 cli/orchestration,Track2 改 `src/flow/`),仍按 deepseek 开发 / codex 审 / 我验收的闭环跑。

**Track 1 · 编排 B 支(标记驱动)** — 在 `flow-engine-foundations`(主树),依据 `docs/AGENT_ORCHESTRATION_TDD.md` 的 B1–B4:
- **B1** `src/control-marker.mjs`(纯解析器,**测试最重**):识别 agent 输出里的严格唯一标记 → 命令数组。**核心难点:抗误触发**——agent 被告知语法后会在解释/引用时原样输出标记(代码块示例、"怎么用这个标记"的散文),必须**不**误当指令;在**完整 turn 文本**上解析(非裸 delta);去重;损坏 JSON 跳过+warning 不抛。可能需 nonce/握手。
- **B2** `src/control-dispatch.mjs`:命令 → 复用 session-manager 的 open/enqueue;护栏(最大会话数 / 嵌套深度 / agent|model 白名单 / 默认只读拒 write)逐条。
- **B3** 接线:turn 完成点(同 relay 的 onTurnComplete 粒度)extract+dispatch;输出去向策略;坦白"标记在实时流里当时无法剥离"。
- **B4** 防失控 + 真 agent e2e(引导 agent 吐一个 open 标记 → 真开出子会话)。

**Track 2 · flow F3–F7** — 在 `flow-engine-core`(worktree `synod-flow`),依据 `docs/WORKFLOW_ENGINE_TDD.md`:
- **F3** `src/flow/api/approve.mjs`:人审 + abort token,契约即**非阻塞事件驱动**;**必须有真实 `PassThrough`+`readline` smoke**(断言 approve 等待期间 fake agent 的 delta 仍到达、readline 不抢输入)。
- **F4** `agentLoop` + 跨节点回退(喂回反馈、maxTurns 上限)+ `defer`(LIFO 逆序清理)。
- **F5** `reviseWithHuman`(方案A 自然语言定位;复用=优化非依赖,每轮全文显式传入;/abort 优雅退出不杀进程)。
- **F6** `runWorkflow` 嵌套(父拉子拿返回值,log 带 parentRunId)+ 深度/并发护栏。**注意**:current-run 现在是模块级活态(已支持嵌套 save/restore),并发仍需换 `AsyncLocalStorage`——F6 真要并发就在这儿处理。
- **F7** `src/flow.mjs` 入口(`--list` 列名字+描述、跑 flow)+ `scripts/acceptance-flow.mjs` 真 agent e2e。

## 怎么恢复

1. 读本文 + `docs/AGENT_ORCHESTRATION_TDD.md`(B 支)/ `docs/WORKFLOW_ENGINE_TDD.md`(F3+)。
2. 确认绿态:主树 `npm --prefix /Users/leo/projects/synod test` = 104;worktree `npm --prefix /Users/leo/projects/synod-flow test` = 146;`git -C <tree> status` 应干净。`agent_bridge_doctor` 确认 omp/codex 可用。
3. 选一条线(或两条并行)→ 写任务规格 → 按上面的三方闭环跑。Track1 的活在主树,Track2 的活在 worktree(派 deepseek 时 cwd 给对)。
4. 合并:两分支文件不相交,最终各自合回 main 不冲突。

## 关于用户

- **全程中文交互**。
- 决策果断、重视"别绑死单一 agent / 别给假信心 / 诚实标注不确定"。
- agent-bridge 也是用户开发的;Synod 的开发流程本身就用多 agent 协作来建。

# 交接手册(Synod)

> 给"清空上下文后的我 / 另一个接手 agent"。读完这份就能接着干,不用重建上下文。
> 写于 2026-06-07。**先读本文,再读下面「文档地图」里的具体文档。**

## TL;DR(一句话现状)

Synod 在规划一个**用原生 JS 编排固定工作流的引擎** + 两条 **agent 自主编排**能力;设计/写法规则/TDD 计划/开工 checklist 都写好了,并已用**多 agent 协作**开始落地:**地基 1(flow 测试替身)已完成并通过 codex 审核(`npm test` 43 pass);地基 2(改 `src/cli.mjs`)暂停,等用户把 agent-bridge daemon 升级 0.6.0 弄稳后再开工。**

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
| `docs/FOUNDATIONS_CHECKLIST.md` | 两条公共地基的**开工 checklist** + 角色分工 + 编排协议 | **执行中(地基1✅ / 地基2⏸)** |
| `docs/USAGE.md` | Synod 使用手册 | 定稿 |
| `docs/HANDOFF.md` | 本文 | — |

> 注意:**以上 docs 全部 untracked、未提交**;`test/helpers/` 也 untracked。HEAD = `cfe781a`。用户没要求提交,别擅自 commit。

## 当前执行状态

**已交付(地基 1 · flow 测试替身)**——新增两个文件,`src/` 没动:
- `test/helpers/fake-backend.mjs`:`makeFakeOmpProc`(进程级 fake,从 backend.contract.test 抽出)+ `FakeSession` / `fakeOpenBackend`(**会话级 fake,flow 测试主力**)+ 顶部 89 行**契约注释**。
- `test/helpers/fake-backend.test.mjs`:FakeSession 自测。
- **`npm test` = 43 pass / 0 fail**(自己跑过)。codex 审出 5 处 fidelity bug→deepseek 修→codex 复审 "T1.2 OK"。

**任务清单**(harness 内 Task,清空上下文后可能不在了,以此为准):
- ✅ #1 T1.1 抽取 makeFakeOmpProc / ✅ #2 T1.2 FakeSession / ✅ #3 T1.3 契约注释
- ⏸ #4 T2.1 cli.mjs 刻画测试 / #5 T2.2 main 可注入 / #6 T2.3 抽 session-manager / #7 T2.4 session-manager 单测

**暂停原因**:地基 2 要改 `src/cli.mjs`(生产代码)且 T2.1 刻画测试依赖真 agent,而 agent-bridge daemon 正在升级 0.6.0、会话被重启冲掉过 3 次。等用户说"继续地基 2"再开工。

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
- **daemon 会重启冲掉会话**(用户在升级 0.6.0):遇到 "Unknown session" 先 `agent_bridge_status mine:true` 看是否被冲;**文件已落盘,只补"还差的部分",别从头来**。
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

## 怎么恢复

1. 读本文 + `docs/FOUNDATIONS_CHECKLIST.md`(看 checkbox 进度)。
2. 确认绿态:`npm test` 应 43 pass;`git status` 应只见 untracked docs + `test/helpers/`。
3. 用户说"继续地基 2" → 从 **T2.1** 起按上面的编排协议跑(先确认 daemon 稳了:`agent_bridge_doctor`)。
4. 地基 2 之后,按 `WORKFLOW_ENGINE_TDD.md`(F0→F7)和 `AGENT_ORCHESTRATION_TDD.md`(A/B)继续。

## 关于用户

- **全程中文交互**。
- 决策果断、重视"别绑死单一 agent / 别给假信心 / 诚实标注不确定"。
- agent-bridge 也是用户开发的;Synod 的开发流程本身就用多 agent 协作来建。

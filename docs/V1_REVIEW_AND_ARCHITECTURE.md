# Synod 代码审查报告 + 正式版(V1)架构设计

> 写于 2026-06-10。基线:`main` @ `c90cfdf`,`npm test` 576/576 绿。
> 本文是两件事的合订本:**(A) 对 MVP 现状的全量代码审查**(架构、逻辑 bug、孤儿进程专项、改进点);**(B) 从 MVP 走向正式项目的架构设计**(CLI 客户端、JS flow、agent 可配置、Claude Code agent-team 式 leader/member 编排)。作为后续开发与改进的指导文档。

---

## 0. TL;DR

- **现状质量超出典型 MVP**:全链路 DI、fake backend 契约测试、turn 级(非裸 delta)编排、fence 抗误触发、loader 词法 lint、defer/纯 ctx 等设计都站得住。**可以演进,不需要重写。**
- **最大架构债**:会话获取有**两条平行路径**(REPL 走 session-manager,flow 走 openBackend 直连),生命周期保障不一致——这是孤儿进程隐患的共同根因(P0-2/P0-4)。正式版必须收敛到单一 SessionPool + ProcessSupervisor。
- **P0 级 bug 共 5 个**,全部和"退出不残留子进程"或"挂死"有关:uncaughtException 不清理、flow 会话不在 SIGINT 清理范围、OMP waitIdle 可无限挂死、无 SIGTERM/SIGHUP 处理、POSIX 退出路径 SIGKILL 兜底实际不生效。
- **leader/member 团队功能的最大现存缺口**:fence 命令的执行结果(尤其 `/open` 产生的 label)**不回传给发起命令的 agent**——leader 开了子会话却不知道它叫什么,根本无法继续协调。正式版的 MessageBus 设计以此为第一性需求。
- 路线图按阶段交付(2026-06-10 按用户要求重排):**阶段 0 进程治理(止血,前置)→ 阶段 1 Workflow(backend 插件化 + 配置 + flow 强化 + UI v1)→ 阶段 2 Agent Teams → 阶段 3 产品化收尾**;持久化/恢复继续留门。阶段 0/1 已出 TDD 计划(`docs/superpowers/plans/`),UI 设计见 `docs/CLI_UI_DESIGN.md`。
- **三种使用面(REPL 主持人 / workflow / team)合一内核、并列入口,不拆成隔离产品**——建议与论证见 §4.10。

---

## 1. 现状架构审查

### 1.1 分层与模块职责(现状)

```
cli.mjs ── REPL / --task / SIGINT / 退出闭环
 ├── repl-dispatch.mjs    命令分发(human 与 agent-fence 两个 source,fence 带 guardrails)
 ├── session-manager.mjs  label 分配 / 行缓冲 / per-session 串行 sendQueue / drainAll 静默检测
 │      └── backend.mjs   OmpSession / CodexSession(EventEmitter,spawn 子进程,进程树清理)
 ├── relay.mjs            转发规则图(DFS 防环、方向性)
 ├── control-fence.mjs    ```synod 围栏解析(R1 首行门、去重、CommonMark 级 fence 识别)
 ├── control-wire.mjs     turn 完成点:relay + fence 命令分发(fire-and-forget)
 └── flow.mjs (/flow 入口)
        └── flow/         runtime(DI 容器) + 原语(agent/bash/agentLoop/approve/
                          backtrack/reviseWithHuman/runWorkflow/defer)
                          + loader(发现/词法 import lint) + logger(JSONL+artifact)
                          + current-run(模块级单例)
                          └── backend.mjs(openBackend 直连,⚠️ 绕过 session-manager)
```

**关键观察:两条会话路径。** REPL/relay/fence 的会话由 session-manager 持有(`gSessions` 可被 SIGINT 处理器看到);flow 原语开的会话只活在 flow runtime 的局部闭包/`_runs` Map 里,**任何全局清理机制都看不到它们**。MVP 用 `_pendingFlows` 在正常 `/exit` 路径上等 flow 自己收尾,但信号/崩溃路径完全没覆盖(详见 §2)。

### 1.2 做得好的地方(正式版要保住的资产)

| 资产 | 所在 | 价值 |
|---|---|---|
| 全链路依赖注入 | cli/session-manager/flow runtime | 576 个无真 agent 的测试的根基;正式版扩 backend 插件直接受益 |
| fake-backend 契约测试 | test/helpers/ | 替身与真实 Session 行为对齐有明确契约注释 |
| turn 级编排(非裸 delta) | relay/control-wire | 避免分片/重复转发,是已拍板决定,正确 |
| fence 抗误触发(R1 首行门 + info string + 列 0) | control-fence.mjs | agent 复述协议语法不会误执行 |
| 进程树清理意识 | backend.mjs terminateProcessTree/scheduleForceKill | win32 同步强杀 / POSIX 递归 SIGTERM,PID 复用防护(按 ChildProcess 而非裸 PID) |
| 纯数据 ctx + JSONL run log + artifact 分离 | flow/ctx,logger | 为持久化/恢复留的门是真实的 |
| loader 词法 import 白名单 | flow/loader.mjs | 状态机扫描跳注释/字符串/模板,定位为 lint 非安全边界,文档诚实 |
| defer LIFO 清理作用域 | flow/defer.mjs | 错误语义(fn 错误优先、defer 错误 suppressed)考虑周全 |
| Windows spawn 安全(.cmd 注入防护) | backend.mjs spawnPlan | 真实跨平台坑都踩过并写了 rationale |

### 1.3 架构问题(僵化点)

按"改成正式项目"的目标逐条对照:

1. **Backend 硬编码二元**。`AGENTS = {omp, codex}` 写死在 backend.mjs:60,且 session-manager.mjs:7 又复制了一份 `["omp","codex"]`。新增 backend(如 Claude Agent SDK、纯 HTTP API、甚至本地 ollama)要改 4+ 处。OmpSession 与 CodexSession 约 70% 结构重复(#setStatus/#emit/#emitError/events 环形缓冲/close 完全一样),没有公共基类或组合的 Session 核。
2. **Agent 不可配置**。模型/effort/write 只能在 CLI flag 或 flow 调用点逐次写;没有"命名 agent 档案"概念。workflows/qa-loop.mjs 里 `deepseek-v4-pro`、`minimax-code-cn/MiniMax-M3` 是硬编码字符串——换模型要改每个 flow。没有 system prompt / 角色注入能力(mesh 指令是唯一一段可注入文本,且全局一份)。
3. **flow `agent()` 表达力不足**。只接受 `{agent, model, prompt, reuse}`(flow/api/agent.mjs:52),**没有 write/effort/mesh/timeout/signal**——意味着 flow 里的 agent 永远是只读的,无法编写"让 coder agent 改文件"这类正式工作流。这是功能性缺口,不只是不优雅。
4. **flow 并发被模块级单例锁死**。current-run.mjs 是模块级 `_currentRuntime`,只支持顺序单 run(代码自己承认需要 AsyncLocalStorage)。`maxActiveSubRuns=1` 同源。正式版的 team/并行 flow 都会撞墙。
5. **编排结果无回路**。fence 命令的执行结果只进 stderr 警告或 human 视野(mesh-instructions.mjs:56 "command results default back to the human")。leader agent `/open` 一个 member 后**拿不到新 label**,`@member` 也收不到投递回执。leader/member 模式在当前协议上无法闭环。
6. **REPL 与 flow 争用 stdin**(详见 P1-8)。本质是"谁拥有人类输入"没有架构级答案,正式版要有 stdin 单一所有权机制。
7. **运行产物落在 cwd**。`run.log.jsonl` / `artifacts/` 写到启动目录(flow/logger.mjs:14-15),靠 .gitignore 兜底;多 run 共写一个文件,无 per-run 目录,无法对应"哪次 run 的哪个产物"。
8. **会话只能开不能关**。REPL 没有 `/close <label>`;fence 的 maxSessions=10 只挡 agent,human 无限开。长会话场景下没有回收手段。

---

## 2. Bug 清单

> 分级:**P0** = 孤儿进程 / 挂死 / 数据损坏,必修;**P1** = 确定逻辑错误或功能闭环缺口,应修;**P2** = 质量/边缘问题,择机修。每条带定位与修法建议。

### 2.1 孤儿进程专项(P0)

先把现状的"防残留机制"说清楚,再说洞在哪:

- **正常路径**(`/exit`、`--task` 跑完、flow 正常结束):`closeAll()`/`disposeRun()` → `session.close()` → `terminateProcessTree`(POSIX 递归 SIGTERM;win32 taskkill /T /F 同步强杀)→ `scheduleForceKill`(3s 后 SIGKILL,unref)。**这条路是通的。**
- **隐式兜底**:子进程 stdio 是 pipe,父进程死后 stdin EOF,omp/codex *大概率*自行退出;终端 Ctrl-C 时子进程在同一前台进程组,会直接收到终端发的 SIGINT。——这两点解释了"日常用着没出事",但都**不是保证**:agent 卡在长计算时不读 stdin;`kill <pid>`/非 TTY/崩溃路径没有终端信号;agent 自己 spawn 的孙进程(如 omp 跑的 shell 命令)不一定跟着死。

洞:

**P0-1 `uncaughtException` / `unhandledRejection` 路径零清理。**
cli.mjs:490-493 的 uncaughtException 处理器直接 `process.exit(1)`,不碰 `gSessions`;`unhandledRejection` 干脆没有处理器(Node 默认行为也是带非零码退出,同样不清理)。任何一个未捕获异常 = 全部子进程交给"stdin EOF 碰运气"。
**修**:两个处理器都先同步遍历 `gSessions`(以及 P0-2 引入的 flow 会话注册表)调 `close()`(close 内部 win32 是同步强杀;POSIX 见 P0-5),再 exit。

**P0-2 flow 会话不在任何信号清理范围内。**
两个子场景:
(a) REPL 内 `/flow` 跑到一半 Ctrl-C:SIGINT 处理器只处理 `gSessions`(cli.mjs:451),flow runtime `_runs` 里的 reuse 会话、以及 agent()/agentLoop() 正在用的一次性会话全部不可见,处理器 abort+close 完 REPL 会话就 `process.exit(0)`(cli.mjs:485),flow 子进程没人杀。
(b) 独立跑 `node src/flow.mjs <name>`:flow.mjs:323-330 **完全没有任何信号/异常处理器**,Ctrl-C 之外的任何终止方式(kill、崩溃)都不会触发 disposeRun。
**修**:引入全局 `ShutdownManager`(见 §4.6):`createRuntime` 把"当前活跃会话集合"注册进去(开了就 add,close 了就 delete),所有退出路径统一走它。这是正式版进程治理的核心件,MVP 也可以先做最小版(一个模块级 Set + 三个信号处理器)。

**P0-3 无 SIGTERM / SIGHUP 处理器。**
`kill <synod-pid>`(部署/CI/超时杀)或终端窗口关闭(SIGHUP)→ 主进程默认终止,子进程无人管。cli.mjs 只注册了 SIGINT。
**修**:SIGTERM/SIGHUP 复用 SIGINT 的清理逻辑(可跳过"二次按键强杀"的交互语义,直接走 abort→close→exit)。

**P0-4 POSIX 退出路径上 SIGKILL 兜底实际不生效(已知但属残留风险)。**
backend.mjs:807-814 自己写明:`scheduleForceKill` 的 3s 定时器是 unref 的,而 CLI 在 close 后**立即** `process.exit()`,定时器永远不会触发——POSIX 实际只依赖一发 SIGTERM。omp 若在重计算/装了 SIGTERM handler 而延迟退出,就残留了。win32 没这个问题(同步强杀)。
**修**(三选一,推荐 ①):① 退出路径上改用**进程组击杀**:spawn 时 `detached:true` 让子进程自成进程组,close 时 `process.kill(-pid, "SIGTERM")`,exit 前同步 `process.kill(-pid, "SIGKILL")`——组杀连孙进程一起收,顺带消灭 pgrep 枚举的 TOCTOU(P2-23);② exit 前同步轮询 `process.kill(pid,0)` 最多 ~500ms,超时补 SIGKILL;③ 维持现状但把 SIGTERM 升级为 SIGKILL(粗暴,丢 agent 的优雅清理)。
注意 ① 的副作用:detached 后子进程不再随终端 Ctrl-C 收到 SIGINT,"隐式兜底"消失,因此必须和 P0-1/2/3 一起做,不能单独上。

**P0-5(挂死,非孤儿)`OmpSession.waitIdle` 内 `state()` 无超时 → `send({wait:true})` 可无限挂死。**
backend.mjs:741 `await this.state()` 的底层 `request()` 没有任何超时;若 omp 进程**活着但 RPC 不应答**(wedge),这个 await 永不返回,while 循环的 `Date.now()` 超时判断永远没机会执行——`DEFAULT_WAIT_TIMEOUT_MS` 形同虚设。下游:flow 的 agent() 卡死、drainAll 卡死、/exit 卡死。CodexSession 用 `withTimeout` 包了整个 wait(backend.mjs:1374),是对的;Omp 这边不对称。
**修**:`waitIdle` 里 `await withTimeout(this.state(), 5000, ...)`,超时按"本轮探测失败"处理继续循环(整体超时仍由外层 while 控制);或者干脆把整个 waitIdle 包进 withTimeout。

### 2.2 逻辑 bug(P1)

**P1-6 `OmpSession.send` 无并发 turn 守卫 + reuse 池"先入池后发送"竞态。**
两半合起来是一个真实可触发的数据损坏:
- backend.mjs:655-684:OmpSession.send 不检查 `status === "running"`(CodexSession 有 `this.turn` 守卫,backend.mjs:1260),并发第二次 send 会把 `turnText` / `turnStarted` 重置,**毁掉第一个 turn 的累积文本**,且两个 waiter 会拿到同一份混杂结果。
- flow/api/agent.mjs:125-133:reuse 会话在 **send 之前**就放进 `reusedSessions` 池。flow 里 `Promise.all([agent(ctx,{reuse:true,...}), agent(ctx,{reuse:true,...})])` 同 key 时,第二个调用直接从池里拿到正在流式输出的会话并发 send → 触发上一条。
REPL 路径靠 sendQueue 串行不受影响;flow 路径(文档鼓励 `Promise.all`)会踩。
**修**:(a) OmpSession.send 加运行中守卫(抛错,与 Codex 对齐);(b) reuse 池的 entry 带上 per-session 发送链(类似 sendQueue 的 promise chain),同 key 并发自动串行——语义上"复用 = 串行化"对 flow 作者更友好,直接抛错则更显式;二者选一,但必须有一个。

**P1-7 `disposeRun` 与未完成 `agent()` 的竞态 → 会话泄漏到进程退出。**
`Promise.all` 中一个 agent() 拒绝 → runFlow 进 finally → `disposeRun` 删除 `_runs[runId]`;另一个**还在飞**的 agent(reuse:true) 完成后调 `getRunState(ctx.runId)`(runtime.mjs:121-128)**重新创建** run state 并把会话放回池——这之后再也没有人 dispose 它,子进程一直活到 synod 退出。
**修**:run state 加 `disposed` 标志;disposeRun 后 getRunState 对该 runId 返回 disposed 态,agent() 在 disposed 态下走"不入池、用完即 close"分支。更彻底的修法是 ctx 级 AbortSignal(§4.7):dispose 时先 abort 所有在飞调用。

**P1-8 REPL `/flow` + `approve()` 双 readline 抢 stdin。**
cli.mjs 的 REPL readline(cli.mjs:168)在 flow 运行期间**不暂停**;flow runtime 的 `defaultIo()`(flow/runtime.mjs:80-87)在第一次 `question()` 时对同一个 `process.stdin` 再建一个 readline。两个 interface 都挂着 data 监听,人类输入的同一行会**同时**被 REPL 分发(发给当前 agent 会话!)和 approve() 消费。qa-loop 不用 approve 所以没暴露;任何带 approve/reviseWithHuman 的 flow 在 REPL 里跑必触发。
**修**:cli.mjs 的 `runFlow` wrapper 在 flowMain 期间 `rl.pause()` + 注入共享的 io(把 REPL 自己的 question 能力传给 runtime),结束后 resume。架构级方案见 §4.8 "stdin 单一所有权"。

**P1-9 agent-fence `/open` 劫持 human 的当前会话。**
session-manager.mjs:172 `open()` 无条件 `_currentLabel = label`。agent 在 fence 里开子会话后,human 的下一条裸消息会发给这个新子会话而不是自己正在对话的会话。
**修**:`open()` 加 `setCurrent`(默认 true,fence 路径传 false)。

**P1-10 fence 命令结果不回传发起 agent —— leader/member 闭环的功能缺口。**
control-wire.mjs:68-74 拿到 `{ok, label}` 后只写 stderr;mesh 协议明说结果归 human。后果:agent `/open` 后不知道子会话 label(label 是 host 分配的 `omp#N`),`@label` 无回执,`/relay` 不知道成败。**当前协议下 agent 只能"盲编排"**,正式版 team 功能必须先补这个回路(设计见 §4.5 的 MessageBus 回执)。
**修**(MVP 内即可做):dispatch 结果汇总成一条 `[synod result] opened omp#3 / relay added / @omp#2 delivered` 文本,enqueue 回发起 label 的会话(注意:回执消息本身的 turn 不应再触发 fence 解析的无限递归——给回执 turn 打免解析标记,或依赖 R1 门 + 去重)。

**P1-11 退出时 fire-and-forget fence dispatch 可在 `closeAll` 之后开出新会话。**
control-wire.mjs:55-77 的 dispatch 是不被 await 的 async IIFE。时序:最后一个 turn 完成 → onTurnComplete 返回(fence dispatch 仍在飞)→ onClose 的 drainAll 看到静默 → closeAll → 飞着的 `/open` 完成,新会话进 `_sessions` → 没人 close(直到 process.exit 靠 EOF 兜底)。窗口窄但真实。
**修**:wireControl 维护 in-flight dispatch 的 Set,暴露 `drainControl()`,onClose 在 drainAll 后 await 它;或 closeAll 后置"已关闭"标志,sm.open 拒绝新开。

**P1-12 flow `agent()` 不支持 `write`/`effort`/`mesh`。**
归类在 §1.3-3 说过,按 bug 跟踪:flow/api/agent.mjs:52-54 签名缺参,openBackend 明明支持。任何需要写文件的正式工作流都做不了。agentLoop 同病(flow/api/agentLoop.mjs:42-44),且 agentLoop 还没接 progress sink(对比 agent.mjs:136-154),`/flow --progress` 下 agentLoop 全程无输出。
**修**:两个原语补全参数透传 + agentLoop 接 sink;参数校验沿用现有风格。

### 2.3 质量 / 边缘问题(P2)

| # | 问题 | 定位 | 说明/修法 |
|---|---|---|---|
| P2-13 | logger 里杂散 `/**` 把后续 ~55 行"模块级"代码静默吞进函数作用域 | flow/logger.mjs:40-46 | 第 40 行的 `/**` 被第 42 行注释的 `*/` 闭合,导致 `RESERVED_META_KEYS`/`validatePureData`/`validateMeta` 看似模块级、实际嵌在 createLogger 里。**现在恰好能跑**,但任何人"修一下注释"就会改变作用域。整理掉。 |
| P2-14 | step:started 与 step:succeeded 共用同一个 `ts` | flow/logger.mjs:153,189 | `clock()` 只调一次,无法从日志推导 step 耗时。结束行应取新时间戳 + 记 `durationMs`。 |
| P2-15 | `run.log.jsonl`/`artifacts/` 写到启动 cwd,多 run 混写 | flow/logger.mjs:14-15;flow.mjs:257 | 改 per-run 目录 `~/.synod/runs/<runId>/`(§4.7)。 |
| P2-16 | `discoverFlows` 一个坏 flow 让整个 `/flow` 列表炸 | flow/loader.mjs:465-481 | for 循环里任一文件 lint/import/meta 失败直接 throw。改为收集 `{name, error}` 跳过并警告。另:--list 会 `import()` 每个 flow 模块(执行模块副作用)只为读 meta,可改为仅 lint+元数据约定。 |
| P2-17 | `drainAll` 的 `maxPasses` 在入口快照 `_sessions.size` | session-manager.mjs:238 | drain 期间 fence `/open` 增加会话数,上限不更新;且 size+1 对"长 relay 链"的语义并不精确(防环已保证无环,只是上限估算粗糙)。每 pass 重新计算即可。 |
| P2-18 | `bash()` 超时 30s/maxBuffer 10MB 硬编码,且 exec 杀 shell 不杀孙进程 | flow/api/bash.mjs:36-41 | 加 `opts.timeout`;超时杀进程组(detached + kill(-pid)),与 P0-4 方案统一。 |
| P2-19 | REPL 无 `/close <label>` | repl-dispatch.mjs | 会话只能开不能收;关联 relay 解绑(registry.removeForLabel 已有,接上即可)。 |
| P2-20 | 行缓冲不处理 `\r\n` | session-manager.mjs:10-28 | Windows 下 agent 输出带 `\r` 残留,split("\n") 后行尾有 `\r`,cosmetic。 |
| P2-21 | `OmpSession.result()` 空 turnText 时回退 `get_last_assistant_text` 可能取到**上一轮**文本 | backend.mjs:699-714 | 本轮无文本输出(纯工具调用轮)时,回退链返回 stale 文本并被 relay/fence 当作本轮结果转发。回退前比对 turnCount 或在 send 时清 RPC 侧状态。 |
| P2-22 | relay 全文直灌(≤400k)目标会话 | relay.mjs:112 | 大 turn 文本直接成为对方 prompt;加长度上限 + 截断标注,或 artifact 引用。 |
| P2-23 | `terminateProcessTree` 枚举→击杀的 TOCTOU;先杀子再杀父,父在窗口期可再 spawn | backend.mjs:301-343 | 进程组击杀(P0-4 ①)一并解决。 |
| P2-24 | OmpSession/CodexSession ~70% 重复;`AGENTS` 双处定义 | backend.mjs:60,389-1471;session-manager.mjs:7 | 抽 `BaseSession`(status/events/emit/close 骨架)+ 协议子类;AGENTS 单一来源导出。这是 §4.3 backend 插件化的前置重构。 |
| P2-25 | `wireControl` 的 `_depthMap` 只增不删 | control-wire.mjs:27 | 会话关闭后 depth 记录残留(label 不复用,只是内存小漏)。接 /close 时一并清。 |
| P2-26 | flow.mjs 找 flow 先 `discoverFlows`(import 全部 flow)再 fallback `loadFlow` | flow.mjs:277-292 | 跑一个 flow 却执行所有 flow 模块的顶层代码;直接 loadFlow 命中即可,discoverFlows 仅 --list 用。 |

### 2.4 测试覆盖缺口

- 信号/退出路径只有 e2e 验收(A3)覆盖 Ctrl-C 主路径;P0-1/2/3 的路径零覆盖。修 P0 时同步补"信号注入 + fake 子进程存活断言"类测试(fake proc 已具备)。
- flow 并发(`Promise.all` 双 agent)无测试——P1-6/7 正是没测过的区域。
- REPL `/flow` + approve 的 stdin 路由无测试(P1-8)。

---

## 3. 正式版需求 → 架构映射

| 需求(用户原话) | 架构回应 | 章节 |
|---|---|---|
| 使用 CLI 作为客户端 | 正式 `synod` bin + 子命令(REPL / run / team / flows / doctor);单进程,不引 daemon,但 Bus 抽象给未来 client/server 留门 | §4.2, §4.9 |
| 支持 JS 编写的 flow | 保留现 flow 引擎,补 write/并发/取消/per-run 目录,loader 兼容现有 flow 文件 | §4.7 |
| 对 flow 用到的 agent 进行配置,不要太僵化 | `synod.config.mjs` 命名 agent profiles(backend/model/effort/write/systemPrompt/标签),flow 与 REPL 都按名引用,可内联覆盖 | §4.4 |
| Claude Code agent-team:leader 拉起 member | Team Runtime:leader 会话 + 具名 member;fence 协议扩展 + **结果回执**(修 P1-10) | §4.5 |
| member 交互:直接通信 / leader 协调两种模式 | MessageBus 路由策略 `mode: "hub" \| "direct"`,边集合可配 | §4.5 |
| 退出的孤儿进程 | ProcessSupervisor + ShutdownManager + 进程组击杀 + PID 注册表(崩溃后收尸) | §4.6 |
| 灵活接入其他 CLI(新增需求 2026-06-10) | Backend Adapter 注册表:声明式接入一次性 CLI(`type:"cli"`,如 claude/gemini/aider)+ 程序化 adapter(`type:"module"`),config 即插即用,内核零改动 | §4.3 |
| 保留现有"主持人"玩法:human 手动拉起/转发/广播平级 agent(新增需求 2026-06-10) | REPL 主持人模式列为三种一等使用面之一,长期保留并在 UI 上强化(`/open` `/use` `@label` `@all` `/relay` 全保留) | §4.10、`CLI_UI_DESIGN.md` |
| 开发分阶段:第一阶段 workflow,第二阶段 agent teams(新增需求 2026-06-10) | 路线图重排为阶段 0–3;阶段 0(进程治理)与阶段 1(workflow)已出 TDD 计划 | §5 |
| 多 write agent 并发不互踩(采访 2026-06-10 拍板) | RunWorkspace:每个 write 任务一个 git worktree;收尾干净自动合、冲突留人 | §4.11 |
| 长任务中断可恢复(采访拍板:刚需) | 持久化/恢复从「留门不做」**提前进路线图**:workflow step 级 resume 先行,team 恢复阶段 2 评估 | §4.12 |
| 全场景运行:本机交互 + 远程 ssh/tmux + CI/无人值守(采访拍板) | headless 模式:人在环节点存断点退出等人(`synod resume` 续);通知钩子 + 终端铃 | §4.13 |
| Windows 兼容(采访拍板:先写后测) | 横切约束:所有阶段计划含 win32 分支/降级;每阶段验收含用户 Windows 实测项 | §5 |
| token/费用统计(采访拍板) | **明确不做**(本地/包月模型,成本不敏感) | §4.9 |

## 4. 正式版(V1)架构设计

### 4.1 设计原则(继承已拍板决定 + 新增)

继承不重开:**JS 即控制流,不发 DSL、不引 MCP**;回退=反馈定向修正,不做整段回滚;会话默认一次性、复用是优化;turn 级编排;run log day-one。
新增三条:
1. **会话的生命周期权威只有一个**:所有子进程必须经 ProcessSupervisor 出生、必须在 ShutdownManager 注册,任何模块不得绕过(flow 也不行)。
2. **编排消息必有回执**:任何 agent 发起的编排动作,结果以结构化文本回到发起者的会话。盲编排是 MVP 的妥协,不带入 V1。
3. **配置可层叠**:内置默认 → `~/.synod/config.mjs` → 项目 `./synod.config.mjs` → CLI flag → 调用点内联,后者覆盖前者;每一层都可省略。

### 4.2 总体分层

```
┌── L4 clients ───────────────────────────────────────────────┐
│  synod        (REPL,现 cli.mjs 演进)                        │
│  synod run    <flow> [input]   (现 flow.mjs 演进)            │
│  synod team   <team> "<task>"  (新)                          │
│  synod flows / doctor [--reap] / config                      │
├── L3 orchestration ─────────────────────────────────────────┤
│  Flow Engine(JS flows;原语;run log)                         │
│  Team Runtime(leader/member;预算;终止条件)                  │
│        └── 都通过 ↓ 收发消息                                 │
│  MessageBus(路由策略:hub / direct / relay 规则;回执)        │
├── L2 kernel ────────────────────────────────────────────────┤
│  SessionPool(label/具名会话;per-session 串行队列;          │
│              行缓冲多路输出;turn 事件)                       │
│  ProcessSupervisor(spawn 进程组;PID 注册表;树杀)           │
│  ShutdownManager(信号/异常/正常退出统一收口)                 │
├── L1 backends(插件)────────────────────────────────────────┤
│  omp · codex · (未来: claude-sdk · http-api · …)             │
└── L0 config ────────────────────────────────────────────────┘
   synod.config.mjs(agents / teams / defaults / backends)
```

与现状的对应:L2 = session-manager + backend.mjs 的进程部分**合并收编 flow 的会话获取路径**(消灭双路径);L3 的 MessageBus = relay + control-wire + repl-dispatch(agent-fence 半边)的归一化;L4 基本是现有入口的子命令化。

### 4.3 Backend 插件化(L1)

把 backend.mjs 拆成"协议适配器"接口 + 注册表:

```js
// 每个 backend 实现:
interface BackendAdapter {
  name: string;                          // "omp" | "codex" | ...
  doctor(): { available, version };      // 探活
  open(opts: {
    cwd, model?, effort?, write?, systemPrompt?,  // systemPrompt 替代散落的 mesh 注入
    spawnImpl?,                          // 测试注入,保留
  }): Promise<Session>;
}
// Session 统一契约(现 OmpSession/CodexSession 的公共面):
//   send(msg, {wait, timeout_ms, signal}) / result() / abort() / close()
//   events: 'delta' | 'status' | 'event' | 'error'
//   summary()
```

- 抽 `BaseSession`(EventEmitter、status 机、events 环形缓冲、close 骨架、日志),Omp/Codex 只剩各自的 RPC 协议代码(消 P2-24)。
- 注册表:内置 omp/codex;config 的 `backends` 段注册自定义 adapter。AGENTS 列表从注册表**惰性**派生(调用时取,不在模块加载时快照——config 注册发生在内置注册之后),单一来源。
- **接入任意 CLI 的两档形态**(2026-06-10 新增需求的落点):
  1. **声明式 `type:"cli"`**(零代码接入一次性 CLI):适配"给 prompt、吐文本"的命令行工具(`claude -p`、`gemini -p`、`aider --message`、任何脚本)。每次 `send` spawn 一次,stdout 流式即 delta,进程退出即 turn 结束;`close()` 杀在飞进程。配置即接入:
     ```js
     backends: {
       claude: { type: "cli", bin: "claude", args: ["-p"], promptVia: "arg",
                 modelFlag: "--model", timeoutMs: 600_000 },
       myscript: { type: "cli", bin: "node", args: ["./tools/ask.mjs"], promptVia: "stdin" },
     }
     ```
     诚实限制(文档写明):无持久会话状态(每 turn 独立进程),`reuse` 对它是空操作;有状态/协议型 CLI 走第 2 档。
  2. **程序化 `type:"module"`**:`{ type: "module", path: "./adapters/foo.mjs" }`,模块默认导出 `{ name, doctor(), open(opts) → Session }`,Session 满足统一契约(EventEmitter + send/result/abort/close/summary)。omp/codex 自身就是这一档的内置实现,契约测试套件可复用。
  - 两档都经 `openBackend` 单点出生 → 自动获得 track/PID 记录/进程治理(阶段 0 的不变量对新 backend 免费生效)。
- **mesh 注入泛化为 `systemPrompt`**:adapter 负责落到自家机制(omp `--append-system-prompt`,codex `developerInstructions`)。mesh 指令、team 协议、agent 角色 prompt 都走这一个口。

### 4.4 Agent 配置体系(L0)

```js
// ./synod.config.mjs(项目级;~/.synod/config.mjs 同构)
export default {
  agents: {
    planner:  { backend: "omp",   model: "deepseek/deepseek-v4-pro",
                effort: "xhigh",  write: false,
                role: "你是规划者,负责拆解任务、分派与验收……" },   // → systemPrompt
    coder:    { backend: "omp",   model: "minimax-code-cn/MiniMax-M3", write: true },
    reviewer: { backend: "codex", write: false },
  },
  teams: {
    build: {
      leader: "planner",
      members: { coder: {}, reviewer: {} },     // 引用 agents,可局部覆盖
      mode: "hub",                              // "hub" | "direct"
      // direct 模式下可选边集合;省略 = 全连通
      // edges: [["coder","reviewer"]],
      budget: { maxTurnsTotal: 40, maxWallClockMs: 30 * 60_000 },
      guardrails: { maxSessions: 8, maxDepth: 2, allowWrite: true },
    },
  },
  defaults: { progress: true, runsDir: "~/.synod/runs" },
};
```

使用方式(三处统一按名引用):
- flow:`agent(ctx, { profile: "coder", prompt, reuse })`——`profile` 与内联 `agent/model/...` 可混用,内联覆盖 profile 字段;现有写法保持兼容。
- REPL:`/open coder`(等价旧 `/open --agent omp --model ... --write`);旧 flag 形式保留。
- team:teams 段直接引用。

校验:config 加载时即校验(backend 存在、model 串过 sanitize、write 是布尔),错误带路径报出,fail fast。**不做远端/动态配置**——一个 JS 文件已经是"不僵化"与"可审计"的平衡点(配置本身可以写函数/常量复用,因为它就是 JS)。

### 4.5 Team 编排(L3 核心新增)

**模型**:一个 TeamRun = 1 个 leader 会话 + N 个具名 member 会话 + 一个 Bus 路由策略 + 预算/终止条件。member 的 label 就是 config 里的名字(`coder`、`reviewer`),不再是 `omp#N`——leader 的提示词里可以直接点名,消除"label 不可知"问题的大半。

**两种交互模式(用户需求点)**:

```
hub(leader 协调)                     direct(成员直连)
                                      
  human ⇄ leader                       human ⇄ leader
          ⇡⇣ (所有流量经 leader)               ⇡⇣
       ┌──┴──┐                            ┌──┴──┐
     coder  reviewer                    coder ⇄ reviewer   (允许的边)
   (彼此不可见)                        (输出可 cc leader)
```

- **hub**:member 的每个 turn 完成文本自动回送 leader(`[from coder] …`);member 的 fence 里 **只允许** `@leader`(其余目标拒绝);leader fence 可 `@<member>`、`/open`(在 guardrails 内增援)、`/done`。leader 是唯一的信息汇聚点——可控、可审计、token 成本高。
- **direct**:member 间允许 `@<member>`(受 `edges` 约束,省略即全连通);member turn 输出默认**不**自动回送 leader,但 `cc: "leader"` 可开抄送;leader 仍保有 `/done` 与增援权。低延迟、leader 不成为瓶颈——代价是可观测性弱,靠 run log 兜底。
- 防失控(两种模式共用):relay 防环图复用;**预算硬上限**(总 turn 数 / 墙钟时间,超限 Bus 停止投递并通知 leader 收尾);maxDepth/maxSessions 沿用现 guardrails。

**协议扩展(在现 fence 协议上加,不另起炉灶)**:

| 命令 | 谁可用 | 语义 |
|---|---|---|
| `/spawn <profile> [as <name>]` | leader | 按 profile 拉起 member(替代裸 `/open`,带角色注入) |
| `@<name> <msg>` | 按模式/边集合 | 点对点消息 |
| `/done <summary>` | leader | 团队任务完结,触发收尾(drain → close 全员) |
| `/release <name>` | leader | 提前关闭某 member |

**回执(修 P1-10,team 的地基)**:Bus 对每条 fence 命令产出一条结构化回执文本,作为下一条消息送回发起会话:

```
[synod] spawn coder → ok (ready)
[synod] @reviewer → delivered
[synod] /relay coder->reviewer → rejected: would create a cycle
```

回执消息触发的 turn 正常参与编排(leader 收到回执后自然继续下一步);防递归依赖现有的 R1 门 + 命令去重 + 预算上限。

**入口两个**:
- REPL/CLI:`/team build "把 X 重构为 Y"` 或 `synod team build "<task>"`——leader 收到任务开干,human 可随时插话(human 消息永远直达 leader)。
- flow 原语:`const r = await team(ctx, { team: "build", task, budget? })`——把"自主团队"作为确定性 flow 中的一个节点,flow 拿到 `/done` 的 summary 作为返回值。**这是 flow(确定性)与 agent 自主编排(非确定性)的正交组合点**,也呼应 TODO 里留门的"agent 自主编排"两条。

**实现路径提示**:Bus 不是新轮子——把 `createRelayRegistry`(图+防环)、`wireControl`(turn 完成钩子)、`dispatchAgentFence`(命令白名单+guardrails)三者收编为一个带路由策略与回执的模块;SessionPool 的 sendQueue/onTurnComplete 机制原样复用。预计是"重组 + 补回执",不是重写。

### 4.6 进程生命周期与孤儿防护(L2,P0 的系统性解)

四件套,自下而上:

1. **进程组击杀**(POSIX):ProcessSupervisor 统一 spawn,`detached: true` 使每个 agent 自成进程组;杀 = `kill(-pid, SIGTERM)` → 宽限(运行中 3s;**退出路径同步缩短为 ~300ms 轮询**)→ `kill(-pid, SIGKILL)`。孙进程(agent 自己 spawn 的 shell/工具)一起收;pgrep 枚举与 TOCTOU 全部消失。win32 维持 taskkill /T /F 同步。
2. **PID 注册表 + 崩溃收尸**(把 fork 时删掉的 agent-bridge 机制要回来,这是当时"deliberately omitted"清单里唯一应该收回的决定):每 spawn 写 `~/.synod/pids/<sessionId>.json`(pid、pgid、ownerPid、startedAt、bin);正常 close 删除。`synod` 启动时与 `synod doctor --reap` 扫描:owner 已死且 pid 存活 → 校验进程启动时间与 bin 匹配(防 PID 复用误杀)→ 组杀 + 清记录。**这是唯一能覆盖 SIGKILL/断电/Node 硬崩的手段**——事前防护做得再好,也需要事后收尸兜底。
3. **ShutdownManager(统一收口)**:模块级单例,API:`register(disposable)` / `unregister` / `shutdown(reason)`。SessionPool、每个 flow runtime、每个 TeamRun 注册自己。处理器矩阵:SIGINT(交互语义:一次 abort+优雅、二次强杀)、SIGTERM/SIGHUP(直接优雅一轮)、uncaughtException/unhandledRejection(**同步**强杀路径后 exit 非零)、正常退出(已 drain,常规 close)。`shutdown` 幂等(二次调用直达强杀)。
4. **会话路径归一**:flow runtime 不再直接拿 openBackend,改为从 SessionPool 租借(`pool.acquire(profile|opts)` / `release`)。REPL 会话、flow 会话、team 会话在同一张表里——ShutdownManager 只需要看一张表(从根上消灭 P0-2 的"两条路径"问题)。flow 的 reuse 池语义保留,实现变为"向 pool 续租"。

### 4.7 Flow 引擎演进(L3)

兼容承诺:现有 flow 文件(`meta` + `run(ctx, input)` + `synod/flow` import)不改即可继续跑。

1. **`agent()` 补全**(修 P1-12):`{ profile?, agent?, model?, effort?, write?, systemPrompt?, prompt, reuse?, timeout_ms?, signal? }`;agentLoop 同步补 + 接 progress sink。
2. **并发解锁**:current-run 由模块级单例改 `AsyncLocalStorage`(Node 20 原生);删 `maxActiveSubRuns=1` 的人为限制;reuse 池按 §P1-6 修并发语义。`Promise.all` 并行 agent 成为一等公民(progress sink 已是多路 label 前缀设计,天然支持)。
3. **取消语义**:`createCtx` 携带 runId 级 `AbortSignal`(由 runner 持有 controller);agent()/bash()/approve() 全部接 signal;Ctrl-C 第一击 = abort 当前 run(defer/disposeRun 正常走),第二击 = 强杀。修复"Ctrl-C 中断 flow 只能整个进程陪葬"。
4. **per-run 目录**(修 P2-15):`~/.synod/runs/<runId>/run.log.jsonl` + `artifacts/`;`latest` symlink;`synod runs` 列出。step 结束行独立时间戳 + `durationMs`(修 P2-14)。
5. **loader 韧性**(修 P2-16/26):discoverFlows 单文件失败降级为警告条目;run 路径直接 loadFlow。flow 搜索路径:项目 `./workflows` → config 指定目录(支持多个)。
6. **新原语 `team()`**:见 §4.5。

### 4.8 CLI 客户端形态(L4)

- 正式 bin(`npm i -g` / `npx synod`),子命令:`synod`(REPL)/ `run` / `team` / `flows` / `runs` / `doctor [--reap]` / `config`(打印生效的层叠配置)。零三方依赖原则**维持**——现有 parseArgs 风格够用,不为子命令引 commander。
- **stdin 单一所有权**(修 P1-8 的架构解):进程内唯一 readline,由一个 `InputRouter` 持有;REPL 模式下默认路由到 dispatch,approve()/question() 通过 `router.claim(prompt)` 临时独占(REPL 提示符暂停),释放后归还。flow 单跑模式同一机制,无第二个 readline。
- REPL 增补:`/close <label>`(P2-19)、`/team`、`/runs`、`/abort`(中断当前 flow/team 而不退进程)。
- 退出码规范化(已有 0/1/2/3/4 约定,文档化进 --help)。

### 4.9 暂不做(显式留门)

- **daemon / client-server 拆分**:多客户端共享会话之前没有需求;远程场景用 tmux + resume(§4.12/§4.13)覆盖;Bus 与 SessionPool 的接口边界即未来拆分线。
- **token/费用统计与预算**:采访拍板不做(2026-06-10,本地/包月模型,成本不敏感);CodexSession 已收的 `tokenUsage` 字段保留但不扩展。
- ~~持久化/恢复~~:**不再属于本节**——采访升级为刚需,见 §4.12。
- **flow 的沙箱安全**:loader lint 仍定位为防呆不防恶;flow 是受信代码(人写或人审)。agent 生成 flow 的场景出现时再议(届时方向是权限清单 + bash 白名单,不是 VM 沙箱)。
- **DSL / 可视化编排**:不做,已拍板。

### 4.10 三种使用面的关系:合一内核、并列入口(建议:不隔离)

用户问题:workflow 与 agent teams 两个模式,隔离还是合在一起?**建议合在一起——进程/代码/内核合一,交互模式显式隔离,发布按阶段。**

Synod 实际有**三**种一等使用面(第三种是用户要求保留的现有玩法):

| 使用面 | 控制者 | 确定性 | 现状 |
|---|---|---|---|
| **REPL 主持人模式** | human 即主持人:手动 `/open` 拉起平级 agent、`@label` 定向、`@all` 广播、`/relay` 接管转发 | 无脚本,全人工 | **已有,保留并强化**(MVP 的全部 REPL 能力) |
| **Workflow 模式** | 人写的 JS flow,确定性控制流 | 高 | 已有(flow 引擎),阶段 1 强化 |
| **Team 模式** | leader agent 自主协调,hub/direct 两种成员交互 | 低(预算/护栏约束) | 阶段 2 新建 |

**为什么不隔离成两个产品/两条进程:**
1. 三者共享 ~95% 内核:SessionPool、backend adapter、行缓冲多路输出、guardrails、进程治理。隔离 = 两套会话管理、两套清理路径——孤儿进程问题面直接翻倍,正好踩回 P0-2"双路径"根因。
2. **主持人模式本质上是 team 模式的人肉形态**:human 就是 leader,`/relay` 就是手动版 hub 路由,fence 回执看板就是 leader 的视野。合一后三者是同一心智模型的三个自动化档位(全手动 → 脚本化 → agent 自主),互相之间可以平滑升降级。
3. 组合价值只有合一才有:flow 里嵌 `team()` 节点;主持人玩着玩着把当前几个会话"编队升格"为 team(`/team promote`,未来);team 运行中 human 随时插话(human 消息直达 leader)。隔离则全部丧失。
4. 隔离只在两种情形下正确:安全边界不同(不适用——都是本机同权限)或发布节奏冲突(用**阶段**解决,不用产品隔离解决)。

**隔离保留在哪一层:交互层显式分模式。** REPL 默认即主持人模式;`/flow` 进入 workflow 运行视图;`/team` 进入 team 视图;提示符带模式徽标,模式间状态互不渗透(详见 `CLI_UI_DESIGN.md`)。这给用户"两个模式是隔离的"的清晰感受,而底下是一个内核。

### 4.11 并发写隔离:RunWorkspace(git worktree)— 采访补充需求

**问题(原设计盲点):** flow 的 `Promise.all` 与 team 的多 member 一旦都开 `write:true`,共用一个工作区必然互相踩(半成品互读、改同一文件、git 状态混乱)。采访拍板:**每个 write 任务一个 git worktree 隔离;收尾干净自动合、冲突留人**。

设计:
- 新组件 `RunWorkspace`(L2,挨着 SessionPool):`acquire({ runId, name })` → 在 `~/.synod/worktrees/<repo-hash>/<runId>-<name>/` 基于当前 HEAD 建临时 worktree + 分支 `synod/<runId>/<name>`;该 agent 会话的 `cwd` 指向 worktree。**只读 agent 不建 worktree**(直接用主 cwd,零开销)。
- **收尾合并策略(拍板)**:run 结束时逐分支尝试合回起始分支——能无冲突合并的自动合并并清掉 worktree+分支;有冲突的**保留**worktree 与分支,run 摘要里打印清单(分支名、冲突文件、worktree 路径)留人处理。顺利路径零人工,出错路径不丢任何工作。
- 接口:flow `agent(ctx, { write: true, workspace: "feat-x" })`(同名 workspace 复用同一 worktree,默认 = 每次调用独立);team 模式下每个 write member 默认各占一个(member 名即 workspace 名)。
- 非 git 目录:write 并发直接拒绝(报错建议 git init 或串行);单写者不受影响。
- 残留治理:worktree 记录进 run 目录,`synod runs`/收尾摘要可见;崩溃残留由 `git worktree prune` + 启动顺扫提示。
- **落点**:flow 侧在阶段 1C,team 侧在阶段 2。

### 4.12 持久化与恢复(采访升级为刚需,从「留门」提前)

**采访拍板**:中断恢复是刚需;粒度 = **workflow step 级 resume 先行**;team 恢复(黑板 + 摘要喂 leader)阶段 2 再评估。诚实限制(用户已确认接受):agent 会话的 LLM 对话上下文活在 agent 进程里,不可恢复——能恢复的是**已完成 step 的结果 + 纯数据 ctx**,复用型会话重开后靠提示词带全量上下文(本来就是"复用=优化非依赖"的既有设计,正好兜住)。

机制(留的门正好全用上:纯数据 ctx + JSONL run log + artifact 分离):
1. **确定性 step key**:resume 的对账依据 = 原语调用序号 + 节点名 + 输入 hash。重放时前缀匹配的 step 直接回放 logged 输出(不开 agent);第一个 key 不匹配(flow 改了/输入变了)的 step 起全部真跑。这要求 flow 代码确定性——与"JS 确定性引擎"的既有设计原则一致,文档向 flow 作者明示(别用 `Date.now()`/`Math.random()` 决定控制流)。
2. **per-run 目录(P2-15)是前置**:`~/.synod/runs/<runId>/`,resume 按 runId 找日志。
3. **入口**:`synod resume <runId>`(及 REPL `/resume <runId>`);`synod runs` 列出可恢复的 run(状态:done / failed@step / awaiting-approval)。
4. **断点文件**:headless 人在环退出(§4.13)与异常中断都写 `checkpoint.json`(停在哪个 step、待审内容、worktree 清单),是尸检与 resume 的共同入口。
- **落点**:阶段 1C(workflow resume + runs/resume 命令);team 恢复评估在阶段 2。

### 4.13 无人值守(headless)与通知 — 采访补充需求

运行环境拍板为**全场景**:本机交互 + 远程 ssh/tmux + CI/定时无人值守,且 Windows 要兼容(先写,用户回头实测)。

- **headless 判定**:`!stdin.isTTY` 或显式 `--headless`。
- **人在环节点的 headless 行为(拍板:存断点退出等人)**:`approve()`/`reviseWithHuman()` 在 headless 下不等 stdin——写 checkpoint(§4.12)、把待审内容完整打到 stdout、以专用退出码 **5(awaiting human)** 退出;人回来 `synod resume <runId>`,该节点在 TTY 下正常提问继续。彻底消灭"CI 里永久等 stdin 挂死"。
- **通知钩子(拍板:命令钩子 + 终端铃)**:
  ```js
  // synod.config.mjs
  hooks: {
    onDone:           "sh ~/.synod/notify.sh",   // 任意命令;接飞书/钉钉/ntfy/邮件自己写
    onError:          "sh ~/.synod/notify.sh",
    onApprovalNeeded: "sh ~/.synod/notify.sh",
  }
  ```
  钩子以环境变量收上下文(`SYNOD_EVENT`/`SYNOD_RUN_ID`/`SYNOD_SUMMARY`/`SYNOD_EXIT_CODE`),失败只警告不影响主流程。TTY 下默认附带**终端铃 + 标题置字**(ANSI BEL + OSC 0)——tmux 会标记窗口活动,远程场景零配置可感知。
- **不做 daemon**:远程断线场景 = tmux(会话存活)+ resume(断了也能续),两者组合已覆盖;维持 §4.9 的留门决定。
- **落点**:headless 行为与钩子在阶段 1C/1D;退出码 5 进阶段 3 的退出码规范。

---

## 5. 路线图

> 2026-06-10 按用户要求重排为**阶段交付**:第一阶段 = workflow,第二阶段 = agent teams;进程治理是两者共同前置(阶段 0);REPL 主持人模式贯穿全程保留。沿用现有三方协作工法(规格 → deepseek 开发 → codex 审+测 → 验收);**每个阶段开工前出一份 writing-plans 规格的 TDD 计划**(阶段 0/1 已出)。
> **横切约束(采访拍板)**:① Windows 兼容——所有阶段的实现含 win32 分支或显式降级(不得静默坏),每阶段验收含用户 Windows 实测项;② 全部长任务路径必须 headless-safe(不等 stdin、有退出码、有钩子出口)。

### 阶段 0 · 进程治理(止血,前置)— TDD 计划已出
📄 `docs/superpowers/plans/2026-06-10-架构重构-阶段0-进程治理.md`(Task 1–12,bite-sized TDD)
- ShutdownManager + 信号/异常矩阵(P0-1/2/3);进程组击杀 + 同步 SIGKILL 兜底(P0-4);waitIdle 探测超时(P0-5)。
- OmpSession.send 并发守卫 + flow reuse 串行化 + disposeRun disposed 标志(P1-6/7)。
- PID 注册表 + `--reap` 收尸;e2e:SIGTERM/SIGINT 退出零残留。

### 阶段 1 · Workflow(第一阶段交付)— TDD 计划已出(核心部分)
📄 `docs/superpowers/plans/2026-06-10-架构重构-阶段1-后端插件化与配置.md`(backend 插件化 + 配置 + flow agent 补全)
- **1A 后端插件化**(新增需求"灵活接入其他 CLI"的落点):adapter 注册表、内置 omp/codex 改走注册表、声明式 `type:"cli"` 通用适配器、`type:"module"` 程序化适配器、agent 名全链路动态化。
- **1B 配置层**:`synod.config.mjs` 层叠加载/校验、`backends` 段注册自定义 CLI、agent profiles、REPL `/open <profile>`、systemPrompt(role)透传。
- **1C flow 强化**(1A/1B 落地后另出计划;采访后扩容):并发(AsyncLocalStorage)+ ctx AbortSignal 取消;per-run 日志目录(P2-15,**resume 前置**)+ loader 韧性(P2-16);**workflow step 级 resume + `synod runs`/`resume` 命令(§4.12)**;**RunWorkspace worktree 写隔离 + 自动合并(§4.11)**;**headless 人在环断点 + 退出码 5(§4.13)**;P1-8(InputRouter)、P1-9(setCurrent)。
- **1D CLI UI v1**(设计已出:`docs/CLI_UI_DESIGN.md`):着色多路输出、tab 补全、/help 分组、flow 进度视图、/close(P2-19);**通知钩子 + 终端铃(§4.13)**。
- 阶段验收:用 config 接入一个非 omp/codex 的真实 CLI 跑通 workflow;两个 write agent 并行改同一仓库不踩(worktree);kill 掉跑一半的 flow 后 `synod resume` 从断点续完;主持人模式全部既有命令无回归;**Windows 实测一轮(用户执行)**。

### 阶段 2 · Agent Teams(第二阶段交付)— 计划在阶段 1 落地后出
- 2A MessageBus:收编 relay/control-wire/agent-fence,**回执机制**(P1-10,leader 拿到 `/open` 结果);退出竞态收口(P1-11)。
- 2B TeamRun hub 模式(`/spawn`/`/done`/`/release`、预算、收尾)→ 2C direct 模式(边集合、cc)。
- 2D flow `team()` 原语 + REPL `/team` 视图(UI 设计 §team 节)+ 真 agent e2e(双模式)。
- 2E(采访新增):write member 默认各占一个 worktree(§4.11 的 team 侧);**team 恢复评估**(黑板 + 已交付产物 + 进度摘要喂 leader 重启,§4.12)。
- 主持人模式与 team 的衔接:human 插话直达 leader;(可选)`/team promote` 把当前会话编队升格为 team。

### 阶段 3 · 产品化收尾
- 子命令化(`synod run/team/flows/runs/doctor/config`)+ bin 打包 + 退出码/帮助文档。
- 文档:用户手册改版(USAGE)、flow 编写手册补 team/profile、本文档对应章节落地后归档。

### 留在 TODO(不排期)
持久化/恢复;daemon 拆分;agent 生成 flow 的权限模型;标记驱动编排 B 支与 team 的合流评估。

---

## 6. 附录:bug 速查索引

> ✅ **阶段 0(进程治理)已修讫(2026-06-10,分支 `process-governance`)**:P0-1..5 + P1-6 + P1-7 全部修复并经单测 + 真 omp e2e(S1 SIGTERM / S2 SIGINT 无残留)+ 手工 kill-9/`--reap` 验证。详见 `docs/V1.md` 阶段 0 看板。

| 级别 | # | 一句话 | 定位 | 状态 |
|---|---|---|---|---|
| P0 | 1 | uncaughtException/unhandledRejection 不清理子进程 | cli.mjs:490 | ✅ 已修 d3aab8a(统一 shutdown 矩阵) |
| P0 | 2 | flow 会话不在 SIGINT 清理范围;flow.mjs 单跑无任何信号处理 | cli.mjs:451; flow.mjs:323 | ✅ 已修 c584084+d3aab8a(单点 track + 装处理器) |
| P0 | 3 | 无 SIGTERM/SIGHUP 处理器 | cli.mjs:444-501 | ✅ 已修 fb1c502+d3aab8a |
| P0 | 4 | POSIX 退出路径 SIGKILL 兜底不生效(unref 定时器+立即 exit) | backend.mjs:807-814 | ✅ 已修 8f2feae+3cfdf64+13ede93(同步硬清理+detached 组杀+兜底带组) |
| P0 | 5 | OmpSession.waitIdle 内 state() 无超时 → send(wait) 挂死 | backend.mjs:741 | ✅ 已修 6c3ffeb |
| P1 | 6 | OmpSession.send 无并发守卫 + reuse 池先入池后发送 → 并发数据损坏 | backend.mjs:655; flow/api/agent.mjs:125 | ✅ 已修 6e37966(send 守卫)+a886fcf(reuse 串行链) |
| P1 | 7 | disposeRun 后在飞 agent() 复活 run state → 会话泄漏 | flow/runtime.mjs:121,165 | ✅ 已修 c76c4a0(disposed 标志) |
| P1 | 8 | REPL /flow + approve 双 readline 抢 stdin | flow/runtime.mjs:80; cli.mjs:168 | 阶段 1C |
| P1 | 9 | fence /open 劫持 human 当前会话 | session-manager.mjs:172 |
| P1 | 10 | fence 结果不回传发起 agent(leader 不知子会话 label) | control-wire.mjs:68; mesh-instructions.mjs:56 |
| P1 | 11 | 退出时在飞 fence dispatch 可在 closeAll 后开新会话 | control-wire.mjs:55 |
| P1 | 12 | flow agent()/agentLoop() 不支持 write/effort/mesh;agentLoop 无 progress | flow/api/agent.mjs:52; agentLoop.mjs:42 | ✅ 已修 3cf1e7f(阶段1 Task8:profile/write/effort/mesh/systemPrompt 透传 + agentLoop progress sink) |
| P2 | 13–26 | 见 §2.3 表 | — |

> ✅ **阶段 1A/1B(后端插件化与配置)已落地(2026-06-11,分支 `backend-plugins`)**:§4.3(backend adapter 注册表 + 声明式 type:cli + 程序化 type:module + 惰性名列表)、§4.4(synod.config.mjs 层叠 + agent profiles + role→systemPrompt)均从「设计」转「已落地」。P1-12 已修。653 单测 + A1–A8 57 e2e + 假外部 CLI 端到端 + codex/deepseek 双审 APPROVE。详见 `docs/V1.md` 阶段 1A/1B 看板。

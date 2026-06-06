# Synod — 流式 CLI 原型(需求 · 自包含版)

> 自包含文档:读完即可在不依赖其它上下文的情况下动手。
>
> **本版与旧版的关键差异**:Synod **不再**把 agent-bridge 当作运行时服务(daemon / MCP / HTTP / SSE)来依赖,而是**内置一个从 agent-bridge fork 出来的后端协议层**,在自己进程内直接拉起 `omp` / `codex` 并原生流式。**无 MCP、无守护进程、无 HTTP/SSE。**

## 1. 目标

一个**交互式 CLI**:自己拉起本地 coding agent(omp / codex),把任务发给它们,在终端里**实时逐字**显示每个 agent 的输出,轮末拿到完整结果。

**整个东西是一个自包含的 Node 程序,启动即用,不依赖任何外部常驻服务。**

## 2. 架构:内置后端层(本版核心)

### 2.1 为什么脱钩

| 旧版要的外壳 | 它为什么存在 | Synod 为什么不需要 |
|---|---|---|
| daemon(Unix socket) | 跨进程 / 跨调用**共享**会话 | Synod 是单个长驻 REPL 进程,自己 hold 着所有会话 |
| MCP server | 给 LLM 宿主(Claude Code / Codex)用 | Synod 不是 MCP 宿主,是它自己的程序 |
| HTTP / SSE | 把流式从 daemon **转出来**给外部 | 进程内直接读子进程 stdout,原生拿 `text_delta`,更简单更低延迟 |

### 2.2 内置后端模块 `src/backend.mjs`

从 agent-bridge **v0.4.0(commit `3b97411`)** 的 `scripts/agent-bridge.mjs` **fork** 出两个会话类 + 一把工具函数,解耦成 `EventEmitter`。

**搬过来(尽量逐字,别改逻辑):**
- `OmpRpcSession`(原 `433–748`)→ `OmpSession`
- `CodexAppServerSession`(原 `749–1222`)→ `CodexSession`
- 工具:`makeId` / `nowIso` / `assertCwd` / `agentBin` / `clampText` / `stripAnsi` / `appendLog` / `sleep` / `withTimeout` / `shellQuote` + 常量 `AGENTS` / `LOG_DIR` / `MAX_TEXT` / `DEFAULT_WAIT_TIMEOUT_MS`(原 `172–336` 一带)
- 进程树清理:`terminateProcessTree` + `listChildPids` + `scheduleForceKill`(原 `337–389`,保留 ~40 行)

**只改这一处(解耦):**
- 每个 session `extends EventEmitter`
- `setSessionStatus(this, …)` → `this.#setStatus(…)`:改字段 + `emit('status', …)`
- `pushEvent(this, ev)` → `this.#emit(ev)`:推 `this.events` + `emit('event', ev)`
- 在 delta 累加点 `emit('delta', 增量)`:omp 在 `#applyEvent` 的 `text_delta`(原 `595`)、codex 在 `#onNotification` 的 `item/agentMessage/delta`(原 `974`)

**整段删掉(一行都不抄):**
- SSE 广播:`broadcastSessionEvent` / `sendSse` / `sseClients` / `sessionEventPayload`
- PID 落盘那一整套:`writePidRecord` / `removePidRecord` / `cleanupStalePidRecords` / `ownerStillRunning` / `roleMatchesCommand` / `processCommand`(单进程自己管子进程,不需要)
- daemon / MCP / HTTP / web UI / CLI facade ~1600 行

> ⚠️ 删除提示:在 fork 基准(见 §2.3)里,`broadcastSessionEvent` 与 `writePidRecord` 已是两个 session 类的**私有方法**(`#writePidRecord`,原 `534`/`861`),并在各自 `start()` 流程(原 `489`/`788`)里被调用。删它们不是删独立函数——要**连带摘掉 `start` 里的调用点**,以及 `pushEvent`/`setSessionStatus` 中转发到 SSE/PID 的那几行,只保留改成 `emit` 的部分。

**对外接口:**

```text
openBackend({ agent, cwd, write, model, effort }) -> session   // 内部 new Omp/CodexSession 并 start()

session (EventEmitter):
  events:  'status' ({status, isStreaming}) | 'delta' (text) | 'event' (raw) | 'error' (err)
  methods: send(msg, {wait, timeout_ms}) · result() · abort() · close() · summary()

doctor() -> { omp:{available,version}, codex:{available,version} }
```

**语义补充(MVP1 约定):**

- `send(msg)` 默认 `wait:false`——返回的 Promise 在**消息已投递**时 resolve,**不等本轮结束**;本轮何时结束以 `'status'` 变 `idle` 为准(示例里的"非阻塞"即此意)。`send(msg, {wait:true})` 才等到本轮结束再 resolve,`timeout_ms` 超时则 reject。
- `result()` 返回本轮完整文本 + 元信息(至少 `text` / `agent` / `model` / `effort` / `status`);`summary()` 返回会话概览(`agent` / `model` / `effort` / `status` / 累计轮数)。A5 即查 `summary().model` / `.effort` 是否为所选值。
- `effort` 透传给 omp(常用 `high` / `xhigh`;codex 会话不需要)。

CLI/REPL 用法示意:

```js
const s = await openBackend({ agent: "omp", cwd, model: "deepseek-v4-pro", effort: "xhigh" });
s.on("delta", t => process.stdout.write(t));   // 原生打字机
await s.send(line);                             // 非阻塞;靠 'status' 变 idle 收本轮
```

### 2.3 与 agent-bridge 的关系(来源,不是运行时依赖)

agent-bridge 现在只是 `src/backend.mjs` 的 **fork 来源**;Synod **跑起来不需要它**,也不需要它在运行。`src/backend.mjs` 头部注明 *fork 自 agent-bridge v0.4.0 commit 3b97411*,便于将来 diff 同步上游的协议修复。

**本机取用路径**(已核对行号一致):`~/.claude/plugins/cache/agent-bridge/agent-bridge/0.4.0/scripts/agent-bridge.mjs`(共 2844 行)。该缓存是 0.4.0 release,无 `.git`、无法直接核 commit 号,但 §2.2 / §8 引用的行号均与之逐条对得上(`OmpRpcSession` 433、`CodexAppServerSession` 749、`text_delta` 595、`doctor` 1321),以它为准即可。

### 2.4 跨平台:Windows 也要能跑

fork 来的进程清理(`terminateProcessTree` / `listChildPids`)用 `pgrep` / `ps`,**只在 POSIX 可用**。要让 Windows 也干净收尾,按 `process.platform` 分支(**不引第三方 tree-kill 库**):

- **POSIX(macOS / Linux)**:照搬——`pgrep -P <pid>` 找子进程,`process.kill(pid, signal)` 递归杀。
- **Windows(`win32`)**:`process.kill` 不杀子树;改用 `taskkill /pid <pid> /T /F`(`/T` 连子进程一起杀)。
- 其余(`spawn` omp/codex、readline 解析、`path` / `os.homedir` 路径)本就跨平台。Windows 上后端若是 `.cmd` / `.bat`,`spawn` 可能要带扩展名或 `shell:true`——用 `OMP_BIN` / `CODEX_BIN` 指到真实可执行文件最稳。

## 3. 硬依赖

- Node.js 20+
- 本机装有 **`omp` 和/或 `codex` CLI**(真正干活的 agent;backend 直接 `spawn` 它们)。路径可用 `OMP_BIN` / `CODEX_BIN` 覆盖。
- **不再依赖 agent-bridge 作为服务**,也不需要它在跑。
- **跨平台:macOS / Linux / Windows 都要能跑。** fork 来的进程树清理用 `pgrep` / `ps`,**仅 POSIX**;Windows 上必须改用等价手段(见 §2.4)。

## 4. 功能需求(标注 MVP1 / 后续)

- **F1 [MVP1]** 启动体检:`doctor()` 确认 omp/codex 可用;缺失给**清晰可操作**报错并**非零退出**。
- **F2 [MVP1]** 开会话:`openBackend()`,默认一个 omp、`write:false`、cwd=当前目录绝对路径;`--agent` / `--model` / `--effort` 可选(会话级)。
- **F3 [MVP1]** 发消息**非阻塞**(`send` 不 wait),订阅 session 的 `'delta'` 事件**逐字打到终端**;`'status'` 变 `idle` 表示本轮结束。
- **F4 [MVP1]** 多会话并行:同时开 2+,各自发任务,多路 `'delta'` **带标签分行、不串台**,全部 `idle` 后给一段**汇总**。
- **F5 [MVP1]** 交互 REPL(同一会话连发多句)+ 退出前 `close` 自己开的**所有**会话;`Ctrl-C` 优雅 `abort` 当前 turn 再 `close`;**任何退出路径不残留子进程**。
- **F6 [后续]** 错误恢复:子进程异常退出后的重连/重开、`lastError` 展示等。MVP1 不做,断了就清晰报错并清理后退出。

### 4.1 交互模型(MVP1 推荐设计,实现可微调)

> F4(多会话并行)与 F5(REPL 单会话连发)需要一套统一的输入路由。下面是覆盖 A2/A3 的**最小**设计;**核心约束是覆盖 A2/A3、且任何退出路径无残留子进程**,具体命令名 / 语法实现时可调。

**启动**

- `node src/cli.mjs [--agent A] [--model M] [--effort E] [--write]` → 开**一个**会话(默认 omp、`write:false`、cwd=当前目录绝对路径),进入 REPL。覆盖 F2 + A3。

**REPL 输入路由**

- 普通一行(不以 `/` 或 `@` 开头)→ 发给**当前会话**。
- `@<label> <消息>` → 定向发给某会话;`@all <消息>` → 广播给所有会话。
- `/open [--agent A] [--model M] [--effort E] [--write]` → 新开会话,分配短标签(如 `omp#1` / `codex#2`)并设为当前。
- `/use <label>` → 切换当前会话;`/sessions` → 列出会话与状态。
- `/exit` 或 EOF(Ctrl-D)→ `close` **所有**会话后退出;`Ctrl-C` → `abort` 当前 turn 再 `close` 全部、退出。
- 多路 `'delta'` 输出**按 `label` 前缀分行**,不串台(A2/A4)。

**A2 的可复现验收(非交互)**

- 提供一个非交互入口:一条命令开多会话、各发一个任务、并行流式、全 `idle` 后打印汇总并退出。例如:
  `node src/cli.mjs --task omp:"任务甲" --task codex:"任务乙"`(`--task <agent>:<prompt>` 可重复)。
  手敲 `/open` + `@label` 也能达成,此入口只是给 A2 一条可脚本化的验收命令。

> TODO(待拍板,不阻塞 MVP1,先按上面实现):① 多会话时"当前会话"默认取最后 `/open` 的那个,还是必须显式 `/use`;② `--task <agent>:<prompt>` 的配对语法是否够用(prompt 含冒号 / 空格时的转义)。

## 5. 技术约束 / 倾向

- 纯 Node,**零第三方依赖**(与 backend.mjs 一致,SSE 这种东西本版根本不存在)。
- backend 的协议逻辑**尽量逐字照搬**,只改「事件 / 状态发射」那一处。**别"重构清理"**——codex 的 turn-id / stale-turn / abort-race 处理和 omp 的 `waitIdle` 门控都是踩坑修出来的,改写极易把 bug 请回来。
- `src/backend.mjs` 头部标清 **fork 来源 + commit**,便于同步上游。
- **跨平台**:macOS / Linux / Windows 都要能跑;进程清理按 `process.platform` 分支(见 §2.4),不引第三方库。

## 6. 非目标(本原型不做)

- 不做 agent 之间的自动消息编排 / 共识算法(Synod 后续的事)。
- 不做**固定 workflow 引擎**——用 JS 写死的脚本 / flow 约束多个 agent 按既定流程执行(Synod 后续的事;TODO,MVP1 不碰)。
- 不做持久化、Web UI、鉴权、分屏 TUI、花哨样式。
- 不做 SSE 断线自动重连——**本版没有 SSE**。

## 7. 验收标准(逐条可测,全过才算)

- **A1 [MVP1]** 跑入口 → 开一个 omp 会话 → 发一句 → 终端**逐字(实时)看到输出** → 轮末 `close` 退出后,**无残留 omp 子进程**(检测命令见 §8,POSIX / Windows 各一条)。
- **A2 [MVP1]** 同时开 2 会话(如 omp + codex),各自发任务,两路输出**实时带标签分区、不串台**(同一行不混入两个 agent 的字),全部结束后给一段汇总。
- **A3 [MVP1]** REPL:同一会话连发 **≥2 句**,每句逐字流式回显;`/exit` 或 EOF 干净退出并 `close`。
- **A4 [MVP1]** 健壮性:omp/codex 缺失或开会话失败 → **清晰可操作**报错且**非零退出**;REPL 中途 `Ctrl-C` → `abort` 当前 turn + `close` 所有会话后退出;以上任何路径结束后**均无残留 omp/codex 子进程**。
- **A5 [MVP1]** `--agent` / `--model` / `--effort` 生效:用 `--model minimax-m3 --effort high` 开会话,`summary()` / `result()` 可见该会话确按所选后端/强度运行。

### 7.1 测试怎么落地(零依赖约束下)

- **框架**:内置 `node:test` + `node:assert`,与"零第三方依赖"一致;不引 jest / vitest。
- **两层**:
  - **单元 / 契约(CI 可跑,不需要真实 agent)**:参数解析、事件分发、多路 `delta` 标签分区不串台、退出清理逻辑。为此把 `spawn omp/codex` 收敛到**一个可替换的工厂**,测试注入 **fake 子进程**(吐预设的 `text_delta` / 状态)。**建议 MVP1 就预留这个注入点**,否则 A2 / 分区逻辑无法自动化。
  - **集成验收(A1–A5,需真实 omp/codex)**:在**本机**跑(如 `scripts/acceptance.*` 或 `npm run test:e2e`);残留检测用 §8 的 POSIX / Windows 命令。CI 无 agent 时**跳过并说明**,不算失败。
- WORKFLOW 里 codex "跑测试 / 补测试"即针对以上两层:契约测试它直接跑,集成验收在装了 omp/codex 的本机跑。

> TODO(待拍板):MVP1 是否一定要做 fake-backend 自动化,还是先只做手动验收脚本、把自动化标后续。倾向**至少把 `spawn` 注入点预留**,自动化测试可分批补。

## 8. 给实现者的提示

- 先把 `src/backend.mjs` fork 出来跑通(单 omp,F1–F3 + A1),再加多 agent(F4 + A2)、REPL(F5 + A3)。
- fork 时打开 agent-bridge 的 `scripts/agent-bridge.mjs` 对照行号搬:`OmpRpcSession` `433–748`、`CodexAppServerSession` `749–1222`、工具 `172–336` 一带、进程树 `337–389`、`doctor` `1321`。
- delta 发射点:omp `#applyEvent` 的 `text_delta`(原 `595`)、codex `#onNotification` 的 `item/agentMessage/delta`(原 `974`)。
- **残留检测**:没有 daemon 可查,直接看进程——POSIX:`pgrep -f 'omp --mode rpc'` / `pgrep -f 'codex app-server'`;Windows:`tasklist | findstr /i "omp codex"`。两边都应为空。

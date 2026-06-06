# Synod MVP1 实施 Plan

> 依据 [`PROTOTYPE.md`](PROTOTYPE.md)(需求)+ [`WORKFLOW.md`](WORKFLOW.md)(开发协作模式)拆分。
> Claude Code 规划/验收/协调,经 agent-bridge 派活;**plan 落定后才派**。

## 0. 前置核对(已做,有偏差,必读)

| 项 | 文档说法 | 本机实际 | 影响 |
|---|---|---|---|
| fork 源版本 | agent-bridge **0.4.0**(commit `3b97411`) | 缓存只有 **0.5.1**(`~/.claude/plugins/cache/agent-bridge/agent-bridge/0.5.1/scripts/agent-bridge.mjs`,2947 行) | **PROTOTYPE.md §2.2/§8 全部行号失效**,改用下方 §5 的 0.5.1 重映射表;`backend.mjs` 头部注明 *fork 自 0.5.1* 而非 0.4.0 |
| omp / codex | 需本机可用 | `~/.local/bin/omp`、`~/.local/bin/codex` 均在 PATH ✓ | A1–A5 集成验收可直接在本机跑 |
| Node | ≥20 | v26.0.0 ✓ | OK |

> 0.5.1 与 0.4.0 在结构上一致(两个 session 类 + 工具 + 进程树 + daemon/MCP/HTTP/UI 外壳),只是行号整体下移。§5 已逐符号重新定位。

## 1. 交付物

- `package.json` —— `"type":"module"`,零第三方依赖,`test` / `test:e2e` 脚本(`node:test`)。
- `src/backend.mjs` —— 从 0.5.1 fork 的内置后端:`OmpSession` / `CodexSession`(`extends EventEmitter`)+ 工具 + 进程树清理(含 Windows 分支),导出 `openBackend()` / `doctor()`。
- `src/cli.mjs` —— 流式 REPL + 多会话路由 + `--task` 非交互入口 + 退出清理。
- `test/*.test.mjs` —— 契约/单元测试(fake spawn 注入,CI 可跑)。
- `scripts/acceptance.mjs` —— A1–A5 集成验收(需真实 omp/codex,本机跑)。

## 2. 任务分解(小而可验收 · 标注派给谁)

### T0 · 脚手架(简单 → minimax,或 Claude Code 直接做)
- **文件**:`package.json`、目录 `src/` `test/` `scripts/`。
- **做什么**:`package.json`(`type:module`、`engines.node>=20`、`scripts.test="node --test"`、`scripts.test:e2e="node scripts/acceptance.mjs"`、零 deps)。
- **验收**:`node --test` 在空 test 目录下零退出;`node -e "process.exit(0)"` OK。
- **依赖**:无。

### T1 · `src/backend.mjs` 核心 fork(复杂 → deepseek-v4-pro)
- **文件**:`src/backend.mjs`(独占,单 agent 操作)。
- **做什么**(对照 §5 行号表):
  1. 头部注释:`// fork 自 agent-bridge v0.5.1 scripts/agent-bridge.mjs`,列出搬运的符号与行段,便于后续 diff。
  2. **照搬(尽量逐字,别重构)**:常量 `AGENTS`/`LOG_DIR`/`MAX_TEXT`/`DEFAULT_WAIT_TIMEOUT_MS`;工具 `nowIso`/`makeId`/`assertAgent`/`assertCwd`/`agentBin`/`appendLog`/`stripAnsi`/`clampText`/`shellQuote`/`sleep`/`withTimeout`/`ensureDirs`;session 依赖的 `compactEvent`/`compactValue`/`extractVisibleTextDelta`/`extractAssistantText`/`extractLikelyText`;进程树 `listChildPids`/`terminateProcessTree`/`scheduleForceKill`。
  3. **搬两个 session 类**:`OmpRpcSession`(466–780)→`OmpSession`、`CodexAppServerSession`(782–1255)→`CodexSession`。
  4. **解耦(只改这一处)**:两类 `extends EventEmitter`;`setSessionStatus(this,…)`→ 私有 `#setStatus(…)`(改字段 + `emit('status',{status,isStreaming})`);`pushEvent(this,ev)`→ 私有 `#emit(ev)`(推 `this.events` + `emit('event',ev)`);在 delta 累加点 `emit('delta', 增量)`——omp 见 628(`text_delta`)、codex 见 1002(`item/agentMessage/delta`)。
  5. **删干净(一行不抄)**:SSE(`sessionEventPayload`/`sendSse`/`broadcastSessionEvent`);PID 落盘(`pidRecordPath`/`writePidRecord`/`removePidRecord`/`processCommand`/`roleMatchesCommand`/`ownerStillRunning`/`cleanupStalePidRecords`,以及 `start()` 里的 `#writePidRecord(...)` 调用点 omp 522 / codex 821 与 `#writePidRecord` 方法本体 omp 567);daemon/MCP/HTTP/UI 全套(1290–2947 中除 `doctor`/`sleep`/`withTimeout` 外)。
  6. **跨平台进程树**(PROTOTYPE §2.4):`listChildPids`/`terminateProcessTree` 现用 `pgrep`/`ps` 仅 POSIX;按 `process.platform` 加 `win32` 分支用 `taskkill /pid <pid> /T /F`(不引第三方库)。
  7. **可测注入点**(PROTOTYPE §7.1 要求预留):`openBackend()` 接受可选 `spawnImpl`(默认 `child_process.spawn`),透传到 session 的 spawn 调用(omp 516 / codex 815),供契约测试注入 fake 子进程。
  8. **导出**:`openBackend({agent,cwd,write=false,model,effort,spawnImpl})` → `new Omp/CodexSession(...)` 并 `start()`,返回 session;`doctor()` → `{omp:{available,version},codex:{available,version}}`。
  9. **session 语义**(PROTOTYPE §2.2):`send(msg,{wait=false,timeout_ms})`(默认投递即 resolve,不等本轮);`result()`(≥`text/agent/model/effort/status`);`summary()`(`agent/model/effort/status/累计轮数`);`abort()`;`close()`。
- **验收标准**:
  - `node -e "import('./src/backend.mjs').then(m=>m.doctor()).then(d=>console.log(JSON.stringify(d)))"` 输出 omp/codex 的 `available:true` + version。
  - 注入 fake spawn 的最小脚本:`openBackend({agent:'omp',spawnImpl:fake})` → fake 吐预设 `text_delta` → 监听到 `'delta'` 且累加文本正确 → `'status'` 走到 `idle`。
  - 文件内**无** `createServer`/`net.`/`http.`/SSE/PID 落盘残留(grep 为空)。
- **怎么测**:T1 自带上面两条 smoke 脚本;正式契约测试在 T4。
- **依赖**:T0。**并发**:独占 `backend.mjs`,与 T2 不冲突文件,但 T2 依赖其导出接口 → T1 先行。

### T2 · `src/cli.mjs` 单会话 MVP(简单 → minimax-m3)
- **文件**:`src/cli.mjs`(新建)。
- **做什么**:
  1. 参数解析 `--agent` / `--model` / `--effort` / `--write`(用 backend 同款或自写 minimal parser,零依赖)。
  2. 启动先 `doctor()`:所选 agent 不可用 → **清晰可操作**报错(提示装哪个 / 设 `OMP_BIN`/`CODEX_BIN`)+ **非零退出**(F1/A4)。
  3. `openBackend()` 开**一个**会话(默认 omp、`write:false`、`cwd=process.cwd()` 绝对路径)。
  4. `session.on('delta', t=>process.stdout.write(t))` 逐字打印(F3)。
  5. `node:readline` REPL:普通行 → `send` 给当前会话(非阻塞);靠 `'status'` 变 `idle` 收本轮、再提示输入下一句(F3/F5)。
  6. `/exit` 或 EOF(Ctrl-D)→ `close` **所有**会话后退出;退出路径**无残留**子进程。
- **验收标准**:
  - **A1**:`node src/cli.mjs` 开 omp,发一句,终端逐字实时输出,`/exit` 退出后 `pgrep -f 'omp --mode rpc'` 为空。
  - **A3**:同会话连发 ≥2 句,各自逐字流式;`/exit` 与 EOF 都干净退出并 `close`。
  - **A5**:`node src/cli.mjs --agent omp --model minimax-m3 --effort high` 后,`summary()`/`result()` 体现该 model/effort。
- **依赖**:T1。**并发**:独占 `cli.mjs`,但与 T3 同文件 → **T2、T3 必须串行**。

### T3 · `src/cli.mjs` 多会话 + 路由 + Ctrl-C + 非交互入口(复杂 → deepseek-v4-pro)
- **文件**:`src/cli.mjs`(在 T2 之上扩展,**串行于 T2**)。
- **做什么**(PROTOTYPE §4.1):
  1. 多会话:`/open [--agent A][--model M][--effort E][--write]` 新开并分配短标签(`omp#1`/`codex#2`)设为当前;`/use <label>` 切换;`/sessions` 列状态。
  2. 路由:普通行 → 当前会话;`@<label> <msg>` → 定向;`@all <msg>` → 广播。
  3. **多路 `'delta'` 带标签前缀分行、不串台**(A2/A4):按 label 行缓冲,任一会话未到换行不与另一会话同行混字。
  4. `Ctrl-C`(SIGINT):`abort` 当前 turn → `close` **所有**会话 → 退出,**无残留**。
  5. 非交互入口:`--task <agent>:<prompt>`(可重复)→ 开多会话、各发任务、并行流式、全 `idle` 后打印**汇总**并退出(A2 可脚本化)。
- **验收标准**:
  - **A2**:`node src/cli.mjs --task omp:"任务甲" --task codex:"任务乙"` → 两路实时带标签分区不串台 → 结束给汇总;退出后无残留 omp/codex。
  - **A4**:REPL 中 `Ctrl-C` → abort + close 全部后退出;退出后 `pgrep -f 'omp --mode rpc'`、`pgrep -f 'codex app-server'` 均空。
- **依赖**:T2(同文件)。**并发**:与 T2 串行。

### T4 · 测试与集成验收(codex 主导,复杂部分可回 deepseek)
- **文件**:`test/*.test.mjs`、`scripts/acceptance.mjs`。
- **做什么**(PROTOTYPE §7.1 两层):
  1. **契约/单元(`node --test`,CI 无 agent 也能跑)**:参数解析;`'delta'`/`'status'` 事件分发(fake spawn);**多路 delta 标签分区不串台**;退出清理逻辑。全部走 T1 预留的 `spawnImpl` 注入点。
  2. **集成验收 `scripts/acceptance.mjs`(需真实 omp/codex,本机跑)**:逐条断言 A1–A5,残留检测用 PROTOTYPE §8 的 `pgrep`(本机 POSIX)。CI 无 agent 时跳过并说明。
- **验收标准**:`node --test` 全绿;`node scripts/acceptance.mjs` 在本机 A1–A5 全过且收尾无残留。
- **依赖**:T1/T2/T3。

## 3. 执行顺序与并发约束

```
T0 ──> T1(backend.mjs,deepseek,独占) ──> T2(cli.mjs MVP,minimax) ──> T3(cli.mjs 多会话,deepseek)
                                              └────────── 串行(同一 cli.mjs)──────────┘
                                                                                        └──> T4(tests+验收,codex)
```

- **可并行**:契约测试骨架(T4 第 1 层的 fake 子进程脚手架)可在 T1 完成后、与 T2 并行起草——但写的是 `test/` 不碰 `cli.mjs`,无文件冲突。
- **必须串行**:T2 与 T3(同 `cli.mjs`);任何 write 开发 agent **不并改重叠文件**(WORKFLOW §5)。
- **git**:每个任务验收过(codex `SOUND` + 测试绿 + 对照验收标准)后,Claude Code **一任务一提交**。

## 4. 每任务的 review 闭环(WORKFLOW §3 主循环)

对 T1/T2/T3 各自:派发(write)→ 收开发结果(粗看跑题/越界)→ codex 只读审查 + 跑测试(给 `SOUND`/`HAS-DEFECTS`)→ triage 真问题 → 下发精确修改指令 → 复测 → 三者同时满足(codex SOUND + 测试绿 + 验收标准逐条过)即 done → 提交。同一任务连续 **3 轮**不过 → 升级(Claude Code 亲自定位 / 换 agent / 回报用户)。

## 5. 0.5.1 行号重映射表(给开发 agent 的 fork 指南)

> 源:`~/.claude/plugins/cache/agent-bridge/agent-bridge/0.5.1/scripts/agent-bridge.mjs`(2947 行)。
> 文档(0.4.0)→ 本机(0.5.1)对照,搬运/删除以本表为准。

**搬运(尽量逐字)**
| 符号 | 0.5.1 行 | 备注 |
|---|---|---|
| `DEFAULT_WAIT_TIMEOUT_MS` / `MAX_TEXT` / `LOG_DIR` / `AGENTS` | 13 / 15 / 20 / 25 | 常量 |
| `nowIso`/`makeId`/`assertAgent`/`assertCwd`/`agentBin`/`appendLog`/`stripAnsi`/`clampText` | 210/214/218/222/230/235/241/245 | 工具 |
| `compactEvent`/`compactValue`/`extractVisibleTextDelta` | 270/274/311 | session 依赖 |
| `shellQuote` | 348 | |
| `listChildPids`/`terminateProcessTree`/`scheduleForceKill` | 370/400/411 | **POSIX-only,需加 win32 分支** |
| `OmpRpcSession`→`OmpSession` | **466–780** | spawn 在 516;delta(`text_delta`)在 628;`#writePidRecord` 方法 567、调用 522 |
| `CodexAppServerSession`→`CodexSession` | **782–1255** | spawn 在 815;delta(`item/agentMessage/delta`)在 1002;`#writePidRecord` 调用 821 |
| `extractAssistantText`/`extractLikelyText` | 1256/1273 | codex 文本提取 |
| `doctor` | 1401 | 导出 |
| `sleep`/`withTimeout` | 2926/2930 | 工具 |

**改造(解耦)**:`pushEvent`(251)→`#emit`;`setSessionStatus`(259)→`#setStatus`;delta 发射点 628 / 1002。

**删除(不抄)**
| 类别 | 符号(0.5.1 行) |
|---|---|
| SSE | `sessionEventPayload`317 / `sendSse`330 / `broadcastSessionEvent`339 |
| PID 落盘 | `pidRecordPath`354 / `writePidRecord`358 / `removePidRecord`364 / `processCommand`379 / `roleMatchesCommand`385 / `ownerStillRunning`392 / `cleanupStalePidRecords`424 |
| daemon/MCP/HTTP/UI/CLI facade | `openSession`1290…`closeSession`1394、HTTP/UI 1477–2387、daemon 2389–2624、`runCli`/MCP 2647–2855 等(除 `doctor`/`sleep`/`withTimeout`) |

## 6. 未决项(PROTOTYPE 标注"先按现写实现,不阻塞 MVP1")

- 多会话"当前会话"默认取最后 `/open` 的;`--task <agent>:<prompt>` 冒号/空格转义按最简实现。
- fake-backend 自动化:T1 预留 `spawnImpl` 注入点,T4 第 1 层用它做契约测试(本 plan 已纳入,不再标"后续")。

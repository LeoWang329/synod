# Mesh 编排根治 + 编排技能注入 — TDD 开发计划

> 覆盖 [`TODO.md`](TODO.md) 的 **4 / 5** 两条(item 6 聊天室已移除,暂不做)。起草 2026-06-09。
>
> 1–3(flow 引擎、relay、标记驱动编排 B1–B4)已合入 `main`,见 [`HANDOFF.md`](HANDOFF.md)。
> 本计划把"**编排总线根治**(item 5)"和"**平级 mesh 注入**(item 4)"落成测试先行的增量。
>
> **评审状态:已过 deepseek + codex + minimax-m3 三方评审(2026-06-09),修订已并入本文。** 三方一致裁决见文末「风险/未决」表(R1–R5 全定);采纳要点:① R1 首行白名单闸;② R2 删 `control-dispatch.mjs`、护栏并入 `repl-dispatch`;③ R4 agent-fence 禁 `@all`;④ A0 dispatch 返回 `{redraw,exit}` + 注入 `defaultAgent` + 补 Tier1 CLI 集成刻画;⑤ A4 全局开关 + `meshFromEnv` 注入 + 透传链契约测;⑥ A5 指纹断言 + 框定句;⑦ A7 `#request` 私有→假 app-server/可注入重构 + 核实 `developerInstructions` 字段;⑧ 安全总判据诚实降级为可信 mesh 模型。结论:**改完(已改)可开工**。

---

## 0. 两件事是什么(一句话)

| # | 名字 | 一句话 | 顺序 |
|---|---|---|---|
| 5 | **nonce 根治** | 去掉 nonce/授权,控制通道从 `nonce + JSON 命令` 改为 ` ```synod ``` ` 围栏 + **复用 REPL 命令**,turn 结束解析喂回现成 dispatch;护栏照旧 | **先做(A0–A3)** |
| 4 | **编排技能注入** | spawn 每个 agent 时注入"怎么用 ` ```synod ``` ` 总线"的指令(omp `--append-system-prompt` / codex `developerInstructions`),**默认关、显式开、零影响** | **后做(A4–A7,依赖 5)** |

> **为什么 5 在 4 前**:4 注入给 agent 的"总线用法"文本,描述的就是 5 定稿后的协议。先做 5 把协议冻死,4 才有确定的东西可注入,否则注入完立刻又改一遍。
>
> **item 6 聊天室已移除**(用户 2026-06-09 决定暂不做)。原 TODO 的设计草案(独立 flow、可配参与者+主持人、共享黑板单一写者)可从 git 历史 / `docs/TODO.md` 旧版恢复。

---

## 1. 架构决策(先冻结,避免返工)

这些是动手前要锁死的判断;评审者请优先挑这一节。

1. **顺序**:`5 → 4` 串行(协议先定再注入)。
2. **控制通道改造路线**:从 `nonce + 单行 JSON` 改为 **` ```synod ``` ` 围栏内放 REPL 命令**(`/open --agent omp`、`@codex#1 …`、`/relay a->b`),turn 结束后解析,**喂给现成的 REPL dispatch 执行**。
   - **前置重构**:当前 REPL dispatch 逻辑**内嵌在 `cli.mjs` 的 `onLine` 闭包**(`cli.mjs:357–496`),无法被程序化调用。要"喂回现成 dispatch",必须先**把 dispatch 抽成可注入、可单测的单元**(characterization-first,见 A0)——这是诚实的前置,不是顺手优化。
3. **护栏保留(与 nonce 无关的另一类安全)**:默认只读(围栏里 `/open --write` 被拒)、最大会话数、**最大递归/嵌套深度**(防一个 agent fork-bomb)、agent/model 白名单、**围栏命令白名单**(只放 `/open`、`@label`/`@all`、`/relay`/`/unrelay`;排除会动人类会话状态的 `/use`、`/exit`、`/quit`、以及纯文本)。删 nonce **不能**连这些一起删。
4. **注入默认关**:用 flag/env(暂名 `--mesh` / `SYNOD_MESH`)显式开才注入;**必须有测试证明"未开 mesh 时两个后端的启动参数 / `thread/start` 请求逐字节不变"**。
5. **注入隔离**:omp flag 只进子进程 argv、codex 字段只进 Synod 发出的那条 `thread/start`;**不写 `~/.omp` / `~/.codex`**。不经 Synod 直接跑 `omp`/`codex` 时零影响。
6. **横切约束:Windows 兼容**。本仓已做过跨平台兼容(`d26cd06`:spawn `.cmd/.bat` + ESM 路径 + e2e)。本计划所有改动**不得回退**:① 围栏解析只认 `\n`(已 `\r\n→\n` 归一,沿用);② 注入文本若走"文件"形态需用 `path.join` 且兼容反斜杠;③ e2e/测试里跑命令一律 `node -e`(跨平台确定),不用 `echo`/POSIX-only;④ 路径断言不写死 `/`。每个增量的 DoD 默认含"Windows 路径/换行不破"。
7. **安全模型(评审校正:北极星 vs 根治后的现实)**——codex/minimax 一致指出原表述自相矛盾,诚实重写:
   - **北极星判据**:被不可信内容注入的 agent,仅凭其上下文无法伪造合法控制指令。
   - **去 nonce 的代价(诚实标注)**:协议语法一旦公开且无授权,一个**裸的合法围栏**(` ```synod\n/open …\n``` `)**就是**合法控制——**强形式判据不再成立**。根治方案(TODO item 5 已拍板)有意把它**降级为「可信 mesh 模型」**:链路内无外部不可信内容时可接受。
   - **补偿控制(把残留压到最低,不是消除)**:① **围栏体首行必须是已知命令前缀 `/` 或 `@`,否则整块作废**(R1,见 A1)——挡掉"agent 把语法当注释/示例原样输出"这一**必然**形态;② 护栏限爆炸半径(maxSessions/maxDepth/白名单/默认只读/**agent-fence 禁 `@all`**)。
   - **不再声称**:E4/A2 只证明"注释/外层块/缩进/散文**不触发**",**不**声称"裸的合法围栏示例零副作用"——那是被接受的可信环境残留风险。

---

## 2. 角色分工 + 每任务闭环

沿用 [`HANDOFF.md`](HANDOFF.md)「角色分工」,**职责严格分开,不串**。每个任务卡片标注 `【D】【C】【★】`:

- **【D】deepseek-v4-pro = 开发(写代码 + 写全部测试)**
  会话:`agent:"omp"` + `model:"deepseek/deepseek-v4-pro"` + `effort:"xhigh"` + `write:true`。按我给的任务规格写**实现和测试**(测试唯一写者),只动规格里写死的文件边界,完成报告改/建文件 + 自跑 `npm test` 结果。不审核、不自行扩范围。
- **【C】codex = 审核 + 测试验证(只读)**
  会话:`agent:"codex"` + `write:false`。审 deepseek 产出的代码与测试质量(fidelity、假信心、漏测、过度设计,给具体位置 + 怎么改);**独立跑 `npm test`** 验证真绿;漏测给出具体补测用例(由 deepseek 落地,codex 复审复跑)。不写实现、不写测试。
- **【★】Claude(我)= 规划 + 协调调度 + 监控 + 验收**
  写任务规格、定依赖顺序、派活、`Task` 跟踪;**亲自 `git diff` + 跑 `npm test` 验产物**(不信回传文本);对 codex 意见分诊(采纳/反驳),决定是否打回 deepseek;闭环把关。**不亲自写实现代码。**

**每任务闭环**:我写规格 → 【D】开发(代码+测试,`wait:false` + 短超时轮询)→ 我 `git diff`+跑测验产物 → 【C】审 + 独立跑测 → 有问题/漏测 → 我分诊 → 打回【D】修/补 → 【C】复审复跑 → 代码审过+测试实跑绿 → 【★】验收 → 下一任务。
派活运维坑(模型串要 provider 限定、`wait:false`+查盘、别 `pkill omp`、daemon 重启冲会话按"只补还差的"恢复)见 [[agent-bridge-delegation-gotchas]] 与 HANDOFF「agent-bridge 运维要点」。

---

## 3. 测试策略(两层,沿用现有约定)

- **Tier 1 · 契约/单元**(`test/*.test.mjs`,`npm test` = `node --test`,零依赖、不碰真 agent)。纯函数 + 注入 fake 会话(`test/helpers/fake-backend.mjs` 的 `fakeOpenBackend`/`FakeSession`)。对齐 `parse-args.test.mjs` / `control-marker.test.mjs` 风格。
- **Tier 2 · e2e 验收**(`scripts/acceptance.mjs`,真实 omp/codex,`doctor()` skip-if-missing,`runCli()` 喂 stdin 断言 stdout)。
- **纪律**:每增量先写 Red 并确认失败 → 最小 Green → Refactor 保持绿。Tier 1 全程绿且 < 数秒;Tier 2 只跑 happy-path,缺 agent 自动跳过。
- **删测纪律(本轮特有)**:5 要删/改 nonce 相关的 control-* 测试。**不能直接删了事**——每删一个 nonce 断言,必须有一个等价的"围栏 + REPL 命令 + 护栏仍生效"断言顶上,**净覆盖不下降**。codex 重点盯这一条(防"删测=假绿")。

---

# 增量 — 控制总线根治(5)+ 编排技能注入(4)

> 分支建议:新开 `mesh-control`。文件域:`src/control-*.mjs`、`src/cli.mjs`、新 `src/repl-dispatch.mjs`、`src/backend.mjs`、`scripts/acceptance.mjs` + 对应 `test/`。

## 现状代码锚点(动手前对齐)

- `src/control-marker.mjs` — `extractControlCommands(text,{nonce})`:解析 ` ```synod <nonce> ``` ` 围栏,体=单行 JSON `{cmd:open|send,…}`;无 nonce → 不认任何命令。
- `src/control-dispatch.mjs` — `createControlDispatch({manager,guardrails,log,depth})`:命令 → `manager.open/enqueue` + 护栏(`maxSessions/maxDepth/allowedAgents/allowedModels/allowWrite`)。
- `src/control-wire.mjs` — `createControlChannel` + `wireControl({sm,registry,stderr,guardrails,nonce})`:在 turn 完成点把 relay + control 合成一个 `onTurnComplete`;默认护栏 `maxSessions:10,maxDepth:3,allowWrite:false`;含 per-label 深度跟踪。
- `src/cli.mjs` — `main({…,nonce=process.env.SYNOD_CONTROL_NONCE})`;REPL dispatch 内嵌在 `onLine` 闭包(`cli.mjs:357–496`),处理 `/open /use /sessions /relay /unrelay /relays @label @all` + 普通行;`wireControl({sm,registry,stderr,nonce})` 在 `cli.mjs:345`。
- `src/backend.mjs` — omp 启动参数 `OmpSession.start()` 在 **`backend.mjs:413`**(`args` 数组,已带 `--no-extensions --no-rules`,**未带** `--no-skills`);codex `thread/start` 在 **`backend.mjs:925`**(`CodexSession.start()`)。
- `src/session-manager.mjs` — `open({agent,model,effort,write,announce})→label`、`enqueue({target,msg})`、`_sessions` Map、per-label 计数 `agent#n`。

---

## A0 ·(前置重构)抽出可注入的 REPL dispatch（characterization-first)【D】【C】【★】

- **目标**:把 `cli.mjs:onLine`(357–496)的命令分发抽成 `src/repl-dispatch.mjs`:`createReplDispatch({ sm, registry, stdout, stderr, defaultAgent })` → `dispatch(line, { source }): Promise<{ redraw: boolean, exit?: boolean }>`。`source` 默认 `"human"`,**A0 只支持 human、行为完全不变**(`agent-fence` 到 A2 启用)。
- **🔴 抽取必须保真的三处隐藏耦合(评审 codex/deepseek 一致,否则单元绿、接回 CLI 炸)**:
  - **① writePrompt 时机是条件性的**:`/open`/`/use`/`/relay…`/未知命令 执行后**立即重绘**;但 `@label`/`@all`/普通行**不重绘**(靠 `onIdle` 异步重绘,`cli.mjs:487-488` 注释)。→ `dispatch` **返回 `{redraw}`**,调用方按返回决定是否 `writePrompt`;**禁止**"dispatch 后无条件重绘"(会给 `@label` 多画 prompt,fake 无真 streaming 抓不到)。
  - **② `/exit`/`/quit`**:唯一操作 REPL 生命周期(`cli.mjs:360` `repl.closeRl()`)→ `dispatch` 返回 `{exit:true}`,调用方 `closeRl()`(**不**把 `closeRl` 注进 dispatch)。
  - **③ `/open` 默认 agent**:无 `--agent` 时用 CLI 默认(`cli.mjs:449` `opts.agent || args.agent`)→ 注入 `defaultAgent`,补测"`/open` 不带 agent 仍开默认 agent"。
- **Red**:
  - `scripts/acceptance.mjs` **刻画补全**(锁现状,先绿):① 单会话发消息→拿输出;② `@label` 定向 + `@all` 广播;③ `/use` 切换;④ `/relay`+发消息→目标收到;⑤ `Ctrl-D` 退出无残留子进程。
  - `test/repl-dispatch.test.mjs`(注入 fake `sm`/`registry`):逐命令断言路由 + **`redraw` 返回值**(`@label`/`@all`/普通行→`redraw:false`;`/open`/`/use`/`/relay`/未知→`redraw:true`;`/exit`→`exit:true`)、`/open` 无 `--agent` 用 `defaultAgent`、`/relay a->b` 校验两端 + `registry.add`、未知命令→stderr。
  - **🔴 Tier 1 CLI 集成刻画(codex 必须改)**:`test/cli.integration.test.mjs` —— `main({stdin,stdout,stderr,openBackend:fakeOpenBackend})` 喂 `/open`/`@label`/`@all`/`/use`/`/relay`/`/exit`,断言 fake session 收到消息、prompt 重绘次数、stderr 错误。**补这层防"acceptance 会 skip、单元 fake 又接不回真 CLI"。**
- **Green**:抽 `src/repl-dispatch.mjs`;`cli.mjs:onLine` 改为 `const r = await dispatch(line,{source:"human"}); if(r.exit) repl.closeRl(); else if(r.redraw) repl.writePrompt();`。
- **DoD**:刻画 + 集成测试绿;`git diff` 证明 `cli.mjs` 仅"调用搬家";三处隐藏耦合各有断言;Windows 换行不破。

## A1 · ` ```synod ``` ` 围栏解析（纯函数,去 nonce,测试最重)【D】【C】【★】

> 文件改名建议:`control-marker.mjs` → `control-fence.mjs`、测试 → `control-fence.test.mjs`(职责已从"标记+JSON"变"围栏+REPL 行")。

- **目标**:`extractFenceCommands(turnText) → { lines: string[], warnings }` —— 在**完整 turn 文本**上找 ` ```synod ``` ` 围栏(**info 串恰为 `synod`,无 nonce**),体内每非空行作为 REPL 命令字符串取出,去重保序。复用现有 CommonMark 围栏机(`parseFenceLine`/`isFenceCloser`/`findCloser`,通用、不依赖 nonce),**只摘 nonce 校验 + 删 JSON `validateCommand`**。
- **🔴 R1 首行白名单闸(评审三方一致必改)**:词法防线(列 0 + info 串恰为 `synod` + 外层 fence 优先)**只能挡"块被误认",挡不了"块被认对、但内容是 agent 注释/示例"**——后者在"agent 被告知语法→必然引用语法"下 100% 出现。**收口**:围栏体内**第一条非空行必须以 `/` 或 `@` 开头**,否则**整块作废 + warning**(不止丢该行)。所有已知 REPL 命令首字符恰好都是 `/`/`@`,这是天然前缀闸。
- **Red** — `test/control-fence.test.mjs`:
  - **返回类型显式断言一次**:`lines` 是**字符串数组**(防顺手返回 JSON 对象/混合形态)。
  - 体内 `/open --agent omp` / `@codex#1 hi` / `/relay a->b` → 原样进 `lines`,保序去重。
  - **假阳性四连**:① 散文出现 "synod";② 非列 0(缩进/嵌套在普通围栏里)的 ` ```synod ``` `;③ 贴进**外层普通代码块**的围栏(外层 fence 优先);④ **R1 杀手:块被认对、但首行是散文/注释(`# 演示…`)→ 整块作废**。全部断言空 `lines`。
  - **info 串双向**:认 `synod`(含 CommonMark 允许的尾随空白)、不认 `synod x`。
  - **body 缩进命令**:体内行内缩进的 ` /open` 按"首行须顶格 `/`/`@`"口径处理——写进测试 + A5 文本。
  - **分片重组**:只在完整 turn 文本上解析(复用 control-marker 现有 turnText 测试,别重造)。
  - **去 nonce 语义(改成有价值的)**:不再测"无 nonce 也能解析"(必然结论),改测"**无 mesh 时围栏命令不进 dispatch**"(协议可用但默认没人用)——此条落在 A2/A4 交界。
- **Green**:`extractFenceCommands` + R1 首行闸;删 nonce 分支、`validateCommand`、`VALID_CMDS`、`randomUUID` import(死代码)。
- **DoD**:Tier 1 绿;假阳性四连(含 R1 注释形态)全过;返回字符串数组;`indent===0` 严格性写进注释(防后人"修"成 0–3)。

## A2 · 围栏命令白名单 + 护栏（agent-fence 路径）【D】【C】【★】

- **🔴 R2 拍板(评审三方一致)**:护栏**并入 `repl-dispatch` 的 `agent-fence` 分支**,`control-dispatch.mjs` **整文件删除**(A3 一起删)。理由:新协议是 REPL 行字符串、不再有 JSON 命令对象,保留 `control-dispatch` 等于多一个"字符串→JSON 命令对象"翻译层 + 两套护栏漂移源。把 `control-dispatch._guard()` 整段迁进 `agent-fence` 分支。
- **逐行执行(deepseek)**:`lines` **逐行依次** `await dispatch(line,{source:"agent-fence",depth})`(非批量)——保持 REPL 语义:前一行 `/open` 开完,后一行 `@newlabel` 能引用刚开的会话。
- **命令白名单(agent-fence)**:**显式枚举放行** `/open`、`@<具体 label>`、`/relay`(`/unrelay` 见下)。**拒绝**:
  - **🔴 R4 `@all`(评审三方一致,minimax 杀手理由)**:`@all` 不开会话、只 enqueue → **护栏 maxSessions/maxDepth 根本不挡它**,一次广播放大 N 倍 = 绕护栏的洞。多方通信走多行 `@label1 …` `@label2 …`。**人用路径 `@all` 不变**(`cli.mjs` 的 `@` 分支不动)。
  - `/use`、`/exit`、`/quit`(动人类会话状态)、`/sessions`/`/relays`(侦察面)、非命令纯文本行 → 不执行 + warning。
  - **🟡 `/unrelay` 细化(codex)**:agent-fence 的 `/unrelay` 只许操作"涉及发起 label"的 relay(防 agent 拆人建的拓扑);MVP 可先只放 `/open`+`@label`+`/relay`,`/unrelay` 视实现决定。
- **护栏**:`/open` 受 `maxSessions`、`maxDepth`、`allowedAgents`/`allowedModels`、`allowWrite=false`(`/open --write` 被拒)。**深度数据流写死(deepseek)**:`wireControl`(接线层)维护 per-label depth map,`onTurnComplete` 调 dispatch 时把发起会话 depth 当**入参**传入,child 记 depth+1;dispatch **不**自己反查 parent。
- **Red** — `test/control-safety.test.mjs`(重写为"围栏 REPL + 护栏"):
  - 白名单:`@all`(agent-fence)→ 拒 + warning(`reason:'@all not allowed in agent-fence'`),而 human `@all` 仍通;`/use`/`/exit`/`/quit`/`/sessions`/纯文本 → 拒 + warning。
  - 护栏逐条:超 `maxSessions` 拒;`depth>=maxDepth` 拒(断言 child 记 depth+1、grandchild 被挡);agent/model 白名单;`/open --write` 在 `allowWrite:false` 拒。
  - **🔴 零副作用断言(不只 warning,codex/minimax)**:每条"拒"都断言 `sm.open`/`sm.enqueue`/`registry.add/remove` **未被调用**、`currentLabel` 未变。
  - **固化误引用 fixture(minimax)**:① 列 0 围栏但体首行是注释 → 整块作废(R1);② 外层普通围栏内嵌围栏 → 外层优先;③ 命令后紧跟解释行 → 命令执行、解释行 warning。再加近似命令反例:`open --agent omp`(无 `/`)、`/OPEN`(大写)→ 不识别。
- **Green**:`repl-dispatch.mjs` 的 `agent-fence` 分支(白名单 + 迁入的 `_guard` + 逐行 + 深度入参);错误处理沿用 `control-wire` 现有 fire-and-forget(同步 throw/异步 reject 都不冒泡),别新造。
- **DoD**:Tier 1 绿;白名单(含 `@all` 拒)+ 护栏 + 误引用零副作用全测到;`control-dispatch.mjs` 删除后无残留引用。

## A3 · 接线 + 彻底删 nonce + 重写 control 测试【D】【C】【★】

- **目标**:`control-wire.mjs` 改为"turn 完成 → `extractFenceCommands` → 逐行 agent-fence dispatch";删净所有 nonce 痕迹;删 `control-dispatch.mjs`(R2)。
- **🔴 覆盖对照表先于 Green 产出(codex+minimax)**:Red 阶段先写一张 **"被删断言 → 顶上断言" ledger**(贴进本文件 A3 节作为 Red 完成物证),codex 复审才有抓手。旧 `control-marker.test` 每个语义类标 `keep/adapt/delete`,**至少保留**:BOM、CRLF 归一、4+ 反引号、tilde 非控制、outer-fence 优先、indent、unclosed fence、dedupe、full-turn-only。**净覆盖不下降是硬 DoD。**
- **删净清单(逐项 grep,minimax)**:`SYNOD_CONTROL_NONCE`(env)、`cli.mjs:297` 的 `nonce` 形参、`extractControlCommands({nonce})` 与所有 `nonce:` 字段、`wireControl`/`createControlChannel` 的 `nonce` 形参、`control-marker` 的 `validateCommand`/`VALID_CMDS`、`randomUUID` import。`grep -rE 'nonce|SYNOD_CONTROL_NONCE|validateCommand|control-dispatch' src/` 应只剩注释级解释(或全空)。
- **文件增删**:删 `src/control-dispatch.mjs` + `test/control-dispatch.test.mjs`;`control-marker.mjs`→`control-fence.mjs`;`control-wire.mjs` 去 nonce 形参(保留 relay+control 合成 + per-label depth map)。
- **Red / 改测**:
  - `test/control-wire.test.mjs`:`wireControl({sm,registry,stderr,guardrails})`(无 nonce)turn 完成点先 relay 后 control;围栏命令逐行 dispatch;warning 走 stderr;relay∥control 合成不串味。
  - `test/control-fence.test.mjs`、`test/control-safety.test.mjs`:按 ledger 重写。
  - acceptance 刻画(A0 补的)仍绿。
- **Green**:落地删除 + 接线。
- **DoD**:Tier 1 全绿;nonce/control-dispatch 在 `src/` 绝迹;ledger 净覆盖不降;relay 回归不破。

## A4 ·（item 4)编排模式开关 plumbing（默认关,全局)【D】【C】【★】

- **🟢 R5 拍板:全局开关 MVP**(评审三方一致)。`--mesh`(CLI 级,无值 boolean,同 `--write`)+ `SYNOD_MESH` env 兜底。**本轮不做 `/open --mesh`** per-session 粒度(留门:将来给非编排会话免注入、减 prompt 噪音)。
- **env 注入不污染全局(codex)**:不直接读 `process.env`,用纯函数 `meshFromEnv(env)`(`1`/`true` 为真,`0`/`false`/`""` 为假)+ `main({env=process.env})`。**优先级**:CLI flag 显式传 > env > 默认 `false`。
- **透传链 3 个签名(codex/minimax)**:`mesh` 没有现成字段,要改 `sm.open` → `openSession`(`session-manager.mjs:76`)→ `openBackend({…,mesh})` → `OmpSession`/`CodexSession` 构造存 `this.mesh`。**覆盖所有入口**:默认 interactive 会话(`cli.mjs:521`)、human `/open`(`cli.mjs:451`)、`runTasks`(`cli.mjs:234`)。
- **Red**:
  - `test/parse-args.test.mjs`:`parseArgs(["--mesh"])→{mesh:true}`、无→`false`;**顺带给 `parseOpenArgs` 补基础测试**(`--agent`/`--model`/`--write` happy+error,当前它无测试文件)。
  - `meshFromEnv` 三组合:flag true / env true / 都没;flag 优先于 env。
  - **端到端透传契约测试**:注入 fake `openBackend`,断言 `sm.open` 一路把 `mesh:true` 传到 `openBackend` 入参(**不是**只测 `session.summary()` 内部可见——透传链断了会漏到 e2e 才爆)。
- **Green**:`cli.mjs` 解析+透传 3 处入口;`session-manager.mjs` 透 `mesh`;`backend.mjs` 构造接 `options.mesh`。
- **DoD**:Tier 1 绿;`mesh` 经契约测试证明传到 `openBackend`;三入口都覆盖;默认关。

## A5 ·（item 4)注入文本（单一真源)【D】【C】【★】

- **目标**:导出"编排技能"指令文本(描述 ` ```synod ``` ` 围栏 + 白名单命令 + 护栏 + 默认只读),**omp/codex 共用一份**。
- **内容约束(评审)**:
  - **头部加框定句(minimax)**:"以下是 mesh 协议,与你本来的 system prompt 平等并列"——防 codex developer 层 / omp 误把协议当业务上下文或用户指示。
  - **不提 skill(deepseek)**:文本**只描述围栏协议**,不引用 skill 机制(omp 带 `--no-extensions --no-rules`,引用 skill 会让 agent 困惑)。
  - **措辞(codex)**:不写"需 `--write`"(会诱导 agent 请求写权限);写"默认只读;`--write` 会被 Synod 拒,除非宿主显式放开"。
  - **明确告知有护栏(minimax)**:提 `maxSessions`/`maxDepth`,让 agent 知有限制而克制。
- **Red** — `test/mesh-instructions.test.mjs`:
  - **快照(防漂移)** + **指纹断言(防漏写让 agent 学不会,`assert.match`)**:含 ` ```synod`、`/open --agent`、`@<label>`、`/relay <from>-><to>`、护栏字样;**不含** `nonce`、`@all`、`skill`、诱导性 `--write` 写法。
  - 长度 < 16KB(Windows argv 余量,见 A6)。
- **Green**:`src/mesh-instructions.mjs` 导出常量。
- **DoD**:Tier 1 绿;单一真源;指纹齐;无 nonce/skill/@all 残留;< 16KB。
- **维护护栏(minimax)**:改本文本 = 改 A5 + 重跑 A6/A7"mesh 开"断言 + 跑 e2e E2(挂 DoD)。
- **依赖**:A1 文法定稿后定文本(可与 A4/A6/A7 并行起草)。

## A6 ·（item 4)omp 注入 `--append-system-prompt`（默认关零影响)【D】【C】【★】

- **目标**:`OmpSession.start()`(`backend.mjs:413`)在 `this.mesh` 真时向 `args` 追加 `--append-system-prompt=<MESH_INSTRUCTIONS>`(**追加**,保留默认 coding;不用 `--system-prompt`)。
- **Red** — `test/backend.contract.test.mjs`(**用 `this._spawn` 注入假 spawn 断言 args 数组**,比 `spawnPlan` 出口稳):
  - **mesh 关(默认)**:`assert.deepStrictEqual(args, 基线)`——基线 `["--mode","rpc","--no-title","--no-extensions","--no-rules", …]`,**零影响硬证**(逐字节,非引用相等)。
  - **mesh 开**:删掉唯一的 `--append-system-prompt=…` 后其余 `deepStrictEqual` 基线;该值 == `MESH_INSTRUCTIONS`;断言**无** `--system-prompt`。
  - `--no-skills` 不动(走注入字段、不依赖 skill;文档注明)。
- **Green**:条件追加。
- **DoD**:Tier 1 绿;**mesh 关 argv 逐字节不变**;`MESH_INSTRUCTIONS.length < 16KB`(Windows argv 32KB 余量,超则改文件形态——本轮只留门);Windows spawn `.cmd` 不破。

## A7 ·（item 4)codex 注入 `developerInstructions`（默认关零影响)【D】【C】【★】

- **🔴 开工前两个前置(codex+deepseek)**:
  - **① `#request` 是私有方法**(`backend.mjs`),**不能直接 fake**。A7 Red 要么走"**假 codex app-server 子进程**"——经 `this._spawn`/`spawnImpl` 注入,捕获 `thread/start` 的 JSON-RPC stdin 并应答 `initialize`/`thread/start`;要么先做"**可注入 request 通道**"小重构。**先实地确认有没有现成注入点**,没有就诚实做前置重构,别糊。
  - **② 协议字段核实**:实测/查 codex app-server schema 确认 `thread/start` 支持 `developerInstructions` 顶层字段(非 `systemPrompt` 内嵌)。不支持则定回退(如 `systemPrompt.append`)再开工。
- **目标**:`CodexSession.start()`(`backend.mjs:925`)在 `this.mesh` 真时给 `thread/start` 加 `developerInstructions:<MESH_INSTRUCTIONS>`(developer 层叠加;**不用 `baseInstructions`**)。
- **Red**:
  - **mesh 关(默认)**:捕获的 `thread/start` params **无** `developerInstructions` 键;`cwd/model/approvalPolicy/sandbox/ephemeral/serviceName` 逐字段对齐现状。
  - **mesh 开**:params 含 `developerInstructions == MESH_INSTRUCTIONS`;其余字段不变。
- **Green**:条件加字段。
- **DoD**:Tier 1 绿;**mesh 关 thread/start 逐字段不变**(含 `serviceName`)。
- **A6 ∥ A7**:同改 `backend.mjs` 不同函数(omp `start` vs codex `start`)→ 可并行;**唯一真冲突点 = 两构造函数都加 `this.mesh`**,故 **A4 是硬前置**(A4 把 `this.mesh` 加完),A6/A7 只读不写、冲突面归零。

---

# Phase E — 全场景 e2e 验收（用户要求:各场景都覆盖）

> 真实 agent,`doctor()` skip-if-missing,进 `scripts/acceptance.mjs`。每条都断言"真发生了"(查 stdout / 子进程 / 落盘),不信回传。

| E# | 场景 | 断言要点 | 依赖 |
|---|---|---|---|
| E1 | **mesh 关 = 零影响** | **字段级不变属于 Tier 1 fake 契约(A6/A7)**;E1 真 agent 只断言"mesh 关时 CLI 仍正常启动 + 完成任务"(codex:真 e2e 证不了逐字段) | A6/A7 |
| E2 | **mesh 开 → 围栏开会话** | 引导 agent 吐 ` ```synod\n/open --agent omp\n``` ` → **真开出子会话**(`/sessions` 见新 label) | A2/A3/A6/A7 |
| E3 | **围栏护栏生效** | `/open --write` 被拒(默认只读);**`@all`(agent-fence)被拒**;`/use`/`/exit` 被拒;超 `maxSessions`/`maxDepth` 被拒;**fork-bomb 深度守卫**到顶即停 | A2 |
| E4 | **误引用免疫(注释/外层块/缩进/散文)** | agent 把围栏语法当注释/示例/贴进外层代码块 → **零子会话被开**(R1 首行闸 + 外层 fence 优先)。**诚实边界**:裸的合法围栏示例**会**触发——被接受的可信环境残留风险,E4 不声称挡得住 | A1/A2 |
| E5 | **relay 回归** | **直接复用 `acceptance.mjs` 既有 relay 场景**(minimax:别为 E5 写新 case,省成本非省覆盖) | A0/A3 |
| E6 | **围栏 + relay 协同** | 围栏 `/relay a->b` 在**本 turn 完成点建链 → 下一 turn 起生效**(沿用现有 relay 时序;a 本 turn 产出已流过,不回灌) | A2/A3 |

---

## 并行性矩阵

| 维度 | 关系 | 说明 |
|---|---|---|
| `5(A0–A3) → 4(A4–A7)` | ❌ 串行 | 4 注入的文本 = 5 定稿的协议;先冻 5 |
| A0 → A1/A2 → A3 | ❌ 串行链 | A2 消费 A0 的 dispatch + A1 的 `lines`;A3 接线 |
| A1 → A5 | ⚠️ 软依赖 | 文法定稿后,A5 文本可与 A6/A7 并行起草 |
| **A6 ∥ A7** | ⚠️ 可并行 | 同 `backend.mjs` 不同函数;并行需合并时手解冲突(面小) |
| A4 → A6/A7 | ❌ 串行 | A6/A7 读 `this.mesh`,A4 先把开关透传到构造 |
| A4 提前起步 | ⚠️ 可与 A0 并行 | A4 文件域(`cli` 解析层 + `session-manager` 透传 + `backend` 构造)与 A0–A3 不重叠,可早开(minimax 提速点) |
| Phase E | 串行最后 | E1–E6 依赖各自前置;E2/E3/E4 可并行跑 |

**建议执行序**:`A0→A1→A2→A3`(验收 5 整条根治)`→A4→(A5∥A6∥A7)`(验收 4)`→Phase E`。

---

## 派发顺序(给协调用)

1. 建分支 `mesh-control`;确认基线绿(`npm test`、`agent_bridge_doctor`)。
2. `A0`(前置重构,刻画先行)→ 验收。
3. `A1`(围栏解析)→ `A2`(白名单+护栏)→ `A3`(接线+删 nonce)→ 验收 5 整条根治。
4. `A4`(开关)→ `A5`/`A6`/`A7`(文本+双后端注入,可并行)→ 验收 4。
5. `Phase E` E1–E6 真 agent 全场景。

---

## 风险 / 未决 —— 评审已裁决(2026-06-09 三方一致)

| R# | 议题 | 裁决 | 级别 | 落点 |
|---|---|---|---|---|
| R1 | 删 nonce 后误触发 | **采纳"围栏体首行必须 `/`/`@` 否则整块作废"**;词法防线挡不住"块认对但内容是注释"——必然形态 | 🔴 必须 | A1 |
| R2 | 护栏归属 | **并入 `repl-dispatch` 的 agent-fence 分支,删 `control-dispatch.mjs`**(避免双实现漂移) | 🔴 必须 | A2/A3 |
| R3 | 注入文本形态 | **内联文本** + 长度 < 16KB 留门;文件形态引 Windows 路径坑,不值 | 🟢 选内联 | A5/A6 |
| R4 | agent-fence 允许 `@all`? | **默认拒**;`@all` 绕过 maxSessions/maxDepth 护栏(不开会话只 enqueue)= 放大 N 倍的洞;人用路径不变 | 🔴 必须 | A2 |
| R5 | `--mesh` 全局 vs per-open | **全局 MVP**,本轮不做 `/open --mesh`(留门:将来给非编排会话免注入减噪) | 🟢 全局 | A4 |

> **总判据校正(见第1节决策7)**:R1 之后误触发被压到最低,但**强形式"防注入"判据在去 nonce 后不成立**——根治方案有意降级为可信 mesh 模型,E4 诚实标注边界。
>
> **未采纳的建议(记录):** minimax 提出可把 8 增量压成 6(A0 空壳 + A1 同步起步、A2+A3 合并)。**保留 8 增量**——本项目流程刻意"一增量一闭环好验收"(HANDOFF 已确立),minimax 自己也认可"8 个也行,只是别为工序完整硬拆"。仅采纳其"A4 可在 A0 开工时并行起步(文件域不重叠)"的提速点。

# Flow 引擎 — TDD 开发计划

> 把 [`WORKFLOW_ENGINE.md`](WORKFLOW_ENGINE.md) 的 M0–M4 落成**测试先行**的开发增量。
> 每个增量按 **Red(先写失败测试)→ Green(最小实现)→ Refactor** 推进,且对齐 synod 现有测试约定。
> 起草 2026-06-07。状态:计划。已纳入 codex / deepseek 评审(修正 fake 分层、AST lint 非安全边界、approve 真实 readline smoke)。

## 0. 测试策略(对齐现有约定)

synod 已有两层测试,本计划完全沿用:

- **Tier 1 · 契约/单元**(`test/flow.*.test.mjs`,`npm test` = `node --test`,零依赖、不碰真 agent)。
  - **注入点**:flow runtime 必须像 `openBackend({spawnImpl})` 一样**可注入依赖**——`createRuntime({ openBackend, io, fs, clock })`:
    - `openBackend`:默认真实后端;测试传入 **fake `openBackend`**,它返回一个 **`FakeSession`**(实现 `send(wait)/result/close/on`、吐固定文本)。**注意分层**:contract test 的 `makeFakeOmpProc` 是**进程级** fake(喂给真 `Session` 类跑 JSONL 协议),flow 测试要的是**会话级** fake(直接顶替 `openBackend` 的返回值)——两者不同,flow 用会话级。
    - `io`:`approve` 的 stdin/stdout;测试传入可编程的 fake(喂固定行)。
    - `fs`:run-log/artifact 落盘;测试传内存 sink。
    - `clock`:时间戳;测试传固定时钟(让 log 可断言)。
  - **这是整个引擎可测的前提**——没有这层 DI,flow 无法单元测试。**它本身是第一个增量(F0)的产出**。
- **Tier 2 · e2e 验收**(`scripts/acceptance-flow.mjs`,真实 omp/codex)。
  - 用 `doctor()` 探后端,缺则 `skip`(CI exit 0);happy-path 用真 agent 跑通。
  - 复用现有 `runCli()` 式 harness(spawn 入口、喂 stdin、收 stdout 断言)。

> **测试替身分层 + 复用(评审采纳)**:`makeFakeOmpProc` 现在是 `backend.contract.test.mjs` 的**私有函数,不能直接 import**。F0 先把替身抽到共享 `test/helpers/fake-backend.mjs`,导出两层:① `makeFakeOmpProc`(进程级,backend 协议保真测试用);② `fakeOpenBackend({text,…})` → `FakeSession`(会话级,**flow 测试主力**)。F0 同时**定义 `FakeSession` 接口**——否则 F1 按"复用 fake proc"写法**不可实现**。

> **纪律**:每增量先写 Red 测试并确认它失败,再写 Green 让它过,最后 Refactor 保持绿。Tier 1 必须全程绿且 < 数秒;Tier 2 只跑 happy-path,缺 agent 自动跳过。

---

## F0 · 运行时骨架:ctx 工厂 + JSONL logger + DI(对应 M0)

- **目标**:`createRuntime(deps)` → `createCtx(input)`;logger 按 step 生命周期 + 会话事件 + artifact 分离落 JSONL。
- **Red** — `test/flow.ctx.test.mjs` / `test/flow.logger.test.mjs`:
  - `ctx` 是纯数据:`JSON.stringify(ctx)` 不抛、roundtrip 不丢(断言无函数/live 对象)。
  - logger 对一次 `step:started`+`step:succeeded` 写两行 JSONL,解析后含必填字段(`runId/stepId/node/type/attempt/ts`);失败写 `step:failed` 带 `error`。
  - 大文本经 artifact:`logStep({output: 大串})` → log 行里是 `outputRef` 指针,不内联(断言行长 < 阈值,artifact sink 收到全文)。
  - 注入内存 `fs` sink + 固定 `clock`,断言 `ts` 确定。
- **Green**:`src/flow/ctx.mjs` + `src/flow/logger.mjs`,DI 容器 `createRuntime`。
- **DoD**:Tier 1 绿;ctx 可序列化测试通过。

## F1 · `agent()` 原语(对应 M1 核心)

- **目标**:`agent(ctx, {agent, model, prompt, reuse?})` = 开会话→`send(wait:true)`→拿文本→(默认)关。
- **Red** — `test/flow.agent.test.mjs`(注入 fake openBackend):
  - 返回 fake 的累计文本(断言 == 预期)。
  - **默认一次性**:断言一次调用 open 一次、close 一次(fake 记录调用)。
  - `reuse:true`:连续两次 `agent` 复用同一会话(open 一次),`ctx` 结束时才 close。
  - 写 `session:open`/`session:close`(含 `reused` 标记)+ `step:*` 到 log。
  - 后端报错 → `agent()` 抛 + 写 `step:failed`,且会话被 close(不泄漏)。
- **Green**:`src/flow/api/agent.mjs` 包 `openBackend`。
- **DoD**:Tier 1 绿;fake 验证 open/close 配平。

## F2 · flow 装载 + 线性执行 + 发现/校验 + `bash()`(对应 M1)

- **目标**:扫描 `workflows/`,装载 `meta`+`run`,线性跑通;`bash()` 原语。
- **Red**:
  - `test/flow.discovery.test.mjs`:扫描 `test/_fixtures/workflows/`,断言 **flow 名 = 文件名(去 `.mjs`)**、`meta.description` 被提取;**拒绝**:缺 `run`/缺 `meta.description`/import 了 `synod/flow` 以外模块的 fixture(断言抛带原因)。
  - `test/flow.run.test.mjs`:装载 fixture `linear.mjs`(3 个节点:agent→bash→agent,均 fake/无害),`run(ctx, input)` 返回预期;断言 log 里 3 个 step 顺序正确。
  - `test/flow.bash.test.mjs`:`bash(ctx, 'node -e "process.stdout.write(\'ok\')"')` → `{stdout:'ok', code:0}`(用 `node -e` 保证跨平台确定);失败命令 → `code≠0` 且不抛(返回结构)。
- **Green**:`src/flow/loader.mjs`(发现 + **AST 解析校验 import 白名单**)、`src/flow/runner.mjs`、`src/flow/api/bash.mjs`。
- **DoD**:Tier 1 绿;非法 flow 被拒。

> **import 白名单 = lint 级预检,非安全边界(评审采纳)**:用 **AST** 确定性识别**静态** `import`;`await import('node:fs')` 这类**动态导入不拦**——文档写明,测试**不**把它当硬安全拒绝(否则字符串/静态扫描给假信心,agent 一行绕过)。`FLOW_AUTHORING.md` 的"扫描被拒"按此口径(lint,不是 sandbox)。

## F3 · `approve()` + abort + stdin 不阻塞 smoke(对应 M1,按评审提前)

- **目标**:`approve` 人审 + abort token,**契约直接规定:非阻塞 / 事件驱动**(不"先试阻塞 readline、红了再回退"——那是探针不是 TDD)。
- **Red** — `test/flow.approve.test.mjs`:
  - 注入 fake `io`:喂 `accept` → `{accepted:true}`;`/abort`/空行 → `{aborted:true}`;反馈文本 → `{accepted:false, feedback:'…'}`。
  - **真实 smoke(非抽象 fake)**:用 `PassThrough + readline` 搭贴近真实 REPL 的 stdin,断言 ① `approve` 等待期间并发 fake agent 的 `delta` **仍到达**(事件循环没卡);② readline **不抢输入 / 不与 CLI 输入路由冲突**(deepseek#3 / codex#6——抽象 fake io 测不出这层)。
- **Green**:`src/flow/api/approve.mjs`,事件驱动行读(Red 已规定形态,直接实现)。
- **DoD**:Tier 1 绿,**含真实 readline smoke**。

## F4 · `agentLoop` + 跨节点回退 + `defer` 清理(对应 M2)

- **目标**:节点内自迭代;`while` 回退(喂回反馈、`maxTurns` 上限);`defer` 逆序清理。
- **Red**:
  - `test/flow.backtrack.test.mjs`:fake agent 前 N 轮"审核不过"、第 N+1 轮过;断言循环重试 ≤ `maxTurns`、到点停;**断言 fake 收到的 prompt 含上一轮反馈**(验证"喂回错在哪",非盲目重试)。
  - `test/flow.defer.test.mjs`:注册多个 `defer`;一次回退迭代结束/抛错时,断言清理回调**LIFO 逆序**执行;某节点抛异常 → 该迭代 defer 仍执行。
  - `test/flow.agentloop.test.mjs`:`agentLoop` 到 `until(out)` 真即停,否则到 `maxTurns` 停;复用同一会话。
- **Green**:`src/flow/api/agentLoop.mjs`、回退范式 helper、`src/flow/defer.mjs`。
- **DoD**:Tier 1 绿;回退带反馈、defer 配平。

## F5 · `reviseWithHuman`(方案A)(对应 M3)

- **目标**:产出→人自然语言反馈→改→定稿;复用=优化非依赖;abort 优雅退出。
- **Red** — `test/flow.revise.test.mjs`(fake `io` + fake agent):
  - 脚本化:round1 反馈"改 X" → fake 改 → round2 `accept` → 返回 final;断言每轮进 log。
  - **复用非依赖**:模拟会话中途掉线(fake 在 round2 抛"会话没了"后重建),断言结果仍正确——因为**每轮把全文 doc 显式传入**(断言 fake 每轮 prompt 都含当前全文)。
  - `/abort` → 返回当前稿、**不杀进程**(断言无 `process.exit`/抛)。
- **Green**:`src/flow/api/reviseWithHuman.mjs`。
- **DoD**:Tier 1 绿;掉线仍正确;abort 干净。

## F6 · `runWorkflow` 嵌套 + 护栏(对应 M4)

- **目标**:父 flow 拉起子 flow 拿返回值;深度/并发护栏。
- **Red** — `test/flow.nesting.test.mjs`:
  - 父 fixture 调 `runWorkflow(ctx,'./child', x)` → 子返回值被父用;断言 log 里子 step 带 `parentRunId`。
  - 嵌套深度超上限 → 抛(断言),并发会话超上限 → 排队/拒绝(断言行为明确)。
- **Green**:`src/flow/api/runWorkflow.mjs` + 护栏。
- **DoD**:Tier 1 绿;父子 log 可还原。

## F7 · CLI 入口 + e2e 验收(真实 agent)

- **目标**:`node src/flow.mjs <name> [input]` 跑 flow、`--list` 列出"名字+描述";真实 agent happy-path。
- **Red / 验收** — `scripts/acceptance-flow.mjs`(`doctor()` skip-if-missing):
  - **FA1**:`--list` 列出 fixtures 的名字+描述(纯,不需 agent)。
  - **FA2**:线性 flow + 真 omp → 有产出 + log 合法。
  - **FA3**:回退 flow + 真 codex 审核 → 重试到过/到上限。
  - **FA4**:`reviseWithHuman` 脚本化 stdin 端到端(喂反馈→accept)。
  - **FA5**:嵌套 flow 跑通,log 还原父子。
  - 入口参数解析另起 `test/flow-args.test.mjs`(parse-args 风格纯函数单测)。
- **Green**:`src/flow.mjs` 入口。
- **DoD**:`npm test` 全绿;`node scripts/acceptance-flow.mjs` 在有 agent 时 happy-path 过、无 agent 全 skip。

## 8. 增量依赖与顺序

```
F0(DI+ctx+log) → F1(agent) → F2(loader+bash) → F3(approve+smoke)
                                   ↓
                              F4(loop+回退+defer) → F5(revise) → F6(nesting) → F7(e2e)
```
F3 的 stdin smoke 故意early,失败则先解决再继续(避免 M3 才暴露)。

## 9. 风险与备选(进 Red 测试覆盖)

- approve 卡事件循环 / readline 抢输入(F3 **真实 readline** smoke 拦截)→ 契约即非阻塞事件驱动,无"先阻塞再回退"分支。
- 回退副作用漏清(F4 defer 测试拦截)→ 已用 `defer`,不做整段回滚。
- import 白名单字符串扫给假信心 → 改 AST 校验,且明确 lint 级、非安全边界。
- fake 与真 agent 协议漂移 → Tier 2 happy-path 兜底;会话级 fake 与 `makeFakeOmpProc` 同源(共享 `test/helpers/fake-backend.mjs`),减少漂移。

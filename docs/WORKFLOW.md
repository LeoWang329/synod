# Synod 开发协作模式:Claude Code 编排 + agent-bridge 多 agent

> 一种「总指挥 + 分工 + 审核 + 闭环」的开发模式。Claude Code 当指挥,通过 [agent-bridge](../README.md) 把活派给不同模型,出问题闭环修复,直到无问题。

## 0. 一句话

**Claude Code** 负责拆分 / 规划 / 验收 / 协调,**不亲自写功能代码**;**动手前,先把全部实施、开发、测试落成一份具体、可执行的 plan,再调用对应的 agent-bridge agent 操作**;经 **agent-bridge** 把活派出去:**deepseek-v4-pro** 做复杂功能、**minimax-m3** 做简单功能、**codex** 审核 + 测试。代码出问题由 Claude Code **确认**,向对应开发 agent **下发修改指令**,再测试验收,**循环到没有任何问题为止**。

## 1. 角色与分工

| 角色 | 职责 | 经由 | 会话配置(agent-bridge) |
|---|---|---|---|
| **Claude Code** | 拆分任务、规划、定**可测的验收标准**、派活、triage 缺陷、下发修改指令、最终验收、提交 git | 本体(用 `agent_bridge_*` MCP 工具或 CLI 派发) | — |
| **deepseek-v4-pro** | **复杂功能**开发(核心逻辑、并发、协议解析、多文件、棘手边界) | agent-bridge · omp | `--agent omp --model deepseek/deepseek-v4-pro --effort xhigh --write` |
| **minimax-m3** | **简单功能**开发(单函数、样板、配置、glue、直白小改) | agent-bridge · omp | `--agent omp --model minimax-m3 --effort high --write` |
| **codex** | **审核 + 测试**(审 diff 找真缺陷、跑/补测试、给裁决) | agent-bridge · codex | 审查 `read-only`;需要跑测试时才给可执行(`--write`) |

> **模型必须用 `provider/model` 限定形式**:omp 里同名模型可能落到多个 provider,只写 `minimax-m3` 会被解析到 `kilo`(本机无 key,直接失败)。本机已配 provider 见 `~/.omp/agent/config.yml`:minimax → **`minimax-code-cn/MiniMax-M3`**(baseUrl `api.minimaxi.com`),deepseek → **`deepseek/deepseek-v4-pro`**。换机器前先核对该文件里的 provider 名。
>
> Claude Code 是大脑,deepseek/minimax 是手,codex 是质检。指挥本身**不下场写功能代码**(除非第 4 节的兜底升级)。
>
> 测试用什么、怎么分层(契约测试 vs 集成验收)见 [`PROTOTYPE.md`](PROTOTYPE.md) §7.1。

## 2. 复杂 vs 简单(派给谁)

- **复杂 → deepseek-v4-pro**:核心/load-bearing 逻辑、异步/并发、协议或数据解析、跨多文件、棘手边界条件、需要设计取舍。
- **简单 → minimax-m3**:单函数、样板代码、配置项、格式/重命名、明确无歧义的 CRUD/拼接、小修补。
- **拿不准 → 按复杂处理**(给 deepseek)。

## 3. 主循环(核心)

```
落地可执行 plan → [派发开发] → [审核+测试] → triage → 有问题? ──是──> [下发修改] → 回到“审核+测试”
                                                       └──否──> 任务验收 → 提交 → 下一个任务
```

0. **落地可执行 plan(Claude Code,先规划后动手)**:读需求(如 `docs/PROTOTYPE.md`),把**全部实施 / 开发 / 测试**落成一份**具体、可执行**的 plan——
   - 拆成**小而可验收**的任务,排好**顺序与依赖**;
   - 每个任务写清:**复杂/简单 → 派给谁**、**涉及哪些文件**、**具体要做什么**、**可测的验收标准**、**怎么测(具体命令)**;
   - 标出**并发约束**(哪些能并行、哪些必须串行,见 §5)。

   **这份 plan 定下来之前,不调用任何 agent-bridge agent。** plan 先明确写出(给用户过一眼),再开始派发。
1. **派发(Claude Code → 开发 agent)**:**按 plan**,对每个任务开对应 agent 的会话,发送「任务说明 + 涉及文件 + 验收标准 + write 模式直接改文件」(模板见 §6)。
2. **收开发结果**:agent 改完文件并自述改动。Claude Code 先粗看是否跑题/越界。
3. **审核 + 测试(Claude Code → codex)**:开 codex 会话,指向本次改动,要求「找真实缺陷 + 跑测试(或补测试)+ 给 `SOUND`/`HAS-DEFECTS`」(模板见 §6)。
4. **triage(Claude Code)**:判定 codex 的发现哪些是**真问题**(确认),过滤误报。
5. **下发修改(Claude Code → 对应开发 agent)**:有真问题 → 写**精确的修改指令**(具体到文件/函数/期望行为),发回**负责该功能的 agent**(复杂回 deepseek,简单回 minimax)。
6. **回到第 3 步** 重新审核 + 测试。
7. **任务验收(Claude Code)**:`codex=SOUND` + 测试全绿 + 对照原验收标准通过 → 该任务 done,Claude Code **提交 git**,进入下一个任务。

**循环第 3–6 步,直到没有任何问题为止。**

## 4. 终止条件与防死循环

- **"没有任何问题"的客观定义**(三者同时满足才算过):
  1. codex 审核 `SOUND`(无确认的真缺陷);
  2. 测试全部通过;
  3. Claude Code 对照该任务的验收标准逐条通过。
- **防死循环**:同一任务连续 **3 轮**仍不过 → Claude Code **升级**:亲自定位根因、必要时换 agent 重做、或把卡点回报用户。**不要无限刷。**
- **每轮留痕**:本轮「确认的问题 → 下发的指令 → 这一版结果」要可追溯(便于判断是否在收敛)。

## 5. 派发与会话管理(agent-bridge)

- **首选** `agent_bridge_*` MCP 工具:`open_session` / `send_message` / `result` / `status` / `abort` / `close_session`;或用 CLI facade。
- **一个角色一个会话**;同一任务的追问/修改**复用同一 `session_id`**;换任务、换角色或换模型就**新开会话**。
- **并发纪律**:不要让两个 write 开发 agent **同时改重叠文件**。Claude Code 要么**串行**派任务,要么**按不重叠的文件**切分并行。
- **写权限**:开发 agent `write:true`(要改文件);codex 审查 `write:false`,只有**跑测试需要执行命令**时才开可执行会话。
- **git 由 Claude Code 控制**:开发 agent 只改文件、**不提交**;Claude Code 在任务验收通过后统一提交(信息清晰、一任务一笔)。
- **收尾**:每个会话用完 `close`;全流程结束确认无残留——`agent-bridge sessions --json` 为空,且无泄漏后端进程。

## 6. Prompt 模板(可直接套用)

**① 开发任务(发给 deepseek / minimax)**

```
你在 <repo 绝对路径> 工作,write 模式,可直接改文件。
任务:<一句话目标>
背景/约束:<相关上下文、依赖、不要动的部分>
涉及文件:<文件列表,或“你自行决定,但只动必要的”>
具体要求:
- <行为 1>
- <行为 2>
验收标准(必须全部满足):
- <可测标准 1>
- <可测标准 2>
完成后:列出改了哪些文件、关键改动、如何自测、剩余风险。不要改无关代码。
```

**② 审核 + 测试(发给 codex)**

```
只读审查 + 测试。仓库 <repo>,本次改动:<文件/范围,或 git diff 的范围>。
1) 审查这些改动,找 REAL 缺陷(正确性/边界/资源泄漏/未处理错误/竞态)。每条给:文件:行 + 严重度(high/med/low) + 具体失败场景 + 修复建议。
2) 跑测试:<命令>(若没有测试,指出缺哪些、建议补什么)。报告通过/失败 + 失败输出。
跳过误报,别无中生有;新写法若本就正确,不要硬挑。结尾给一行裁决:SOUND 或 HAS-DEFECTS。
```

**③ 修改指令(发回对应开发 agent)**

```
上一版需要修复。已确认的问题(来自审核/测试):
- <文件:行> <问题> —— <为什么是问题 / 复现>
要求:
- <期望行为 / 具体改法>
只改这些,别动无关部分。修完说明改了什么、怎么验证。
```

## 7. Claude Code 的纪律

- **先 plan 后派**:任何派发之前,先有一份覆盖全部开发/测试的**具体、可执行**的 plan;plan 没落地,不调用任何 agent。
- **不下场写功能代码**(除非 §4 兜底升级);专注拆分、判定、协调、验收。
- **验收标准必须可测、客观**——能用一条命令/一段输出判定的,不要主观"看着差不多"。
- **对用户透明**:每个任务的状态、当前第几轮、codex 裁决、最终验收结果都要报。
- **小步收敛**:任务拆小,改动可审、可测、可回滚;一任务一提交。

## 8. 套到 Synod MVP1 上(示例)

以 `docs/PROTOTYPE.md` 的 MVP1(自包含流式 CLI)为例,Claude Code 大致会:

1. 拆成几个小任务:① 从 agent-bridge fork `src/backend.mjs`——搬两个会话类 + 工具、解耦成 `EventEmitter`、删掉 daemon/MCP/SSE/PID(复杂→deepseek)② CLI 入口:`doctor` 体检 + 开一个 omp 会话 + 订阅 `'delta'` 逐字打印 + 退出 `close`(简单→minimax)③ 多会话并行分区 + REPL + `Ctrl-C` 清理(复杂→deepseek)。
2. 各自派发(write 模式),收开发结果。
3. codex 审 + 跑(A1:逐字流出、退出**无残留 omp 子进程**)。
4. 有问题 → Claude Code 确认 → 下发修改 → 复测;直到验收过。
5. Claude Code 提交,MVP1 收工。

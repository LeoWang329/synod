# 确定要做的东西

> 这里记录我们讨论后**确定要做**的事项。你说"记录 …",我就把对应内容追加进来。
> 创建于 2026-06-07。

## 进行中索引

> **1–3 已完成并合入 `main`**(flow 引擎 F0–F7 + relay + 标记驱动编排 B1–B4;见 [`HANDOFF.md`](HANDOFF.md))。
> **4–5 已全部完成并合入 `main`**(2026-06-09,merge `1155d21`):A0–A7 + Phase E,Tier1 534 + 真 agent acceptance 57 全绿;TDD 计划见 [`MESH_ORCHESTRATION_TDD.md`](MESH_ORCHESTRATION_TDD.md)。
> **item 6 聊天室已移除**(2026-06-09 决定暂不做;原设计草案见本文件 git 历史)。

## 已完成

- ✅ **工作流引擎(用原生 JS 编排固定工作流)**(2026-06-09 合入 main)—— 设计 [`WORKFLOW_ENGINE.md`](WORKFLOW_ENGINE.md);写法规则+模板 [`FLOW_AUTHORING.md`](FLOW_AUTHORING.md);**TDD 开发计划 [`WORKFLOW_ENGINE_TDD.md`](WORKFLOW_ENGINE_TDD.md)**。
  - **Synod=底座(执行+原语+日志+清理),flow `.mjs`=控制核心**。把 agent 按 串行/并行/循环/回退 串成"经过审核打磨的固定工作流";节点含 模型调用 / bash / 人工审批 / **人在环修订(方案A:自然语言定位)**;flow 可嵌套拉起其他 flow。
  - **发现/命名**:flow 放固定目录 `workflows/`,Synod 扫描;**名字=文件名(去扩展名)**;`meta.description` 被提取到列表;扫描时按 FLOW_AUTHORING 规则校验、拒绝乱写。
  - 控制流用原生 JS,不发 DSL;复用后端 `session.send(wait:true)`。关键约束:run log(day-one JSONL)、`ctx` 纯数据可序列化、会话默认一次性、**回退=喂回反馈让 agent 定向修正(整段回滚已否决),用 `defer` 清附带副作用**。
  - 本期**不做**持久化/恢复(留门)、不做 agent 自主编排(下面两条)。分阶段计划 M0–M4 见文档。

> 下面两条的 TDD 开发计划见 **[`AGENT_ORCHESTRATION_TDD.md`](AGENT_ORCHESTRATION_TDD.md)**(relay + 标记驱动)。

- ✅ **agent 间自动转发 / 编排(relay)**(2026-06-09 合入 main)—— 让一个会话的输出能自动流给另一个会话(而非只靠人手动 `@label` 转)。已落地 `/relay A->B` / `/unrelay` / `/relays`,按完整 turn 转发、防环防回声、关会话自动解绑。当前 MVP1 是"人在中间路由",会话之间隔离、互不可见。

- ✅ **agent 受控拉起 / 管理另一个 Synod 会话(标记驱动 B1–B4)**(2026-06-09 合入 main)—— 让一个 agent(如 codex)能让 Synod 新开/管理另一个会话(如 omp),并能拿到结果。已落地 control-marker/dispatch/wire(nonce + JSON 命令);**注意:item 5 的根治方案将把这套 nonce+JSON 协议改写为 ` ```synod ``` ` 围栏 + REPL 命令,见 [`MESH_ORCHESTRATION_TDD.md`](MESH_ORCHESTRATION_TDD.md)。**
  - **已有可复用**:`session` 已 `emit("event", …)` 抛出完整结构化事件(`backend.mjs:431`),但 cli 只听了 `delta`/`status`/`error`,这条干净旁路可拿来识别指令;开会话/发消息的动作原语(backend openSession、`sessions` Map、`sendQueue.enqueue`、`/open` 解析)都现成。
  - **要新建**:① agent→Synod 的指令约定(在输出里放一个严格唯一的标记,如 ` ```synod {"cmd":"open",...}``` `,cli 扫它);② 分发器(解析标记 → 调已有 `/open` / `enqueue`);③ 输出去向(回给人 还是 喂回发起的 agent——与上一条"编排"相关);④ 护栏(最大会话数、递归/深度上限、agent/model 白名单、尊重默认只读)。
  - **限制**:走"解析 agent 输出里的标记"(略脆,需在 prompt 里告知 agent 语法),**不走结构化 tool-call / MCP**——`--tools` 只是 omp 内置工具白名单,非宿主注入自定义工具的口子。**(已确认:不需要 Synod 引入 MCP。)**

## item 4/5(✅ 2026-06-09 完成,合入 main `1155d21`;TDD 计划见 [`MESH_ORCHESTRATION_TDD.md`](MESH_ORCHESTRATION_TDD.md))

> 下面两条(注入 + nonce 根治)的原始设计记录,**均已落地**:控制总线根治为 ` ```synod ``` ` 围栏 + REPL 命令;omp `--append-system-prompt` / codex `developerInstructions` 注入,默认关、逐字节零影响。**关键洞察**:mesh 注入真 agent 下极有效——codex 在 developer 层内化协议、主动拒吐被禁命令,连强引导都压不过,故护栏拒绝路径只能 Tier1 `agent-fence.test` 测、e2e 改验"端到端无被禁副作用"。

- **在 spawn 时把"编排技能"注入每个 agent(平级 mesh 的前提)** —— 让每个被 Synod 拉起的 agent 自带"怎么用总线"的指令(控制标记协议 + nonce),使每个 peer 都能发起对同级会话的 `open`/`send`;**且不预装进 agent 全局配置,单独使用零影响**。(2026-06-09 确定;为上一条"受控拉起"子项①提供具体落地机制。)
  - **注入字段(已核实 omp v15.10.7 / codex app-server 协议 schema)**:
    - **omp** —— 启动 flag **`--append-system-prompt=<文本或文件>`**(**追加**到系统提示,保留默认 coding 行为;`--system-prompt` 会整段替换,不用)。注入点:`backend.mjs:413` 的 `args` 数组(`OmpSession.start()`)。
    - **codex** —— `thread/start` 的 **`developerInstructions`** 字段(developer 层**叠加**;**别用 `baseInstructions`**,它会整段替换 codex 默认 agent 指令)。注入点:`backend.mjs:925`(`CodexSession.start()`)。
  - **隔离天然成立(满足"不污染单独使用")**:两者都只在 Synod 的 spawn 那一刻附加——omp flag 只存在于子进程 argv,codex 字段只进 Synod 发出的那条 `thread/start`。不经 Synod 直接跑 `omp`/`codex` 时二者都不存在 → 标准行为不受影响。**根因:不写进 `~/.omp` / `~/.codex` 全局配置。**
  - **现状坑**:`backend.mjs:413` 已带 `--no-rules --no-extensions`(但**没带** `--no-skills`)。走上面"注入字段"路线可绕开它;若改走原生 skill 机制,需重新评估这几个 flag 是否冲突。
  - **进阶(可选,用各后端原生 skill、渐进披露而非常驻系统提示)**:omp `--skills=<glob>` + 受控 skill 目录;codex 协议方法 `skills/extraRoots/set`(`SkillsExtraRootsSetParams`,传 `extraRoots:[<绝对路径>]`,**运行时**临时加 skill 根、只作用于该 app-server 实例)。代价:两端机制不对称、接入更复杂。
  - **安全权衡(必须认)**:skill 文本要带 nonce → 等于**每个 peer 都知道 nonce**,削弱了 nonce 对"不可信内容注入"的防护(退化成"信任 agent 不被骗")。可信 mesh 可接受;否则考虑把动作通道从 control-marker(文本嗅探)换成"给每个 peer 一条结构化连接"。参见 [`control-wire.mjs`](../src/control-wire.mjs) 注释中"per-session nonce rotation 是未来工作"。
  - **落地建议**:**默认关**,用 flag/env 显式开启编排模式才注入;加测试证明"未开编排时两个后端的启动参数 / `thread/start` 请求完全不变"。

- **nonce 的干净处理(现状是 per-run 共享密钥,偏粗)** —— 现状:整个进程**一个** nonce,经 env 继承给所有子进程(`control-wire.mjs` 注释已标"per-session nonce rotation 是未来工作")。叠加上一条"把编排技能注入每个 agent"后问题放大:**一旦 nonce 进了每个 peer 的上下文,等于每个 peer(以及能注入它的不可信内容)都掌握了密钥**,nonce 对"注入"的防护就退化成"信任 agent 不被骗"。(2026-06-09 记录。)
  - **止血(小改)**:**每会话独立 nonce** —— spawn 每个 agent 时各发一个新 nonce、只注入给它本人;解析侧按"发起会话的 label"校验它对应的 nonce。把"一把钥匙开全屋"缩成"一人一把",限制爆炸半径。
  - **根治(已定方案,2026-06-09)**:**去掉 nonce / 授权**,改为**统一的 ` ```synod ``` ` 输出约定 + 复用 REPL 命令语法**,所有 agent 一视同仁(都只吐文本,无 per-backend 协议)。
    - **格式**:agent 在输出里放一个 ` ```synod ``` ` 围栏,**内容直接是 REPL 命令**(`/open --agent omp`、`@codex#1 ...`、`/relay a->b` 等);synod 在**一轮结束后**解析该围栏,把命令喂给**现成的 REPL dispatch** 执行。**不发明 JSON schema——编排词汇 = 用户已熟的 REPL 命令。**
    - **去掉**:`SYNOD_CONTROL_NONCE`、nonce 握手、解析侧 nonce 校验(`control-wire.mjs` / `control-marker.mjs` / `control-dispatch.mjs` 相关逻辑)。**根因消除**:不再需要"把密钥既给 agent 用、又对它保密",前面"注入技能/系统提示"那条的 nonce 顾虑随之消失。
    - **必须保留(与 nonce 无关的另一类安全)**:**护栏照旧** —— 默认只读(`/open --write` 从围栏发要被拒)、最大会话数、**最大递归深度**(防一个 agent fork-bomb 出无限会话)、agent/model 白名单。这些防的是"**失控**"不是"授权",删 nonce **不能**连它们一起删。
    - **围栏内命令白名单**:只放编排相关(`/open`、`@label`/`@all`、`/relay`/`/unrelay`);排除会影响人类会话状态的(`/use`、`/exit`、`/quit`)。
    - **已接受的残留风险**:无授权 → agent 引用语法可能**误触发**;靠"围栏标记足够独特 + 护栏限制爆炸半径"兜底(**可信环境模型**:链路内无外部不可信内容)。
    - **波及**:现有 control-* 测试假设 nonce + JSON 命令,需重写为"围栏内 REPL 命令 + 护栏仍生效"。
    - **流程**:实质改动,按"先出方案 → deepseek+codex review → 实现 → e2e → 交叉验证"推进。

## per-session mesh 粒度(✅ 2026-06-10 完成)

- ✅ **`/open --mesh` / `--no-mesh` per-session 覆盖** —— 让单个会话(human 或 agent-fence)覆盖继承的 mesh 默认。透传链原已通(`sm.open` 内 `mesh ?? _defaults.mesh`);本次补:① `parseOpenArgs` 三态解析 `--mesh`/`--no-mesh`(`undefined` 继承 / `true` / `false`,互斥报错、同 flag 幂等);② human 与 agent-fence 两处 `/open` 各透传 `mesh`。
  - **评审驱动的连带修整**(codex + deepseek-v4-pro **三轮**交叉评审,最终均判 closeable):
    - **顶层 `--no-mesh` + `??` 优先级**:`parseArgs` 默认 `false→undefined`、`main()` `||→??`,优先级 = 显式 flag > `SYNOD_MESH` env > off。**根治**"设了 `SYNOD_MESH=1` 就无法在非交互(`--task`)下关 mesh"的真实缺口。
    - **MESH_INSTRUCTIONS 同时文档化两个 flag**:`_defaults.mesh` 是单一全局、非 per-session——mesh-off 跑时人工 `/open --mesh` 抬起的编排者,其子代仍继承 false,要建子网**必须显式 `--mesh`**(codex 反例,推翻了我"只暴露 `--no-mesh`"的初判);措辞按评审改为"不会**被提示**去编排"(mesh 只控注入,非能力闸)。
    - **CLI/REPL 互斥一致**:`parseArgs` 镜像 `parseOpenArgs` 的 `--mesh/--no-mesh` 互斥(原顶层是静默 last-wins)。
  - **不给 agent-fence mesh 加 guard(第一性,评审认可)**:mesh 非能力闸——fence wire(host 侧 `wireControl`)与 mesh 无关恒开,真实风险(fork-bomb / 写)由 `maxDepth`+`maxSessions`+`allowWrite` 兜住,mesh 绕不过;拦它是表演非防御。
  - **测试**:单测 **560/560**(+26 覆盖三态解析/两向互斥/幂等/双路径透传/per-call 压默认/顶层优先级含 `--no-mesh` 压 `SYNOD_MESH=1`/指令指纹);e2e **E1–E4 mesh 全绿**。A5 因本机 **MiniMax-M3 远程 provider 掉线/401** 超时,与本改动无关(A1–A4 本地 omp 全过,A5 首个调远程才卡)。

## 留门待办(下次可选)

> mesh 编排根治 + 注入(item 4/5)+ Phase E 已完成合入 main(`1155d21`);**per-session mesh 粒度已于 2026-06-10 完成**(见上节)。本期其余**主动留门**、下次可选。
> **2026-06-10 评审**:deepseek-v4-pro + mimo-v2.5-pro 交叉评审本节(MiniMax-M3 因本机 `MINIMAX_API_KEY` 未配置 401 缺席)。原一致优先级 per-session mesh > E6 > 持久化,**per-session mesh 已落地**,剩余优先级 **🔴 fence 结果回喂 > E6 > 持久化**,另揪出 🔴(已核代码确认)。E6 评审建议**改姿势**:别等 agent 自发吐 fence(不可靠),改用**注入已知 fence** 测 relay+fence 管线。持久化评审强调**根本限制**:后端 agent 会话是持有 fd 的活进程、不可序列化,恢复只能"重 spawn + 重放",现实只能做 flow 级 checkpoint。

- **🔴 fence 执行结果回喂发起 agent(评审新增,2026-06-10;非"可选"——卡自主编排)** —— 现状:agent 在围栏里 `/open` 出一个会话后**拿不到新会话的 label**。`control-wire.mjs:68-72` 把 label 只写进内部 `_depthMap`、拒绝原因只打 stderr,**无任何路径把结果回注 agent 下一轮**。后果:agent 能建会话但不知 label → 无法 `@它` 发消息,自主编排瞎操作。**已核代码确认(deepseek 提出)。** 方案:把每条 fence 命令的执行结果(成功 label / 失败 reason)在本 turn 完成点回注发起会话的下一轮上下文(类比 relay 的 `[…]` 注入)。建议**优先于下面三条**——这是 mesh 自主编排的核心价值所在。

- **E6 围栏 + relay 协同 e2e** —— 验证 agent 在 ` ```synod ``` ` 围栏里吐 `/relay a->b`,在本 turn 完成点建链、下一 turn 起生效(沿用现有 relay 时序)。本期 Phase E 标 deferred(真 agent 下可靠构造较难);接线逻辑已由 Tier1 [`control-wire.test.mjs`](../test/control-wire.test.mjs) 覆盖。
- **持久化 / 恢复** —— flow 引擎的 `ctx` 已设计为纯数据可序列化(留门);整套会话 / flow 的持久化与崩溃恢复尚未做。

# 确定要做的东西

> 这里记录我们讨论后**确定要做**的事项。你说"记录 …",我就把对应内容追加进来。
> 创建于 2026-06-07。

## 待办

- **工作流引擎(用原生 JS 编排固定工作流)** —— 设计 [`WORKFLOW_ENGINE.md`](WORKFLOW_ENGINE.md);写法规则+模板 [`FLOW_AUTHORING.md`](FLOW_AUTHORING.md);**TDD 开发计划 [`WORKFLOW_ENGINE_TDD.md`](WORKFLOW_ENGINE_TDD.md)**。
  - **Synod=底座(执行+原语+日志+清理),flow `.mjs`=控制核心**。把 agent 按 串行/并行/循环/回退 串成"经过审核打磨的固定工作流";节点含 模型调用 / bash / 人工审批 / **人在环修订(方案A:自然语言定位)**;flow 可嵌套拉起其他 flow。
  - **发现/命名**:flow 放固定目录 `workflows/`,Synod 扫描;**名字=文件名(去扩展名)**;`meta.description` 被提取到列表;扫描时按 FLOW_AUTHORING 规则校验、拒绝乱写。
  - 控制流用原生 JS,不发 DSL;复用后端 `session.send(wait:true)`。关键约束:run log(day-one JSONL)、`ctx` 纯数据可序列化、会话默认一次性、**回退=喂回反馈让 agent 定向修正(整段回滚已否决),用 `defer` 清附带副作用**。
  - 本期**不做**持久化/恢复(留门)、不做 agent 自主编排(下面两条)。分阶段计划 M0–M4 见文档。

> 下面两条的 TDD 开发计划见 **[`AGENT_ORCHESTRATION_TDD.md`](AGENT_ORCHESTRATION_TDD.md)**(relay + 标记驱动)。

- **agent 间自动转发 / 编排**:让一个会话的输出能自动流给另一个会话(而非只靠人手动 `@label` 转)。例如把某会话的 delta 转发进另一个会话的 sendQueue,或加 `/relay A->B` 之类指令。当前 MVP1 是"人在中间路由",会话之间隔离、互不可见。

- **agent 受控拉起 / 管理另一个 Synod 会话**:让一个 agent(如 codex)能让 Synod 新开/管理另一个会话(如 omp),并能拿到结果。当前不可行——agent 接口只有"收文本 / 吐文本",没有面向 agent 的控制口子。
  - **已有可复用**:`session` 已 `emit("event", …)` 抛出完整结构化事件(`backend.mjs:431`),但 cli 只听了 `delta`/`status`/`error`,这条干净旁路可拿来识别指令;开会话/发消息的动作原语(backend openSession、`sessions` Map、`sendQueue.enqueue`、`/open` 解析)都现成。
  - **要新建**:① agent→Synod 的指令约定(在输出里放一个严格唯一的标记,如 ` ```synod {"cmd":"open",...}``` `,cli 扫它);② 分发器(解析标记 → 调已有 `/open` / `enqueue`);③ 输出去向(回给人 还是 喂回发起的 agent——与上一条"编排"相关);④ 护栏(最大会话数、递归/深度上限、agent/model 白名单、尊重默认只读)。
  - **限制**:走"解析 agent 输出里的标记"(略脆,需在 prompt 里告知 agent 语法),**不走结构化 tool-call / MCP**——`--tools` 只是 omp 内置工具白名单,非宿主注入自定义工具的口子。**(已确认:不需要 Synod 引入 MCP。)**

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

- **agent 聊天室(多 agent 共处一室、共享记忆)—— flow 方案** —— 让多个 agent 在一个共享对话空间里轮流发言、互相看得见,而非只靠人手动 `@`。(2026-06-09 记录,方案 = flow 引擎编排。)
  - **硬约束**:omp/codex 是各自独立进程,模型上下文在进程内,**无法真·共享模型记忆**。"共享记忆"只能**外置 + 投影**(放 agent 之外,再喂进各自上下文)。
  - **核心机制(flow 当总线)**:flow 持有一块**权威共享记忆**(flow 的 JS 状态 / cwd 里一个文件),循环:**读黑板 → 选发言者 → 把相关切片投影进其 prompt → 收发言 → 更新黑板**,直到终止条件。**不用 relay 拼网状**——relay 是成对的、且会触发防环 guard,N 方会退化成"人人复制人人",贵且乱。
  - **单一写者**:共享记忆**只由编排者写**(每轮追加发言者输出),agent **全程只读**——既符合默认只读(`--write` 才放开),又根除并发写冲突。
  - **共享记忆形态(按 token / 结构化程度)**:① 全文转录(短对话,最贵);② **窗口 + 滚动摘要**(中长对话,可控);③ **结构化黑板**(只存 决策 / 已达成 / 分歧 / 待办,有目标协作时最省)。长对话别用全文转录。
  - **两层记忆**:共享房间记忆(上面) vs 各 agent **私有会话记忆**——用 `reuse:true` 让每个 agent 记得自己说过啥,共享记忆只补别人的,投影更省。
  - **秩序(聊天室的真难点,不在管道)**:必须显式定 **发言权仲裁**(固定轮询 / 被 `@` 到才说 / 一个主持 agent 点名)与**终止条件**(轮数上限 / 达成共识 / 人喊停),否则回声爆炸、同时开口、不收敛。
  - **复用 synod 现成件**:所有 agent **同一 cwd** + 有文件工具(cwd 里的文件即共享记忆,只读即可)、flow `ctx` / run log、`agent(reuse)`、turn 完成事件。
  - **MVP 草案**:`workflows/chatroom.mjs` —— 先用 窗口+滚动摘要、固定轮询、人可喊停;跑通形态后再加 主持/黑板。
  - **成本提醒**:token ≈ 对话长度 × agent 数;靠摘要/黑板压。
  - **验收判据**:无论走哪条,目标都是——"**被不可信内容注入的 agent,仅凭其上下文里的信息无法伪造出合法的控制指令**"。

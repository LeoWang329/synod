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

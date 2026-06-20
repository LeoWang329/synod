# Synod

Synod 是一个**自包含的多 agent 协作 CLI**:它**内置**一个从 [agent-bridge](https://github.com/LeoWang329/agent-bridge) fork 出来的后端协议层,直接在自己进程内拉起本地 coding agent(`omp` / `codex`),把任务分给它们、**实时逐字**呈现输出、并汇总结果。

- **无外部常驻服务**:不依赖 agent-bridge 的 daemon / MCP / HTTP——那些只在「多客户端共享会话」时才需要,Synod 作为单进程 REPL 用不上。
- agent-bridge 现在只是 Synod 内置后端(`src/backend.mjs`)的 **fork 来源**,**运行时不需要它**。

## 状态

**MVP1 已落地**:自包含的流式 CLI——单/多会话、实时逐字流式、多路输出带标签不串台、`Ctrl-C` 优雅清理、`--task` 非交互入口。需求见 [`docs/PROTOTYPE.md`](docs/PROTOTYPE.md);验收 A1–A5 全过(见下方「测试」)。

## 如何运行

```bash
node src/cli.mjs                                          # 默认开一个 omp 会话,进入 REPL
node src/cli.mjs --agent codex --model <M> --effort <E>   # 指定后端/模型/强度
node src/cli.mjs --task omp:"任务甲" --task codex:"任务乙"   # 非交互:多会话并行,全部跑完即退出
```

### 直接敲 `synod` 启动(全局命令)

`package.json` 里已声明 `bin: { "synod": "src/cli.mjs" }`。在仓库根目录跑一次:

```bash
npm run link    # = npm link;把 synod 软链到全局 PATH
```

之后在**任意目录**直接 `synod`(或 `synod --no-tui` / `synod --help`)即可启动。软链直接指向本仓库,改源码即时生效、无需重链——**只有当仓库目录被移动或改名时**才需要再跑一次 `npm run link`。

进入 REPL 后:

- 普通一行 → 发给**当前会话**;`@<label> <消息>` → 定向某会话;`@all <消息>` → 广播。
- `/open [--agent A] [--model M] [--effort E] [--write] [--mesh|--no-mesh]` 新开会话、`/use <label>` 切当前、`/sessions` 列出会话。
- `/flow [<name> [input]]` 在 REPL 内跑一个工作流(省略名字=列出可用 flow);flow 自带开/关会话、结果以 JSON 打印,退出时会等在跑的 flow 收尾。
- `/exit` 或 `Ctrl-D` 退出并 `close` 全部;`Ctrl-C` 中断当前轮、清理后退出(任何路径不残留子进程)。

Synod **启动即用**:内置后端直接 spawn omp/codex,**不连接任何 MCP、不需要 `.mcp.json`、也不需要 agent-bridge 在跑**。模型串需 **provider 限定**(如 `minimax-code-cn/MiniMax-M3`、`deepseek/deepseek-v4-pro`)。完整交互模型见 [`docs/PROTOTYPE.md`](docs/PROTOTYPE.md) §4.1。

## 测试

```bash
npm test          # 契约/单元测试(= node --test;零依赖,无需真实 agent,CI 可跑)
npm run test:e2e  # 集成验收 A1–A5(= node scripts/acceptance.mjs;需本机 omp/codex)
```

- `npm test` 跑 `test/*.test.mjs`:参数解析、多路 delta 行缓冲不串台、backend 契约(用注入的 fake 子进程,不连真实 agent)。
- `npm run test:e2e` 跑 `scripts/acceptance.mjs`:真实 omp/codex 逐条验收 A1–A5(实时流式、并行不串台、`Ctrl-C` 干净退出且无残留、缺 agent 非零退出、`--model`/`--effort` 透传);本机缺 omp/codex 时**自动跳过**(不算失败)。

## 文档

- [`docs/PROTOTYPE.md`](docs/PROTOTYPE.md) —— MVP1 需求 + 内置后端架构(本版核心)。
- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) —— 用「Claude Code 编排 + agent-bridge 派活」的多 agent 模式来**建** Synod 本身。

## 依赖

- Node.js 20+。**核心零第三方运行时包**——只用 `node:*` 内置(`node:test` 跑测试、ANSI 手写、进程清理走原生 `taskkill`/`ps`,不引 jest/chalk/commander)。注意这是**核心层的实现选择,非全局铁律**,且与「synod 自包含、不复用 agent-bridge 组件」是两回事:面向产品的上层按需引包——例如即将开发的**全屏 TUI 前端将用 [Ink](https://github.com/vadimdemedes/ink)**(Ink 覆盖不到处,如鼠标,再手写 ANSI 补)。
- 本机的 **`omp` 和/或 `codex` CLI**(真正干活的 agent;backend 直接 spawn 它们)。
- **跨平台**:macOS / Linux / Windows;进程清理按平台分支(POSIX `pgrep`/`ps`,Windows `taskkill`)。

> 注意区分两件事:**构建** Synod 的开发流程(WORKFLOW.md)会用到 agent-bridge 派活;但 **Synod 跑起来本身不依赖 agent-bridge**。

## 怎么开发

Synod 自身用一套**多 agent 协作模式**来建:Claude Code 负责拆分 / 规划 / 验收 / 协调,经 agent-bridge 把活派给 deepseek-v4-pro(复杂)、minimax-m3(简单)开发,codex 审核 + 测试,闭环修复到无问题为止。详见 [`docs/WORKFLOW.md`](docs/WORKFLOW.md)。

> agent-bridge 已作为 Claude Code 插件安装,任意会话自带其 MCP 工具(`agent_bridge_*`),无需项目级 `.mcp.json`。

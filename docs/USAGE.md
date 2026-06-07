# Synod 使用手册

> 自包含的多 agent 协作流式 CLI。本手册覆盖启动、交互、查看会话、输出行为等日常用法。
> 写于 2026-06-07。命令以 `src/cli.mjs` 实际实现为准。

## 1. 这是什么

Synod 在自己进程里直接拉起本机的 coding agent(`omp` / `codex`),把任务分给它们、**实时逐字**显示输出、并行跑还不串台。

- **零第三方依赖**,不连 MCP、不需要 `.mcp.json`、不需要 agent-bridge 在跑。
- 真正干活的是本机的 agent CLI;Synod 只负责拉起、路由、流式呈现、汇总。

## 2. 运行前提

- **Node.js 20+**。
- 本机装了 **`omp` 和/或 `codex` CLI**(`AGENTS = ["omp", "codex"]`,目前只支持这两个)。

## 3. 启动

```bash
cd /Users/leo/projects/synod

node src/cli.mjs                 # 默认开一个 omp 会话,进入交互 REPL
npm start                        # 等价于上一行

# 指定后端 / 模型 / 强度(模型串要带 provider 前缀)
node src/cli.mjs --agent codex --model minimax-code-cn/MiniMax-M3 --effort high

# 非交互:多会话并行,跑完即退(适合脚本)
node src/cli.mjs --task omp:"任务甲" --task codex:"任务乙"

node src/cli.mjs --help          # 查看全部参数
```

### 启动参数

| 参数 | 说明 |
|---|---|
| `--agent <omp\|codex>` | 后端,默认 `omp` |
| `--model <M>` | 模型 id,**要带 provider 前缀**,如 `minimax-code-cn/MiniMax-M3`、`deepseek/deepseek-v4-pro` |
| `--effort <E>` | 思考强度(omp),如 `high` / `xhigh` |
| `--write` | 允许 agent **写文件**;**默认只读** |
| `--task <agent>:<msg>` | 非交互跑一条任务,**可重复**;全部跑完即退出 |
| `-h, --help` | 帮助 |

## 4. REPL 交互

进入 REPL 后,有三种发消息的方式:

| 输入 | 发给谁 |
|---|---|
| 直接打一行字 | **当前**会话(`/use` 选中的那个) |
| `@<label> 消息` | **指定**的某个已开会话 |
| `@all 消息` | **所有**已开会话(广播) |

> `@<label>` 只做**路由**:消息发给一个**已经存在**的会话,找不到会报 `No session "<label>"`,**不会**帮你新建(新建用 `/open`)。

### REPL 命令

| 命令 | 作用 |
|---|---|
| `/open [--agent A] [--model M] [--effort E] [--write]` | 新开一个会话 |
| `/use <label>` | 切换当前会话 |
| `/sessions` | 列出所有会话 |
| `@<label> <msg>` / `@all <msg>` | 定向 / 广播 |
| `/exit`, `/quit`, `Ctrl-D` | 关闭全部会话并退出 |
| `Ctrl-C` | 中断当前轮,清理后退出(不残留子进程) |

## 5. 查看当前有哪些 agent

分两层:

- **看正在跑的会话** → REPL 里输入 `/sessions`。每行格式:

  ```
   * omp     omp     default                  ready
     c1      codex   minimax-code-cn/...      running
  ```

  含义:开头 `*` = 当前会话;然后依次是 **label**(`@` 要用的名字)、**agent**、**model**(没指定显示 `default`)、**status**。

- **看支持哪些 agent 类型** → `node src/cli.mjs --help`,目前只有 `omp` 和 `codex`。

> label 哪来:默认会话的 label 一般是 agent 名;`/open` 时会打印 `Opening <label> (<agent>)...`;记不清就 `/sessions`。

## 6. 输出行为:思考过程不显示

REPL 里看到的 `[label] ...` 流式内容,只有 agent 的**可见正文**(`text` / `content` / `delta`)。**思考 / reasoning 不会输出** —— 后端 `extractAssistantText` 把任何字段名带 `thinking` 的内容直接跳过(`src/backend.mjs`)。

注意 `--effort` 控制的是**思考多用力**,不是"把思考显示出来";力度变大,但思考过程本身仍不展示。

## 7. 测试

```bash
npm test          # 契约/单元测试,零依赖、不连真 agent,CI 可跑
npm run test:e2e  # 真实 omp/codex 跑验收 A1–A5;本机没装就自动跳过
```

## 8. 延伸文档

- [`docs/PROTOTYPE.md`](PROTOTYPE.md) —— MVP1 需求 + 内置后端架构。
- [`docs/WORKFLOW.md`](WORKFLOW.md) —— 用多 agent 协作模式开发 Synod 本身。
- [`docs/TODO.md`](TODO.md) —— 我们确定要做的事项。

# Synod 使用手册

> 自包含的多 agent 协作流式 CLI。本手册覆盖:**多会话 REPL**、**agent 间转发(relay)**、**agent 受控拉起子会话(编排标记)**、以及**用原生 JS 写固定工作流的 flow 引擎**。
> 写于 2026-06-07,**最后更新 2026-06-07(补 relay / 编排 / flow 引擎)**。命令以 `src/cli.mjs` 与 `src/flow.mjs` 实际实现为准。

## 1. 这是什么

Synod 在自己进程里直接拉起本机的 coding agent(`omp` / `codex`),把任务分给它们、**实时逐字**显示输出、并行跑还不串台。三件事:

1. **多会话 REPL**:同时开多个 agent 会话,定向 / 广播发消息,流式看输出。
2. **编排**:让一个 agent 的产出自动**转发**给另一个(relay),或让 agent 在输出里放**控制标记**来受控拉起 / 管理子会话。
3. **flow 引擎**:把固定工作流写成一个 `.mjs` 文件(用 `agent()`/`bash()`/`approve()`/`agentLoop()`/`reviseWithHuman()`/`runWorkflow()` 等原语),用 `node src/flow.mjs <name>` 跑。

- **零第三方依赖**,不连 MCP、不需要 `.mcp.json`、不需要 agent-bridge 在跑。
- 真正干活的是本机的 agent CLI;Synod 只负责拉起、路由、流式呈现、汇总、按工作流编排。

## 2. 运行前提

- **Node.js 20+**。
- 本机装了 **`omp` 和/或 `codex` CLI**(`AGENTS = ["omp", "codex"]`,目前只支持这两个)。

## 3. 启动 REPL

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
| `/relay <from>-><to>` | 加一条转发规则(见 §6) |
| `/unrelay <from>-><to>` | 删一条转发规则 |
| `/relays` | 列出当前转发规则 |
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

## 6. agent 间转发(relay)

让 A 会话**每跑完一轮**就把那一轮的**完整输出**作为新消息**自动转发**给 B 会话——适合"omp 出方案 → codex 审"这种流水。

```
> /open --agent codex        # 先把两个会话都开出来
> /relay omp->codex          # omp 每轮产出 → 自动喂给 codex
> 给我写个快排                # 发给 omp;它跑完,codex 自动收到并接着审
> /relays                    # 看当前有哪些转发规则
> /unrelay omp->codex        # 不要了就删掉
```

要点(都已在实现里保证):
- **按完整 turn 转发**,不是逐字转发(避免两个 agent 输出交织成乱码)。
- **方向性**:`omp->codex` 不会让 codex 的输出回流给 omp;要双向得再建 `codex->omp`。
- **防环**:会拒绝产生环的规则(已有 `omp->codex` 时再建 `codex->omp` 会被拦);转发的消息带 `[relay from <label>]` 来源标注。
- 关掉某个会话时,涉及它的转发规则自动解绑。

## 7. agent 受控拉起子会话(编排标记)— 进阶

让一个 agent 在输出里放一段**带授权 nonce 的控制围栏**,Synod 在它**一轮结束**后解析并**受控**地替它开 / 管理子会话。语法:

````
```synod <本轮 nonce>
{"cmd":"open","agent":"omp","task":"写一个 hello"}
```
````

- **nonce 握手**:只有携带"本轮被授权的 nonce"的围栏才算数——避免 agent 在解释/引用语法时**误触发**。nonce 默认随机生成;要让 agent 知道它,用环境变量注入:`SYNOD_CONTROL_NONCE=<nonce> node src/cli.mjs`,并在给 agent 的提示里带上同一 nonce。
- **护栏(默认值,不可被标记绕过)**:最多同时 10 个会话、嵌套深度最多 3 层、**默认只读**(标记里请求 `write` 会被拒)、agent/model 白名单。被拒会在 stderr 打 `[control warn] ...`。
- **诚实声明**:控制围栏在**实时流**里当时无法剥离——它会作为可见文本出现在输出里,Synod 只在**一轮结束后**解析并派发,不假装能 mid-stream 隐藏。
- 子会话产物默认**回给人**(走正常 `[label] ...` 输出),不自动回喂发起 agent(要回喂请显式建 relay)。
- 实测:Claude 系(omp)的安全训练会拒绝输出这类控制围栏(视为 prompt injection),codex(GPT 系)可以——这是预期行为。

> 这是实验性编排能力;写法细节与命令 schema 见 `src/control-marker.mjs` 头注释。

## 8. flow 工作流引擎

把一个**固定的、确定性的工作流**写成一个 `.mjs` 文件,用原生 JS 控制流(`await` / `if` / `while` / `Promise.all`)编排 agent;不发明 DSL、不引 MCP。

```bash
node src/flow.mjs --list                 # 列出可用 flow(名字 + 描述,纯,不需 agent)
node src/flow.mjs hello                   # 跑名为 hello 的 flow
node src/flow.mjs hello '{"topic":"排序"}' # 带输入(能 JSON.parse 就解析成对象,否则当裸串)
node src/flow.mjs --workflows ./my-flows myflow   # 指定 flow 目录(默认 ./workflows)
node src/flow.mjs --help
```

`workflows/` 下自带几个示例 flow:

| flow | 做什么 |
|---|---|
| `hello` | 线性:调 omp,返回回答 |
| `backtrack-demo` | omp 产出 → codex 审核 → 不过就带反馈重试(回退) |
| `revise-demo` | 产出 → 人给自然语言反馈 → 改 → 定稿(人在环修订) |
| `parent` / `child-echo` | 父 flow 调子 flow,演示嵌套 |

### 怎么写一个 flow(速览)

一个 flow 文件导出 `meta`(含 `description`)和 `run(ctx, input)`,只能 `import` 自 `'synod/flow'`:

```js
import { agent, bash, approve, agentLoop, backtrack, reviseWithHuman, runWorkflow } from "synod/flow";

export const meta = { description: "一句话说明这个 flow 干嘛" };

export async function run(ctx, input) {
  const draft = await agent(ctx, { agent: "omp", prompt: `写一段关于 ${input.topic} 的说明` });
  return draft;
}
```

可用原语:
- `agent(ctx, {agent, model?, prompt, reuse?})` —— 调一个 agent,返回文本。
- `bash(ctx, cmd)` —— 跑 shell,返回 `{stdout, code}`。
- `approve(ctx, {content})` —— 把产物给人审,等一行输入(accept / 反馈 / `/abort`)。
- `agentLoop(ctx, {agent, prompt, until, maxTurns})` —— 单 agent 节点内自迭代到 `until` 为真。
- `backtrack(ctx, {produce, review, buildPrompt, maxTurns})` —— 产出→审→不过把"错在哪"喂回重试。
- `reviseWithHuman(ctx, draft)` —— 产出→人反馈→改→定稿。
- `runWorkflow(ctx, './child', input)` —— 拉起子 flow 拿返回值。
- `defer` —— 注册逆序清理回调。

> 完整写法规则、硬约束、模板、自检清单见 [`docs/FLOW_AUTHORING.md`](FLOW_AUTHORING.md);设计与原理见 [`docs/WORKFLOW_ENGINE.md`](WORKFLOW_ENGINE.md)。
> 每次跑 flow 会落一份 JSONL 运行日志(`run.log.jsonl`)+ 大产物 artifact,便于复盘。

## 9. 输出行为:思考过程不显示

REPL 里看到的 `[label] ...` 流式内容,只有 agent 的**可见正文**(`text` / `content` / `delta`)。**思考 / reasoning 不会输出** —— 后端 `extractAssistantText` 把任何字段名带 `thinking` 的内容直接跳过(`src/backend.mjs`)。

注意 `--effort` 控制的是**思考多用力**,不是"把思考显示出来";力度变大,但思考过程本身仍不展示。

## 10. 测试

```bash
npm test               # 契约/单元测试,零依赖、不连真 agent,CI 可跑
npm run test:e2e       # REPL/relay/编排 验收 A1–A8 + B4;本机没装 agent 就自动跳过
npm run test:e2e-flow  # flow 引擎验收 FA1–FA5(线性/回退/修订/嵌套);没装 agent 就跳过
```

## 11. 延伸文档

- [`docs/PROTOTYPE.md`](PROTOTYPE.md) —— MVP1 需求 + 内置后端架构。
- [`docs/WORKFLOW_ENGINE.md`](WORKFLOW_ENGINE.md) —— flow 引擎设计:节点模型、原语、回退粒度、人在环修订、run log。
- [`docs/FLOW_AUTHORING.md`](FLOW_AUTHORING.md) —— 怎么写一个 flow:目录/命名、必须导出、硬规则、模板、自检清单。
- [`docs/AGENT_ORCHESTRATION_TDD.md`](AGENT_ORCHESTRATION_TDD.md) —— relay + 编排标记的设计与开发计划。
- [`docs/WORKFLOW.md`](WORKFLOW.md) —— 用多 agent 协作模式开发 Synod 本身。
- [`docs/TODO.md`](TODO.md) —— 我们确定要做的事项。

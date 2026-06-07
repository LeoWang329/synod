# Synod 工作流引擎 — 计划

> 在 Synod 上做一个**用原生 JS 编写和控制的固定工作流引擎**。每套工作流是一个 `.mjs`。
> 本文是设计 + 分阶段计划。综合了 deepseek-v4-pro / codex 的评审意见与讨论结论。
> 起草 2026-06-07。状态:**计划中(未开工)**。

## 1. 目标 / 非目标

**目标**
- 编排"经过审核打磨的**固定**工作流":不同 agent 按 串行 / 并行 / 循环 / 回退 串起来。
- 节点不只是模型调用,还包括跑 bash、人工审批、**人在环修订**。
- 一个工作流可拉起其他工作流(嵌套)。
- 控制流**用原生 JS**(串行=`await`,并行=`Promise.all`,循环=`while`,条件=`if`),不发明 DSL。
- 每次运行**可复现、可审计**(有结构化 run log)。

**非目标(本期不做)**
- 不做跨进程**持久化 / 断点恢复**(但设计上为它留门,见 §7)。
- 不做 agent 自主拉起会话 / agent 间自动编排(另见 [`TODO.md`](TODO.md) 两条)。
- 不引入 MCP、不引入 DSL、不引入第三方编排框架。

## 2. 核心模型

**节点 = `async (ctx) => output`。** 统一签名,什么都能当节点:模型调用、bash、审批、纯数据变换、子工作流。会话**不是**节点的属性,只是节点内部可选使用的资源。

**一套工作流 = 一个导出 `run(ctx, input)` + `meta` 的 `.mjs`。** 内部纯 JS 编排。

```js
// workflows/research.mjs  —— flow 名 = 文件名 "research"(不含扩展名)
import { agent, reviseWithHuman } from 'synod/flow';     // 只允许从这一个模块 import 原语
export const meta = { description: '调研并经人审定稿' };  // 不写 name:名字取自文件名
export async function run(ctx, input) {
  const draft = await agent(ctx, { agent: 'omp', model: 'deepseek/deepseek-v4-pro',
                                   prompt: `调研 ${input.topic},产出文档` });
  const final = await reviseWithHuman(ctx, draft);   // 人在环修订(§5)
  return final;
}
```

### 2.1 Flow 的发现、命名、描述(Synod 作底座,flow 是控制核心)

**职责切分**:**Synod = 底座**——提供原语(agent/bash/approve/…)、装载执行、写 run log、清理进程;**flow `.mjs` = 控制核心**——用原生 JS 决定"流程怎么走"。

- **固定目录**:所有 flow 放仓库固定位置 `workflows/`,Synod 扫描 `workflows/*.mjs` 发现它们。
- **名字 = 文件名(去扩展名)**:`workflows/research.mjs` → flow 名 `research`。`meta` **不写 name**,避免与文件名冲突。
- **描述可被提取**:每个 flow 必须 `export const meta = { description, inputs? }`;Synod 扫描时读出 `meta.description` 用于列表(`node src/flow.mjs --list` 显示"名字 + 描述")。
- **统一契约 + 防乱写**:每个 flow 必须 `export async function run(ctx, input)`,只能用 runtime 原语、只 import `synod/flow`。写法规则与模板见 **[`FLOW_AUTHORING.md`](FLOW_AUTHORING.md)**;扫描时会按该规则校验、拒绝违规 flow。

## 3. Runtime 原语(小而硬,别裸写脚本)

| 原语 | 作用 |
|---|---|
| `agent(ctx, {agent, model, effort, prompt, reuse?})` | 调一次 agent,返回文本结果。包 `session.send(wait:true)`。 |
| `agentLoop(ctx, {agent, prompt, until, maxTurns})` | 节点内 agent 多轮自迭代,直到 `until(out)` 或到 `maxTurns`。**复用会话**。 |
| `bash(ctx, cmd, {cwd?})` | 跑命令,返回 `{stdout, stderr, code}`。 |
| `approve(ctx, {title, body})` | 人工审批(阻塞 stdin),返回 `{accepted, feedback?, aborted?}`。支持取消 token(见 §5)。 |
| `reviseWithHuman(ctx, draft, {agent, model})` | **人在环修订环**(§5)。 |
| `defer(ctx, cleanup)` | 注册清理回调,回退迭代结束/失败时执行(见 §7)。 |
| `runWorkflow(ctx, './other.mjs', input)` | 拉起子工作流并拿返回值。 |

所有原语自动写 run log(§6)。

> **agent vs model**:`agent` 只能是 backend 已有的后端 ∈ `{omp, codex}`;`model` 是带 provider 前缀的模型串(如 `deepseek/deepseek-v4-pro`、`minimax-code-cn/MiniMax-M3`),透传给该后端。MVP **不做**泛模型调用器,只支持 backend 注册过的 agent。
>
> **flow 只 import `synod/flow`**:原语全从这一个模块导入;flow 导入 `fs` / `child_process` / `net` 等任何其它模块,扫描时被拒(详见 [`FLOW_AUTHORING.md`](FLOW_AUTHORING.md))。

## 4. 控制流与三种回退粒度

原生 JS 直接给:串行 `await`、并行 `Promise.all`、循环 `while/for`、条件 `if`。回退分三个粒度,**全是循环**,模型统一:

> **回退哲学:喂回"错在哪",不回滚世界。** 回退的价值是让 agent 拿到**具体哪里错了**去定向修正(把审核反馈灌进 prompt),而不是把工作区回滚到干净快照后盲目重来。整段回滚(snapshot/worktree)**不是本引擎的模型**;`defer`(§7)只负责清掉"重跑会脏掉结果"的**附带**副作用,不负责"撤销这次尝试"。

1. **节点内 · agent 自迭代** —— `agentLoop`,复用会话,`maxTurns` 兜底。
2. **节点内 · 人在环修订** —— `reviseWithHuman`(§5),人是终止者。
3. **跨节点 · 回退** —— 写死的 `while`,把要重做的一段包进去:

```js
let attempt = 0, review;
do {
  const draft  = await agent(ctx, { agent:'omp', model:'deepseek/deepseek-v4-pro',
                                     prompt: build(ctx, review) });                  // 节点2
  await bash(ctx, 'npm run build');                                                  // 节点3
  const tested = await bash(ctx, 'npm test');                                        // 节点4
  review = await agent(ctx, { agent:'codex', prompt: reviewPrompt(draft, tested) }); // 节点5
} while (!review.passed && ++attempt < 3);   // 回退节点2 = 循环体从节点2重来;attempt 防死循环
```

**无记忆重试 vs 有记忆重试(显式选择)**:上例每次新开会话 = **无记忆重试**,agent 看不到自己上轮的错,全靠 `build(ctx, review)` 把审核反馈灌进 prompt——对"X 不对改成 Y"够用。若需要 agent 理解前次尝试,给回退段的 `agent()` 传 `reuse:true`(由外层 `while` 的 `finally` 负责 close)。**默认无记忆**(隔离、可复现);有记忆是显式 opt-in。

**循环不够用、要上状态机的临界点**(本期都不做):任意 GOTO 式跳转、跨进程暂停/恢复、人工审批隔天才回、并行分支局部重试、强可视化。

## 5. 人在环修订节点(本期重点,采用「方案A」)

把"审批"从二元(通过/打回)升级成**修订对话**:工作流产出文档 → 给人看 → 人对**某一处**给自然语言反馈 → agent 改 → 再给人看 → 循环,直到人满意。

```js
async function reviseWithHuman(ctx, draft, { agent = 'omp', model = 'deepseek/deepseek-v4-pro' } = {}) {
  let doc = draft;
  const s = openReusableSession(ctx, agent, model);  // 复用会话只为连贯/省钱,非正确性依赖
  try {
    while (true) {
      const { accepted, feedback, aborted } = await approve(ctx, { title: '请审阅', body: doc });
      if (accepted) return doc;
      if (aborted)  return doc;                       // 用户主动放弃 → 返回当前稿,不杀进程
      // 每轮把"当前全文 doc + 定向反馈"显式传入:即使会话被重建也正确
      doc = await s.send(revisePrompt(doc, feedback), { wait: true });
    }
  } finally { s.close(); }
}
```

- **定位方式 = 方案A**:人用**自然语言**指"哪一处要改"("第3节太浅,把 X 展开"),agent 会话里有全文,自己定位。够用;偶尔定位偏可接受。结构化寻址(章节/锚点 = 方案B)留到以后。
- **abort 出口,不靠 SIGINT**:`approve` 把空行 / `/abort` 解析成 `{accepted:false, aborted:true}`,`reviseWithHuman` 据此 break——中途放弃是**优雅退出修订环**,不是 Ctrl-C 杀整个进程。
- **复用 = 优化而非依赖**:复用会话只为修订连贯/省 token;但**每轮都把当前全文 doc 显式传进 prompt**,所以即使会话掉了/被重建,结果仍正确。终止者是人,无需硬性 `maxTurns`。
- 每轮"人说了什么 / 改成什么"**全进 run log**。

## 6. Run Log(day-one,不可省)

JSONL,**按 step 生命周期 + 会话事件**记,不是每节点一行:

- **step 生命周期**:`{ event: 'step:started'|'step:succeeded'|'step:failed'|'step:aborted', runId, parentRunId?, stepId, node, type, attempt, ts }`,并带足以复现的字段:`prompt`、`agent`/`model`/`effort`、`cwd`、`cmd`(bash)、`stdoutRef`/`stderrRef`、`error`(栈)、`approval`(谁/反馈)。
- **会话事件**:`{ event: 'session:open'|'session:close', sessionId, agent, model, reused, ts }`——只看 log 就能判断会话是否泄漏。
- **大产物分离**:大文本(文档/命令输出)落到 artifact 文件,log 里只放 `outputRef`/`stdoutRef` 指针,不内联。

理由:工作流多节点 + 人审 + bash,失败后**没有结构化记录就无法 debug、不可复现、不可审计**。"恢复可以晚点,日志不能晚。"

## 7. 会话生命周期 / ctx 约束

- **会话:默认一次性**(隔离、不串味、可复现);**打磨型 / 修订型节点显式复用**(`agentLoop`、`reviseWithHuman`)。
- **`ctx` 保持纯数据、可序列化**:只放 `runId / cwd / 配置 / 黑板数据 / 文件路径 / logger 句柄`,**不放 live 对象**(session 实例、EventEmitter)。零成本约束,为以后持久化留门。
- **副作用不随控制流回退,且光靠"约定"会漏**:`while` 只倒带控制流,不撤销节点3/4 已写的文件 / 装的依赖 / 开的进程 / 写的缓存。所以**不只是约定,要给 runtime 机制**:
  - **`defer(ctx, cleanup)` 原语(M2 落地)**:节点把清理回调压栈,回退迭代结束 / 失败时**逆序执行**。显式化清理义务,但不引入事务。
  - **可回退段须声明副作用策略**:要么节点幂等(重跑覆盖即可),要么用 `defer` 注册清理。
  - **整段回滚(`workspace snapshot` / `temp worktree`)明确不采用**:回退要的是"让 agent 知道错在哪去改",不是把世界倒回去盲目重来;它既重、又与"喂回反馈"的模型相悖。`defer` 只清附带副作用。

## 8. 分阶段计划

- **M0 脚手架**:`src/flow/` 目录;`ctx` 工厂(纯数据);JSONL logger(step 生命周期 + 会话事件 + artifact 分离);`workflows/` 放工作流 `.mjs`;CLI 入口 `node src/flow.mjs <workflow> [input]`。
- **M1 核心 runtime + 线性 + 早暴露 stdin 风险**:`agent` / `bash` 原语;`run(ctx)` 装载与执行;run log 落地。**外加最小 `approve + abort` smoke**:单会话阻塞 stdin 打印"按回车继续",**验证它不阻塞其它会话的 delta 推送**、确认多会话时 stdin 路由清晰(把 deepseek#5 / codex#4 的风险提前到 M1 暴露)。验收:串行三节点工作流跑通 + 完整 log + smoke 通过。
- **M2 循环 + 回退 + 清理机制**:`agentLoop`;跨节点 `while` 回退范式 + `maxTurns`;**`defer(ctx, cleanup)` 原语落地**(不只是文档),回退段声明副作用策略。验收:节点5→节点2 回退示例通过,且回退时 `defer` 清理被正确执行。
- **M3 人在环修订(方案A)**:`approve`(阻塞 stdin,带 feedback + abort token)+ `reviseWithHuman`(复用会话 + 全文显式传入)。验收:产出文档→人给自然语言反馈→重写→定稿 / 或中途 abort 优雅退出,全程进 log。
- **M4 嵌套**:`runWorkflow` 拉起子工作流(带 `parentRunId`);并发上限 + 嵌套深度上限护栏。验收:父工作流跑通子工作流并拿到返回值,log 能还原父子关系。

## 9. 待定 / 风险

- **(已采纳评审 + 用户确认)** 副作用清理用 `defer` 机制(§7、M2);整段回滚(snapshot/worktree)**已否决**——回退靠"喂回错在哪让 agent 定向修正",非回滚世界。
- 人在环修订会"人停很久":本期阻塞跑、进程须常驻;它是**以后上'暂停/恢复'的头号理由**。`approve` 的 `timeout/default` 对人审较别扭,**本期不做**,只做 abort token。
- 并发与嵌套护栏的具体数值(最大并发会话数、最大嵌套深度)待定。
- `approve` 的阻塞 stdin 在 headless 跑时无效——本期只保交互场景,headless 审批通道留后。
- M1 的 stdin smoke 若发现"阻塞 stdin 确实卡住其它会话 delta",需改用非阻塞读 + 事件驱动的 approve(可能影响 §3 `approve` 形态)。

## 10. 关联

- [`FLOW_AUTHORING.md`](FLOW_AUTHORING.md) —— 怎么写一个 flow:目录/命名、必须导出什么、可用原语、硬规则(防 agent 乱写)、模板、自检清单。
- [`TODO.md`](TODO.md) —— 本计划是其中"工作流引擎"条目的展开;另两条(agent 间自动转发、agent 受控拉起会话)是 agent 自主向,本引擎是人写死的确定性向。
- [`PROTOTYPE.md`](PROTOTYPE.md) / [`backend.mjs`] —— 复用的后端原语(`session.send(wait:true)` 返回结果、abort、进程树清理)。

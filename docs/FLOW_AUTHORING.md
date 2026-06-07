# 怎么写一个 Flow(规则 + 模板)

> 写 `workflows/*.mjs` 之前**必读**。给人,也给被派来写 flow 的 agent。
> 配套设计文档:[`WORKFLOW_ENGINE.md`](WORKFLOW_ENGINE.md)。Synod 扫描 `workflows/` 时会按本规则**校验**,违规的 flow 直接拒绝加载。
> 写于 2026-06-07。

## 0. 心智模型

**Synod 是底座,flow 是控制核心。** Synod 提供原语(调 agent、跑 bash、人审、清理、日志);flow 用**原生 JS** 决定"流程怎么走"。你只写编排,不碰底层。

## 1. 放哪 & 叫什么

- 文件放 `workflows/<name>.mjs`。
- **flow 名 = 文件名(去掉 `.mjs`)**。`workflows/release-notes.mjs` 的名字就是 `release-notes`。
- 一个文件一个 flow。文件名用 kebab-case,见名知意。

## 2. 必须导出两样东西

```js
export const meta = {
  description: '一句话说清这个 flow 干什么',   // 必填,会被扫描提取到列表
  inputs: { topic: 'string,调研主题' },        // 可选,声明入参
};

export async function run(ctx, input) {
  // ... 编排 ...
  return result;                               // 返回最终产物
}
```

- `meta.description` **必填**(扫描时提取)。**不要**写 `meta.name`——名字取自文件名。
- `run(ctx, input)` **必填**:`ctx` 是运行上下文(纯数据),`input` 是调用方传入参数。

## 3. 只能用这些原语(从 `synod/flow` import)

```js
import { agent, agentLoop, bash, approve, reviseWithHuman, defer, runWorkflow } from 'synod/flow';
```

| 原语 | 用途 |
|---|---|
| `agent(ctx, {agent, model, prompt, effort?, reuse?})` | 调一次 agent,await 拿文本结果 |
| `agentLoop(ctx, {agent, prompt, until, maxTurns})` | agent 多轮自迭代,到 `until` 或 `maxTurns` 止 |
| `bash(ctx, cmd, {cwd?})` | 跑命令,拿 `{stdout, stderr, code}` |
| `approve(ctx, {title, body})` | 人工审批,拿 `{accepted, feedback?, aborted?}` |
| `reviseWithHuman(ctx, draft, {agent?, model?})` | 人在环修订环(产出→人给自然语言反馈→改→定稿) |
| `defer(ctx, cleanup)` | 注册清理回调,回退/失败时逆序执行 |
| `runWorkflow(ctx, './other-flow', input)` | 拉起另一个 flow,拿其返回值 |

- `agent` ∈ `{omp, codex}`(后端);`model` 是带 provider 前缀的串(`deepseek/deepseek-v4-pro`、`minimax-code-cn/MiniMax-M3`)。
- 所有原语**自动写 run log**,你不用手动记。

## 4. 硬规则(违反 = 被扫描拒绝 / 一定出 bug)

**DON'T**
- ❌ **不要 import `synod/flow` 以外的任何模块**(尤其 `fs` / `child_process` / `net` / `process` 裸用)。要副作用就用 `bash`。
- ❌ **不要裸做不可逆副作用**(写文件、`git commit`、装依赖)而不配 `defer` 清理或保证幂等——回退时会脏。
- ❌ **不要用 `process.exit()` / 监听 `SIGINT`** 控制流程。要中途退出修订用 `approve` 的 `aborted`。
- ❌ **不要写没有上限的循环**。跨节点回退、`agentLoop` 必须有 `maxTurns` / `attempt` 上限。(人在环 `reviseWithHuman` 例外:由人终止。)
- ❌ **不要往 `ctx` 塞 live 对象**(session、socket、emitter)。`ctx` 只放纯数据,要可序列化。
- ❌ **不要 `catch` 之后吞掉错误**。要么让它失败(进 log),要么 `defer` 清理后 `throw`。
- ❌ **不要把大段文本当返回值/日志塞回来**。产物自动进 artifact,返回精炼结果即可。

**DO**
- ✅ 一个 flow 一个清晰目标,`meta.description` 一句话讲清。
- ✅ **回退 = 把"错在哪"喂回 agent**(`prompt` 带上审核反馈),不是把世界回滚重来。
- ✅ 有副作用先 `defer(ctx, cleanup)`,或确保节点幂等(重跑能覆盖)。
- ✅ 要人审产物用 `reviseWithHuman`;要并行用 `await Promise.all([...])`。
- ✅ 流程**确定性骨架**:同样 `input` → 同样节点序列。随机/时间依赖要显式从 `input`/`ctx` 取。

## 5. 标准模式(抄这些)

**串行 + 并行**
```js
const a = await agent(ctx, { agent:'omp', prompt:'...' });
const [b, c] = await Promise.all([
  bash(ctx, 'npm run build'),
  agent(ctx, { agent:'codex', prompt:'...' }),
]);
```

**跨节点回退(审核不过 → 退回重做,带反馈 + 上限)**
```js
let attempt = 0, review;
do {
  const draft  = await agent(ctx, { agent:'omp', model:'deepseek/deepseek-v4-pro',
                                    prompt: buildPrompt(input, review) });   // review=上轮反馈
  const tested = await bash(ctx, 'npm test');
  review = await agent(ctx, { agent:'codex', prompt: reviewPrompt(draft, tested) });
} while (!review.passed && ++attempt < 3);
```

**人在环修订(方案A:自然语言定位)**
```js
const draft = await agent(ctx, { agent:'omp', prompt:`调研 ${input.topic}` });
const final = await reviseWithHuman(ctx, draft);   // 产出→人反馈→改→定稿;人说 /abort 优雅退出
return final;
```

**带清理的副作用**
```js
await bash(ctx, 'mkdir -p .tmp/build');
defer(ctx, () => bash(ctx, 'rm -rf .tmp/build'));   // 回退/失败时自动清
```

## 6. 完整模板(复制改)

```js
// workflows/<name>.mjs
// flow 名 = 文件名(去 .mjs)。写之前读 docs/FLOW_AUTHORING.md。
import { agent, bash, reviseWithHuman, defer } from 'synod/flow';

export const meta = {
  description: '一句话:这个 flow 干什么',
  // inputs: { topic: 'string,调研主题' },
};

export async function run(ctx, input) {
  // 1) 产出
  const draft = await agent(ctx, {
    agent: 'omp', model: 'deepseek/deepseek-v4-pro',
    prompt: `调研 ${input.topic},产出结构化文档`,
  });

  // 2) 可选:校验(有副作用就配 defer)
  // defer(ctx, () => bash(ctx, 'rm -rf .tmp'));
  // const tested = await bash(ctx, 'npm test');

  // 3) 人在环修订(自然语言定位;/abort 优雅退出)
  const final = await reviseWithHuman(ctx, draft);

  return final;
}
```

## 7. 写完自检清单

- [ ] 文件在 `workflows/`,文件名 = 想要的 flow 名(kebab-case,无多余扩展)。
- [ ] 导出了 `meta.description`(没写 `name`)和 `run(ctx, input)`。
- [ ] 只 import 了 `synod/flow`,没碰 `fs`/`child_process`/其它模块。
- [ ] 每个循环都有上限(人在环除外)。
- [ ] 有副作用的地方都 `defer` 了清理,或确认幂等。
- [ ] 回退是"把反馈喂回 agent",不是回滚世界。
- [ ] 没有 `process.exit` / `SIGINT`;中途退出走 `approve` 的 `aborted`。
- [ ] 同 `input` 跑两次,节点序列一致(确定性)。

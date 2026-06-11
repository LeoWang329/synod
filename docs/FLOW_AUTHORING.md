# 怎么写一个 Flow(规则 + 模板)

> 写 `workflows/*.mjs` 之前**必读**。给人,也给被派来写 flow 的 agent。
> 配套设计文档:[`WORKFLOW_ENGINE.md`](WORKFLOW_ENGINE.md)。Synod 扫描 `workflows/` 时会按本规则**校验**,违规的 flow 直接拒绝加载。
> 写于 2026-06-07,**最后更新 2026-06-10(补 `backtrack` 原语 + `reuse` 说明)**。

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
| `backtrack(ctx, {produce, review, buildPrompt, initialPrompt?, maxTurns})` | 跨节点回退的封装:产出→审→不过把反馈喂回重试,拿 `{output, passed, attempts}` |
| `bash(ctx, cmd, {cwd?})` | 跑命令,拿 `{stdout, stderr, code}` |
| `approve(ctx, {title, body})` | 人工审批,拿 `{accepted, feedback?, aborted?}` |
| `reviseWithHuman(ctx, draft, {agent?, model?})` | 人在环修订环(产出→人给自然语言反馈→改→定稿) |
| `defer(ctx, cleanup)` | 注册清理回调,回退/失败时逆序执行 |
| `runWorkflow(ctx, './other-flow', input)` | 拉起另一个 flow,拿其返回值 |

- `agent` ∈ `{omp, codex}`(后端);`model` 是带 provider 前缀的串(`deepseek/deepseek-v4-pro`、`minimax-code-cn/MiniMax-M3`)。
- 所有原语**自动写 run log**,你不用手动记。
- **`reuse: true`**(`agent` 的可选项,也可用在 `backtrack` 的 `produce`/`review` 里):对**同一 `agent:model`** 的多次调用复用同一条后端会话,省去反复冷启动。⚠️ **复用的是会话上下文(同一 thread 历史),不是纯进程池**——后续调用看得到前面轮次的对话。要"干净的独立回合"就**别**开(默认每次新开新关);要"评审者记得之前出的题"这类连续语境才开。`qa-loop` 即用此法把冷启动从 3–7 次降到 2 次。
- **进度显示不归 flow 管**:逐字流式由运行入口注入(REPL `/flow` 默认开,`node src/flow.mjs` 加 `--progress`),flow 里**不要**自己写输出 delta 的代码。

## 4. 硬规则(违反 = 被扫描拒绝 / 一定出 bug)

**DON'T**
- ❌ **不要 import `synod/flow` 以外的任何模块**(尤其 `fs` / `child_process` / `net` / `process` 裸用)。要副作用就用 `bash`。
- ❌ **不要裸做不可逆副作用**(写文件、`git commit`、装依赖)而不配 `defer` 清理或保证幂等——回退时会脏。
> **已知限制:正则字面量**。正则里包含 `import … from "x"` 文本可能被静态 lint 误判为非法 import。flow 应避免此写法;若确需,此为 lint 误报,非安全边界。
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

## 8. resume / headless / worktree(进阶)

这三件事让 flow 能在中断后续跑、在无人值守环境安全停等、并让多个 write agent 并行
改同一仓库不互相踩。你**不需要**改 flow 写法就能用,但理解约束能少踩坑。

### 8.1 resume:中断后从断点续跑

每次 `node src/cli.mjs --task` / `/flow` / `synod resume` 跑 flow,引擎都把每个原语
调用(agent / agentLoop / bash / approve)的输入与输出记进 `~/.synod/runs/<runId>/run.log.jsonl`,
并给每个 step 打一个**确定性 key** = `<调用序号>:<节点名>:<输入hash前8位>`。

run 被 kill 或失败后:

    synod resume <runId>        # 命令行
    /resume <runId>             # REPL 内

引擎重读日志:**前缀匹配的 step 直接回放上次的输出(不再开 agent、不再跑 bash)**,
从第一个 key 对不上的 step 起全部真跑。`synod runs` 列出可恢复的 run 与状态
(done / failed@<节点> / awaiting-approval)。

> **硬约束(确定性):** resume 的前缀匹配要求 flow 的**控制流确定**——同样的输入
> 必须走同样的原语调用顺序、同样的 prompt/命令。**绝不要用 `Date.now()` /
> `Math.random()` / 读时钟 / 读随机文件来决定走哪个分支或拼 prompt**,否则 resume
> 时算出的 key 与上次不同 → 前缀失配 → 从那里起全部真跑(不会出错,但白白重跑、
> 也可能重复副作用)。需要"当前时间/随机数"作为**数据**(不影响控制流)时没问题;
> 只是别让它决定**做什么**。

> **诚实限制(已确认接受):** agent 会话的 LLM 对话上下文活在 agent 进程里,**不可
> 恢复**。resume 能恢复的是**已完成 step 的结果 + 纯数据 ctx**;复用型会话(reuse)
> 重开后是全新会话,靠你 prompt 里带的全量上下文兜底——这正是"reuse = 优化而非
> 依赖"的既有设计(每轮 prompt 自带全文,见 §5 标准模式)。

> **并发流的 resume 是尽力而为:** `Promise.all([...])` 里多个原语的完成顺序不确定,
> resume 时序可能对不上 → 整段真跑(不损坏,只是不省)。顺序流(一个接一个 await)
> 的 resume 是强保证。

### 8.2 headless:无人值守遇 approve 不挂死

当 `!stdin.isTTY`(管道 / CI / cron)或显式 `--headless` 时,`approve()` /
`reviseWithHuman()` **不等 stdin**:把待审内容完整打到 stdout、写断点
(`checkpoint.json`)、以**退出码 5(awaiting human)** 退出。人回来在 TTY 下
`synod resume <runId>`,那个 approve 节点正常提问续答。CI 里"永久等 stdin 挂死"
就此消灭。

你的 flow **照常写** `await approve(ctx, { content })` 即可——headless 行为是引擎兜的,
不用你判断环境。

### 8.3 worktree:多 write agent 并行改同一仓库不踩

要让两个(或更多)write agent **并行**改同一个 git 仓库而不互相踩,给每个 agent 一个
**workspace 名**:

    await Promise.all([
      agent(ctx, { agent: "omp", write: true, workspace: "frontend", prompt: "..." }),
      agent(ctx, { agent: "omp", write: true, workspace: "backend",  prompt: "..." }),
    ]);

引擎为每个 workspace 名建一个 **git worktree** + 分支 `synod/<runId>/<name>`,该 agent
的 cwd 指向自己的 worktree——彼此隔离。run 结束时引擎**逐分支尝试合回起始分支**:
能干净合并的自动合并 + 清掉 worktree/分支;**有冲突的保留 worktree 与分支,在摘要里
打印清单(分支 / 冲突文件 / 路径)留你处理**。顺利路径零人工,出错路径不丢任何工作。

规则:
- **同名 workspace 复用同一 worktree**(多次调用累积在一个隔离区);不同名 = 独立隔离区。
- **只读 agent(不传 workspace)用主 cwd,零开销**——不建 worktree。
- **非 git 目录**用 `write + workspace` 会被**直接拒绝**(报错建议 `git init` 或串行)。
  单写者(不传 workspace)不受影响。
- 崩溃残留:`synod runs` 可见 worktree 计数;启动时 synod 会 `git worktree prune` 并提示
  残留路径(只提示不替你删)。

# Superpowers 开发链 → Synod Flow 设计

> 写于 2026-06-21。把 superpowers 的「头脑风暴 → spec → 写计划 → subagent 驱动开发 → review」
> 编码成 synod flow。配套可视化:`2026-06-21-superpowers-dev-flow-mockup.html`。
> 创作规则见 `docs/FLOW_AUTHORING.md`。

## 1. 目标与动机

把用户**手动跑了一整轮**(用来建 synod 本身)的 superpowers 开发工作流,产品化成一条
可一键拉起、可中断续跑、可并行写隔离的 synod flow。

**核心心智:JS 当导演、agent 当演员。** flow 的确定性 JS 骨架取代 superpowers 里
「主 agent 协调者」的角色;omp/codex 子 agent 只是工人。每个语义判断都被降解为
**一个可解析的记号**或**一次人输入**——JS 只做 `if` 和计数,不"理解"。

## 2. 架构:按产物切的子 flow 链

superpowers 各阶段之间的交接物(spec 文档 / plan 文档 / 代码 diff)是**纯数据**,
本身就是天然的 flow 边界。所以每段做成独立子 flow,薄父 flow 用 `runWorkflow` 串联,
接缝处插可配人审卡口。

```
父 flow superpowers.mjs (runWorkflow 串 4 段 + 接缝 approve)
  ① brainstorm-spec.mjs  ──spec.md──▶
  ② spec-to-plan.mjs     ──plan.md──▶
  ③ execute-plan.mjs     ──diff──▶
  ④ final-review.mjs     ──▶ 合并 / PR
```

**为什么子 flow 链而非巨型 flow:** 每段可单独重跑/resume(开发崩了只重跑 ③,不必重新
头脑风暴);符合「一个 flow 一个清晰目标」;`runWorkflow` 的 cwd/深度/并发继承(F6)
正为此设计;产物即交接,边界免费。

### 2.1 角色与模型分配(用户拍板)

| 角色 | 后端 + 模型 | 写权限 |
|---|---|---|
| brainstorm / plan / review(强模型) | `codex` | review/brainstorm 只读;plan 产出文本 |
| 开发写码 | `omp` + `deepseek/deepseek-v4-pro` | `write:true` |

注:codex 是编码向 agent,用作**开放式头脑风暴对话**略不对口——本设计先按用户定的来,
brainstorm 节点 codex 表现**待真 agent 实测**,不行再换模型(`SYNOD_FLOW_MODEL` 可覆盖)。

## 3. 新增内核原语:`ask()`

现有 `approve()` 的判定契约(`"ok"/"yes"`→accepted、空行→aborted)对**自由问答**是坑:
人用"嗯/ok"回答问题会被误判成"批准结束"。头脑风暴的提问取答需要一个**只返回人打的
原始整行、不做任何分类**的原语。

```js
// 从 synod/flow 导出
ask(ctx, { question, signal? }) => Promise<string>   // 返回人输入的原始整行(已 trim)
```

**与 `approve` 对齐的工程要求**(参照 `src/flow/api/approve.mjs`):
- **共享单所有者 readline**:经 `io.question(prompt, { signal })` 读,与 approve/CLI 互斥,
  防双读。
- **resume 重放**:`getReplay(ctx.runId, { node:'ask', input:question })` 命中即回放上次人答,
  不重新提问。
- **headless**:`!stdin.isTTY` 或 `--headless` 时,打印 question 到 stdout + 写
  `awaiting-approval` checkpoint + 退出码 5;人回 TTY `synod resume` 续答。
- **abort signal**:`opts.signal ?? getSignal(ctx.runId)`,abort 时协作退出(不抛、不 kill)。
  约定:abort 返回 **`null`**(区别于空行的空串 `""`),调用方 `=== null` 判停。
- **日志**:每次调用写 `step:*` 对(input=question,output=人答)。
- **DI factory**:`createAsk({ io, logger, getSignal, getReplay, headless, runsRoot, events, onApprovalNeeded })`,
  与 approve 同构,便于 fake 测试。

`ask` 是 brainstorm 提问唯一取答口;`approve`(三态:accept/abort/feedback)继续用于
**审批/定稿卡口**(spec 草稿、plan 改稿、人审 gate)。两者职责不重叠。

## 4. 各子 flow 设计

### 4.1 ① brainstorm-spec.mjs

子 agent 自适应提问、人作答,用**两把钥匙 + 刹车**判定结束。

- **提问循环**:`agent(codex, reuse:true)` 问下一个澄清问题 → `ask()` 收人答 →
  喂回 `transcript` → 再问。`reuse` 让多轮共享会话(优化,非依赖——每轮 prompt 自带全量
  transcript)。
- **判定结束(JS 只查):**
  1. **钥匙①(agent 提议)**:agent 吐独占记号 `<<<SPEC>>>`(后跟设计稿草稿)。JS 用
     `includes('<<<SPEC>>>')` 抓。记号**只是提议,不盲信**。
  2. **钥匙②(人拍板)**:把草稿经 `approve()` 呈给人;`accepted` → 真结束、写 `spec.md`;
     人给 feedback → 草稿没过,带反馈接着聊。
  3. **刹车**:到 `MAX_TURNS`(默认 20) / 人在 `ask` 阶段打 `/spec` → 强制让 agent 即刻
     产出草稿收尾。
- **产物**:`<runDir>/spec.md`(经 `bash` 写,幂等覆盖)。返回 spec 路径。

### 4.2 ② spec-to-plan.mjs

- `agent(codex)` 读 `spec.md` 产出**分 task 的 TDD 实现计划**(遵循 writing-plans 规格:
  每 task 有验证标准)。
- `reviseWithHuman()` 人在环改稿定稿。
- **产物**:`<runDir>/plan.md`。返回 plan 路径。

### 4.3 ③ execute-plan.mjs(最肥)

- `parsePlan(planText)` 解析出有序 task 列表(JS 纯函数;格式契约见 §6)。
- `for` 逐 task:
  ```
  backtrack(≤3 轮):
    produce: agent(omp, deepseek, write:true, workspace:'dev') 写码
    review:  bash('npm test') + agent(codex, write:false) 审
    passed = test.code===0 && /APPROVE/.test(codex 评审)
    不过 → 带「测试输出 + codex 反馈」回退重写
  per-task approve()   // 仅 gates='all'
  ```
- **自动刹车(关键)**:某 task `backtrack` 耗尽 `maxTurns` 仍 `passed:false` →
  **停在此 task,不往下做/不合**(返回失败,父 flow 据此中止,不闭眼合坏码)。
- **并行写隔离**:同名 `workspace` 复用一个 git worktree;run 结束引擎逐分支尝试合回——
  干净自动合、冲突留存(1C-b finalize 既有行为)。本设计默认单 workspace `'dev'` 串行;
  计划可声明可并行的 task 组用不同 workspace。
- **产物**:diff(落在 worktree)。返回 `{ done, failedTask? }`。

### 4.4 ④ final-review.mjs

- `agent(codex, write:false)` 审全量 diff。
- 有问题 → `backtrack`:deepseek 修 → codex 复审(≤2 轮)。
- **产物**:评审报告。返回 `{ approved, report }`。

### 4.5 父 flow superpowers.mjs

```js
const specPath = await runWorkflow(ctx, './brainstorm-spec', input);
if (gate('spec')) await approve(ctx, { content: read(specPath) });
const planPath = await runWorkflow(ctx, './spec-to-plan', { specPath });
if (gate('plan')) await approve(ctx, { content: read(planPath) });
const dev = await runWorkflow(ctx, './execute-plan', { planPath, gates });
if (!dev.done) return { status:'halted', at: dev.failedTask };   // 自动刹车
if (gate('dev')) await approve(ctx, { content: dev.summary });
const rev = await runWorkflow(ctx, './final-review', { });
if (gate('final')) await approve(ctx, { content: rev.report });   // 默认建议留这一处
return { status:'done', spec:specPath, plan:planPath, review:rev };
```

## 5. 人审卡口 = input 开关

`input.gates`:
- `'none'`(默认,用户选择):全自动零人审。
- `'final'`(建议):只最终合并前停一次。
- `'all'`:spec后 / plan后 / 每task后 / 最终(superpowers 原意)。

`gate(stage)` = 纯函数,按档位决定该卡口是否触发。**注意:** brainstorm 的提问对话(`ask`)
和 codex 评审 + `npm test` **永远在,跳不掉**——`gates` 只关人审 `approve` 卡口。

## 6. 关键契约与边界

- **plan 格式契约**:`parsePlan` 依赖 plan.md 的 task 列表有稳定可解析结构(如
  `## Task N: 标题` 段)。spec-to-plan 的 prompt 必须**强制 codex 产出该结构**,否则 ③ 解析失败。
  这是跨节点的**隐式接口**,要在 prompt 与 parsePlan 两端对齐 + 单测固定。
- **确定性骨架**:同 input → 同节点序列(resume 前提)。brainstorm 轮数由人/记号决定
  (人在环豁免),但绝不用 `Date.now()`/`Math.random()` 决定控制流或拼 prompt。
- **副作用配 defer / 幂等**:写 spec.md/plan.md 幂等覆盖;worktree 由引擎 finalize 兜清理。
- **只 import `synod/flow`**:workflow 文件不碰 fs/child_process,写文件走 `bash`。

## 7. 失败 / 中断策略

- **task 写不过**:execute-plan 自动刹车,父 flow 返回 `{status:'halted', at}`,worktree 留存
  待人。
- **中断**:step 级 resume;命中前缀直接回放,不重开 agent/不重跑 bash。LLM 对话上下文
  不可恢复(已确认接受)——brainstorm 重开靠 prompt 里的全量 transcript 兜。
- **headless 遇 approve/ask**:写断点、退出码 5,`synod resume` 续。

## 8. 测试策略

- **单测(fake 后端 + fake io)**:
  - `ask()`:三态消失——回原始整行;`/spec` 透传由调用方判;空行返回 `""`(有效空答、不当
    abort);abort(signal)返回 `null`;replay 命中回放;headless 写断点 + 退出码 5。
  - `parsePlan()`:固定多 task / 单 task / 畸形输入。
  - 各 flow 用 fake `agent` 注入脚本化输出(含 `<<<SPEC>>>` 记号、`APPROVE`、test 绿/红),
    断言节点序列、自动刹车、gates 各档位触发的 approve 次数。
- **e2e(真 agent)**:一条最小真跑——codex brainstorm 一两轮 → deepseek 写一个琐碎 task →
  codex 审 → 收尾。沿用 `acceptance-flow` harness,模型注入 `deepseek/deepseek-v4-pro`。
- **验收**:`npm test` 全绿 + 新增 e2e 绿 + 既有 `test:e2e`/`test:e2e-flow`/`test:e2e-shutdown`
  不回归。

## 9. 风险与待实测

1. **codex 做开放式头脑风暴对话**对口度待实测(§2.1)。
2. **`<<<SPEC>>>` 记号可靠性**:codex 未必每次老实吐 → 靠人 accept + MAX/`/spec` 兜。
3. **plan 格式契约**两端易漂移(§6)→ 单测钉死 + prompt 强约束。
4. **`ask()` 是内核改动**,要与 approve 的 replay/headless/abort/log 全特性对齐,否则 resume/
   headless 在 brainstorm 段破功。

## 10. 范围与非目标

- **不做**:token/费用统计;daemon;brainstorm 之外的 agent 自主编排(走 mesh 那条线,本 flow
  不用)。
- **首版可接受简化**:execute-plan 默认单 workspace 串行(并行 task 组留后续);final-review
  ≤2 轮。

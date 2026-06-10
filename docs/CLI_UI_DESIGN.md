# Synod CLI UI 设计

> 写于 2026-06-10。配套 `docs/V1_REVIEW_AND_ARCHITECTURE.md`(§4.8/§4.10)。
> 目标:在**零三方依赖**(纯 ANSI + node:readline)的前提下,把 REPL 做到易用——三种使用面(主持人 / workflow / team)同一内核、并列入口,交互上彼此隔离、心智上互相贯通。
> 落地节奏:**UI v1** 随阶段 1(1D)交付,**UI v2(team 视图)** 随阶段 2 交付。每节标注 v1/v2。

---

## 0. 设计原则

1. **零依赖**:只用 ANSI 转义 + `node:readline`。不引 ink/blessed/chalk;颜色函数自写(~20 行)。
2. **非 TTY 优雅降级**:`stdout.isTTY === false`(管道/CI/`--task`)时零 ANSI、零提示符装饰、零 spinner;一切信息以纯文本行呈现。所有视觉元素必须有纯文本等价物。
3. **一切可回读**:UI 不做"只在屏幕上存在"的状态(粘性面板/alt-screen)。终端滚动缓冲区就是完整历史——这也是放弃底部粘性状态栏的原因(scroll-region 方案与"可回读"冲突,且 zero-dep 下脆弱)。状态用**按需命令**(`/sessions` `/relays` `/team status`)+ **提示符内嵌**表达。
4. **渐进披露**:默认界面只有提示符;新手靠 `/help` 与出错时的"试试 xxx"提示;高级行为全部显式 flag/命令。
5. **保留并强化主持人模式**(用户要求):现有 `/open /use /sessions @label @all /relay /unrelay /relays /flow /exit` 全部保留,只增不改;UI 的工作是让这套玩法**更看得清、敲得快**。

---

## 1. 提示符与模式徽标(v1)

提示符携带三个信息:**模式、当前会话、忙闲**。

```
主持人模式(默认,= 现有 REPL):
  synod ❯                          ← 还没有会话(罕见,默认会话失败时)
  [omp#1] ❯                        ← 当前会话 omp#1,空闲
  [omp#1 ⠧ 2 running] ❯            ← 当前会话忙;另有 2 个会话在跑(计数,不刷屏)

workflow 运行视图(/flow 进入,运行期间):
  ── flow qa-loop ──────────────── ← 进入横幅;期间无提示符,流式输出占屏
  (结束后回到主持人提示符)

team 视图(v2,/team 进入):
  [team:build|planner] ❯           ← team 名 + human 消息的投递对象(leader)
```

- 提示符前缀色:主持人 = 青;flow 横幅 = 蓝;team = 品红。非 TTY 时退化为 `> `(与现状一致,不破 e2e 的 `"> "` 探测)。
- 忙闲指示**只在重绘提示符时更新**(turn 完成的 onIdle 已有重绘钩子),不做定时器动画——避免和流式输出抢屏。

## 2. 多路输出(v1)

现状 `[label] ` 前缀保留,叠加三点:

1. **每会话固定色**:label 着色,8 色循环分配(`omp#1`=绿,`omp#2`=黄,`codex#1`=蓝…)。色板函数:

```
labelColor(label) = palette[hash(label) % 8]    // 同一 label 永远同色
```

2. **turn 边界线**:一个会话的 turn 完成时,在其最后一行后输出一条暗色短线 + 元信息(非 TTY:纯文本一行):

```
[omp#1] ……回答正文最后一行
[omp#1] ── done · 12.3s ──────────
```

3. **转发可视化**(主持人模式核心玩法):relay 触发的注入消息在目标会话输出前打一行来源标注(现状已有 `[relay from X]` 在 prompt 里,UI 再在屏幕上显式一行):

```
[codex#1] ◀─ relay from omp#1 (1.2k chars)
[codex#1] 收到,我来评审……
```

## 3. 命令体验(v1)

### 3.1 Tab 补全(readline completer)

| 位置 | 补全内容 |
|---|---|
| 行首 `/` | 全部命令名 |
| `/use ` `/close ` `@` | 活跃会话 label |
| `/open ` | `+<profile>`(来自 config)+ `--agent` 后接注册表 backend 名 |
| `/flow ` | `discoverFlows` 的 flow 名(坏 flow 显示为 `name (error)` 不可选) |
| `/relay ` | `label->label` 两端 label |
| `/team `(v2) | config 里的 team 名 |

实现:`readline.createInterface({ completer })`,completer 是纯函数(输入行 → 候选),可单测。

### 3.2 `/help` 分组(替代现在的平铺)

```
❯ /help
会话(主持人模式)
  /open [+profile] [--agent A] [--model M] [--effort E] [--write] [--mesh]
  /use <label>      /close <label>      /sessions
消息
  <text> → 当前会话      @<label> <text> → 定向      @all <text> → 广播
转发
  /relay a->b      /unrelay a->b      /relays
工作流
  /flow            列出可用 flow
  /flow <name> [input]
团队(阶段 2)
  /team <name> "<task>"      /team status      /done
其他
  /help [cmd]      /exit (Ctrl-D)      Ctrl-C 中断
```

`/help <cmd>` 给单命令详情(参数、示例、常见错误)。

### 3.3 错误提示带"下一步"

所有 `No session "x"` 类错误追加一行建议:

```
synod: no session "omp#3"
  hint: /sessions 查看活跃会话;/open 新开一个
```

### 3.4 历史持久化

readline `history` 写 `~/.synod/history`(上限 1000 行,启动加载)。`@all` 与含敏感词?不做过滤——本机文件,信任模型同 config。

### 3.5 新增命令(v1)

- `/close <label>`:关会话 + 解除其 relay 绑定(填 P2-19)。
- `/status`:一行式总览(会话数/在跑数/活跃 relay 数/当前 flow)。

## 4. `/sessions` 增强(v1)

```
❯ /sessions
   LABEL    BACKEND  MODEL              STATE     TURNS  RELAY
 * omp#1    omp      deepseek-v4-pro    idle      4      → codex#1
   omp#2    omp      MiniMax-M3         running   2
   codex#1  codex    (default)          idle      3      ← omp#1
```

- `*` = 当前会话;RELAY 列直接显示出/入边(主持人一眼看清自己搭的转发网)。
- 非 TTY:同样表格,无色。

## 5. workflow 运行视图(v1)

`/flow <name>` 进入运行视图(`--progress` 语义保留并默认开):

```
❯ /flow qa-loop "分布式锁"
── flow qa-loop ─────────────────────────────────
[deepseek] 出题中……(流式正文,label 即 agent:model 简称,沿用现有 sink)
[minimax]  回答……
[deepseek] PASS
── result ───────────────────────────────────────
{
  "topic": "分布式锁", "passed": true, "attempts": 1
}
── done · 3 turns · 2 sessions · 41s · log: ~/.synod/runs/<runId>/ ──
```

- 头尾横幅 + 结果 JSON 原样打印(可复制);尾行给 run 目录(阶段 1C 落地 per-run 目录后)。
- 运行期间 Ctrl-C = 中断 flow 回到 REPL(阶段 1C 的 ctx AbortSignal 落地前,维持现状:中断即退出进程,横幅注明)。
- `approve()/reviseWithHuman` 的人机问答:提问行用反色块突出,且 REPL 输入路由让位(P1-8 的 InputRouter,阶段 1C):

```
┃ approve? (accept / feedback / /abort):
```

## 6. team 视图(v2,随阶段 2)

```
❯ /team build "重构 X 模块"
── team build · leader: planner · mode: hub ─────
[planner]  拆解任务:1) … 2) …
[planner]  ⚙ spawn coder → ok
[coder]    开始实现 …
[planner]  ◀─ from coder (turn done)
…
❯ /team status
  ROLE      BACKEND  STATE    TURNS  BUDGET
  planner*  omp      running  6      28/40 turns · 12m/30m
  coder     omp      idle     4
  reviewer  codex    idle     3
```

- member label 用**角色名**(coder/reviewer)而非 omp#N——配 §4.5 设计。
- 编排动作(spawn/relay/done)以 `⚙` 行显示在 leader 名下;回执行 `◀─` 同 relay 可视化,一套符号语言。
- human 输入直达 leader(提示符已标 `|planner`);`@coder <msg>` 在 hub 模式下被拒并提示(`hub 模式下成员只听 leader;用 /team mode direct 或转告 leader`)。
- `/done` 人工触发收尾;结束横幅给 summary + run 目录。

## 7. 非交互与脚本化约定(v1 定约定,阶段 3 全量落地)

- `--task` / `synod run`:无 ANSI、无提示符;`--json` 输出结构化结果(`{label, ok, text, error}` 数组 / flow 返回值)。
- 退出码(已有约定文档化进 `--help`):`0` 成功 · `1` 任务/flow 失败 · `2` 参数/配置错 · `3` agent 不可用 · `4` 会话打开失败。
- `NO_COLOR` 环境变量与 `--no-color` 强制关色(即使 TTY)。

## 8. 实现要点(给开发者)

1. **颜色工具**:`src/ui/ansi.mjs`,约 30 行:`color(code, s)`、`enabled(stream, env)`(`isTTY && !NO_COLOR`)。所有 UI 模块经它出字,禁止裸写 `\x1b[`。
2. **completer 纯函数化**:`src/ui/completer.mjs` 导出 `makeCompleter({ sm, config, flows })`,返回 readline completer;单测直接喂字符串断言候选。
3. **不引入渲染循环**:UI = "在已有写点上多写几行"(open/turn-complete/idle/list 命令),没有定时刷新,没有屏幕状态机。这保证 UI 层薄、可测、不与流式输出竞态。
4. **与 line-buffer 的关系**:着色在 `createLineBuffer` 的 `[label] ` 前缀处做(单点);turn 边界线在 session-manager 的 onTurnComplete 钩子写。两处都已存在,UI 是参数化增强。
5. **测试**:Tier 1 断言纯文本路径(非 TTY)逐字节稳定 + completer 候选;着色路径断言"含 ANSI 前缀且 strip 后等于纯文本路径"。e2e 维持非 TTY(现有 acceptance 不受影响)。

## 9. 分期清单

| 项 | 期 | 依赖 |
|---|---|---|
| ansi 工具 + label 着色 + turn 边界线 | v1(阶段 1D) | 无 |
| 提示符模式徽标 + 忙闲 | v1 | 无 |
| /help 分组 + 错误 hint + /close + /status | v1 | 无 |
| Tab 补全 + 历史持久化 | v1 | config(profile/flow 名来源) |
| /sessions 表格 + relay 列 | v1 | 无 |
| flow 运行视图头尾横幅 + 结果块 | v1 | 无(run 目录尾行等 1C) |
| approve 反色提问 + 输入让位 | 阶段 1C(P1-8 InputRouter) | 1C |
| flow 内 Ctrl-C 中断不退进程 | 阶段 1C(AbortSignal) | 1C |
| team 视图全部 | v2(阶段 2) | MessageBus/TeamRun |
| --json / NO_COLOR / 退出码进 help | 阶段 3 | 无 |

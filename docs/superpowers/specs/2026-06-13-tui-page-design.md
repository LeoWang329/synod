# Synod TUI 页面设计(OpenCode 风格全屏 TUI)

> 写于 2026-06-13。头脑风暴产出,经用户逐屏确认(布局 L3 v4 / 技术 Ink / 范围分期)。
> 配套 mockup:[`2026-06-13-tui-page-mockup.html`](./2026-06-13-tui-page-mockup.html)(浏览器打开即所见即所得)。
> 取代 `docs/CLI_UI_DESIGN.md` §0 的两条前提(零依赖、拒绝 alt-screen)——见该文件 2026-06-13 顶部修订说明。

---

## 1. 目标与非目标

**目标:** 给 synod 一个 **OpenCode 风格的全屏 TUI**,把"多 agent + relay 网状协作"这件 synod 独有的事**看得清、点得动**:

- 一眼看清**哪些 agent 在跑**;
- 鼠标/键盘**选中**任一 agent,展开看它的**内部运行状态**;
- agent 输出**实时流式**渲染,工具调用渲染成**可展开的卡片**(像 OpenCode/Claude Code)。

**非目标(本期不做):**

- 不改后端进程治理 / 会话生命周期 / 清理逻辑(`backend.mjs`/`shutdown.mjs`/`pid-registry.mjs` 原样)。
- 不动 flow 引擎、relay 语义、围栏(fence)协议、mesh 注入——TUI 只是它们的新视图与输入面。
- 不做 team 视图(`CLI_UI_DESIGN.md` §6 的 v2 概念),本期聚焦主持人 + mesh。
- 不追求 OpenCode 的极致渲染性能(它为此上了 Zig 核;synod 规模无需)。

**第一性原理上的关键约束:** TUI 是**加在现有内核之上的一个前端**,不是重写。`session-manager`/`repl-dispatch`/`relay`/`control-wire`/`backend` 全部复用,接口不破。非 TTY/管道/`--task` 仍走现有纯文本路径不变(见 §9)。这与 OpenCode "核心 / 渲染分离"同理——synod 天生具备这条边界。

---

## 2. 已锁决策

| 维度 | 决策 | 出处 |
|---|---|---|
| 范式 | 全屏 TUI(接管终端,alt-screen) | 用户:"就是 opencode 那种 TUI" |
| 布局 | **L3:右侧 agents 栏 + 焦点区 + 底部输入/状态栏** | mockup v4 |
| 渲染技术 | **[Ink](https://github.com/vadimdemedes/ink)(React-for-CLI)为主**;Ink 覆盖不到处(鼠标、命中检测)**手写 ANSI 补** | 用户:"我选 Ink,覆盖不到的手搓补" |
| 依赖政策 | UI 前端层允许引包;核心层维持 node-only(非铁律)。"零依赖"本意 = 不复用 agent-bridge 组件,与 npm 包无关 | 用户澄清 + README/CLI_UI_DESIGN 已修订 |
| 内部状态展示 | A 对话流 + B 活动 + C 编排意图 + D relay + E 元信息(原 F 原始 RPC **已砍**) | 用户:"ABCDEF 全要" → 后又"原始 RPC 不需要" |
| C/D 默认态 | **折叠成带摘要的小条**,点开看细节;A 常展开,B+E 头部常驻 | 用户:"C/D/F 默认折叠" |
| relay 可视化 | 右栏箭头文字 + 卡间连接线即可,**不做网络图** | 用户:"不需要" |
| OpenCode 同款栈 | **否决**(Zig+Bun+SolidJS,换运行时,代价不成比例) | 调研结论 |
| 默认进入 | **TTY 交互默认进 TUI**;`--no-tui` 回退老 REPL | 用户确认 |
| 事件适配器 | 走**注册制**(仿 `src/backends/registry.mjs`):每个后端注册自己的事件适配器,加后端 = 注册适配器,核心零改 | 用户:"适配也要那种注册的" |
| 主题 | **固定一套**(tokyonight 风),留主题接口供日后扩展 | 用户:"主体固定留好接口" |
| `$` 命令 | **本期搁置**,保留 `$` 前缀不赋行为 | 用户:"$ 先不管了" |
| P2 范围 | codex + omp **一起做**(两边事件均已摸清,见 §7) | 用户确认 + 日志探针 |

为什么不是 L1/L2:L1(侧栏单聊)最像 OpenCode 但弱化了"多 agent 全局态势";L2(平铺分屏)态势强但深读差、agent 一多就挤。L3 兼得"全局一眼清 + 单 agent 深读",最贴 synod 的多 agent 本质。

---

## 3. 架构:TUI 是内核之上的前端

```
            ┌─────────────────────────── 现有内核(不改)───────────────────────────┐
 human 输入 │  session-manager   backend(omp/codex EventEmitter)   relay-registry   │
   │        │     │  ▲                   │ emit 'event'/'delta'/'status'   ▲          │
   ▼        │     ▼  │ onIdle/onTurn      ▼                                 │          │
┌────────┐  │  repl-dispatch ──────► control-wire(fence 解析/回喂)─────────┘          │
│  TUI   │──┘     (复用,@/ /命令逻辑不变)                                              │
│ (Ink)  │◄──────────────── 规范化事件流(§7)── 适配器订阅 backend 'event' ───────────┘
└────────┘
```

- **输入**:TUI 底部输入框把每行交给**现有 `dispatch(line, {source:"human"})`**。`@label`/`@all`/`/open`/`/relay`/`/flow`/围栏/mesh 全部原样生效——TUI 不重新实现命令,只换了"输入采集"和"输出渲染"。
- **输出**:TUI 订阅每个 session 的 `'event'`/`'delta'`/`'status'`,经一层**规范化适配器**(§7)转成 UI 可渲染的"条目流(items)",驱动 React 状态。
- **编排可视化(C)**:`control-wire` 已知道每个 turn 的围栏命令 + 回喂结果;TUI 从这里取数渲染"编排意图"。
- **relay 可视化(D)**:从 `relay-registry.list()` 取出/入边。

**新增模块(全部在 `src/ui/tui/` 下,与现有薄 UI 模块并列):**

| 模块 | 职责 |
|---|---|
| `src/ui/tui/app.jsx` | Ink 根组件,布局三区,持有全局 UI 状态(focusLabel、各 session 的 items、展开态) |
| `src/ui/tui/store.mjs` | 订阅 sm/backend 事件 → 规范化 → React 可消费的 store(每 session 一条 item 时间线) |
| `src/ui/tui/components/` | `AgentRail` / `FocusPane` / `Conversation` / `ToolCard` / `CollapsibleStrip` / `InputBar` / `StatusBar` / `Hints` |
| `src/ui/tui/mouse.mjs` | **手搓**:开启 SGR 鼠标上报、解析事件、命中检测(§6) |
| `src/ui/tui/events.mjs` | **规范化事件模型** + omp/codex 适配器(§7;P2 重点) |
| `src/ui/tui/index.mjs` | 入口:`startTui({ sm, dispatch, registry, controlWire, stdin, stdout })`,在 `cli.mjs` 交互分支按条件拉起(§9) |

---

## 4. 布局规格(L3)

整屏三区(见 mockup):

```
┌ titlebar: synod · mesh — N sessions ───────────────────────────────┐
│ ┌─ 焦点区(main, flex)──────────────────┐ ┌─ agents 栏(右, 固定宽)─┐ │
│ │ [头部] ●label  E元信息   B活动         │ │ AGENTS · N   ↹/点击切换  │ │
│ │ ───────────────────────────────────── │ │ ┌ ●label  t4 ┐ ← 选中高亮 │ │
│ │ A 对话流(常展开, 流式)                 │ │ │ running·17s │           │ │
│ │   you / assistant 气泡                 │ │ │ ▶ relay→…   │           │ │
│ │   ▸ 工具调用卡片(可展开)               │ │ │ 最后一行…   │           │ │
│ │ ───────────────────────────────────── │ │ └─────────────┘           │ │
│ │ ▸ C 编排意图   3 cmds·✓codex#1 ●new    │ │   label  ✓idle  t3        │ │
│ │ ▸ D relay      ▶out codex#1 ◀in —      │ │   ◀ from …                │ │
│ ├ [输入] [label] ❯ ……▌ ─────────────────┤ │ + ^O 新会话    mesh on    │ │
│ └────────────────────────────────────── ┘ └──────────────────────────┘ │
│ statusbar: ↹切焦点 ^O开 ^W关 /命令 ^C中断          ● k running · mesh on │
└─────────────────────────────────────────────────────────────────────────┘
```

**焦点区(选中 agent 的内部状态)** 自上而下:

- **头部(常驻)**:`● label`(状态点)+ **E 元信息**(agent · model · effort · cwd)+ **B 活动**(running/idle · turn N · 本轮耗时 · queue 积压 · token)。
- **A 对话流(常展开)**:`you` / `assistant` 消息块;assistant 内含**流式正文**(打字机光标)+ **工具调用卡片**(§5)+ turn 结束分隔线(`done · 12.3s · 1.2k tokens`)。
- **C 编排意图(折叠条)**:摘要 `3 cmds · ✓ 新会话 codex#1 · 回喂已发`;有新动作时**橙点脉冲**提示。展开列出该 turn 的围栏命令 + `→ ok/err` + `[synod fence result]` 回喂状态。**synod 独有,务必显眼。**
- **D relay(折叠条)**:摘要 `▶ out codex#1 · ◀ in —`;展开列明细。

**右侧 agents 栏(全局态势 + 选择)**:

- 每个 session 一张卡:状态徽标(`●`蓝=running 脉冲 / `✓`绿=idle)、label、turn 数、relay 出/入箭头、最后一行预览。
- **选中卡高亮**(蓝边)= 当前焦点;**点击或 `↹` 切换**。
- 有 relay 关系的卡之间画连接线(`omp#1 ▶ codex#1`)。
- 底部:`+ ^O 新会话`、`mesh on/off`。

**底部输入栏**:提示符前缀 `[当前 label] ❯`,输入直达当前焦点 session(`@label` 临时改投递目标,见 §6 命令提示)。

**全局状态栏**:快捷键提示 + `● k running · mesh on`。

---

## 5. 工具调用渲染

assistant 边流式吐、前端边渲染。遇到工具调用,渲染成**卡片**(默认收起):

```
▸ ◇ Read   src/relay.mjs              ✓ 47 lines      ← 收起:图标+名+摘要+状态
▾ ✎ Edit   src/relay.mjs·onTurnComplete  ✓ +2 −1       ← 展开:看 diff
    - const chain = task.then(run)
    + chain = task.catch(()=>{})
    + chain = chain.then(run)
▾ $ Bash   npm test -- relay          ◐ running        ← 运行中:转圈+实时输出
    ▸ relay.test.mjs ... ok▌
```

- **收起态**:`[图标] [工具名] [一行参数摘要] [状态]`。状态:`◐ running`(转圈)/ `✓ done` / `✗ error`。
- **展开态**(点卡片头 / 键盘):按工具类型渲染——Edit→diff,Bash→命令+输出,Read→路径+行数,Grep→匹配等。
- 图标用宽度安全的 Unicode(`◇ ✎ $ ⌕`…),避免 emoji 在终端的宽度坑。
- **依赖后端把工具事件结构化抛上来**——这是 P2 的核心工作量,见 §7、§10。

---

## 6. 命令输入与提示(`/` `@` `$`)

输入框随键入弹出**提示浮层**(在输入框上方),候选随输入过滤。提示引擎**复用并扩展现有纯函数 `src/ui/completer.mjs` 的 `makeCompleter`**(逻辑单点、可单测),TUI 只是换了"渲染候选"的皮。

### `/` 斜杠命令提示
- 行首 `/`:列出全部命令(带一行说明):`/open /use /close /sessions /relay /unrelay /relays /forward /flow /resume /status /help /exit`。
- 参数级提示(completer 已实现,直接用):
  - `/use `/`/close ` → 活跃 session label;
  - `/open ` → `+profile`(config)+ `--agent/--model/--effort/--write/--mesh`,`--agent ` 后接注册后端名;
  - `/relay`/`/unrelay`/`/forward` → `label->label` 两端补全;
  - `/flow ` → 可用 flow 名。

### `@` 定向提示
- 行首 `@`:列出 `@all` + 全部 session label(`@omp#1`…)。选中即把这一条消息投递到该 session(等价现有 `@label msg`)。

### `$` 命令提示 —— **本期搁置**
当前 synod 没有 `$` 命令,其语义(host shell 透传?别的?)尚未定。**本期不做**:输入框**保留 `$` 前缀的识别钩子但不赋任何行为**(键入 `$` 不弹错、不触发,留作日后接口)。`/` 与 `@` 二者已有内核支撑,本期只做这两个。

---

## 7. 数据流与事件模型(P2 重点)

### 现状(已核实 `src/backend.mjs`)
- 后端**已有结构化事件通道**:`OmpSession`/`CodexSession` 每条解析后的协议消息都 `emit('event', …)`,另有 `'delta'`(纯文本增量)、`'status'`。**地基已在。**
- **但工具调用细节现在被丢弃/截断:**
  - **codex**:工具/命令/改文件在 app-server 里是 `item/*` 事件;代码只特判 `item.type==="agentMessage"`,其余 item 在 `item/completed` 里**主动剥 payload**(只留 `itemType+id`);`compactEvent` 把字符串**截到 300 字**。
  - **omp**(`--mode rpc`):只特判 `message_update/text_delta`,其余走 `compactEvent` 原样抛(同样 300 字截断)。**omp 究竟发哪些工具事件、什么结构——代码看不出,是未知数(见 §10 探针)。**

> **探针已完成(2026-06-13):** 读 `~/.agent-bridge/logs/omp-*.log` 实测,omp `--mode rpc` 的事件词表已确认(见下"omp 适配器")——无未知数,P2 可直接落地。

### 目标:后端无关的规范化事件流(适配器**注册制**)
定义一套 UI 渲染用的规范条目,**两个后端各写一个注册的适配器**翻译过去。适配器走注册制,仿 `src/backends/registry.mjs`:`src/ui/tui/events.mjs` 暴露 `registerEventAdapter({ agent, normalize })`,store 按 session 的 `agent` 取对应适配器、把原始事件转成规范条目;**新增后端 = 注册其适配器**(未注册则回退到只认 `'delta'` 文本的默认适配器),核心与 UI 都不改。规范条目:

```
message.start { turnId }
message.delta { turnId, text }
message.end   { turnId }
tool.start    { turnId, id, name, args }
tool.delta    { turnId, id, chunk }        // 工具流式输出(可选)
tool.end      { turnId, id, status, detail } // detail: diff|output|fileList…
turn.start    { turnId } / turn.end { turnId, stats:{ms,tokens} }
status        { status, isStreaming }
orchestration { turnId, commands:[{cmd,result}], feedback }  // 来自 control-wire(C)
relay         { from, to, chars }                            // 来自 relay-registry(D)
```

- **codex 适配器**:补齐 `item/started`+`item/completed` 的非 agentMessage 类型,转 `tool.*`;**不再剥 payload、不 300 字截断**(给 UI 单独一条不压缩的路径,日志侧维持压缩)。
- **omp 适配器(词表已确认):** `tool_execution_start`(顶层 `{toolCallId, toolName, args, intent}`)→ `tool.start`(`intent` 当卡片标题);`tool_execution_end`(顶层 `{toolCallId, toolName, result.content[].text}`)→ `tool.end`;`message_update.assistantMessageEvent` 里的 `text_delta` → `message.delta`、`toolcall_start/delta/end`(参数流式,`toolcall_end.toolCall={id,name,arguments}`)→ 可选的"参数构建中"指示;`thinking_*` → `reasoning.*`;`turn_start/turn_end`→`turn.*`。**`tool_execution_*` 现被 `compactEvent` 截到 300 字,适配器须从未压缩的原始 message 取数(见下注)。**
- C/D 不经后端:`orchestration` 由 `control-wire` 暴露(它已持有围栏命令 + 回喂),`relay` 由 registry 取。

> 注意:`compactEvent` 的 300 字截断现服务于"日志/调试快照",不能直接放宽影响日志。规范化适配器应从**未压缩的原始 message**(`#handleLine` 解析出的 `message`)取数,而非已 `compactEvent` 的事件——可能需要后端在 emit 前多给一条原始通道,或适配器内重新解析。实现时定。

---

## 8. 组件与交互(Ink + 手搓)

- **Ink 负责**:布局(flexbox/Yoga)、文本流式重渲染(React 状态变更即重画)、键盘(`useInput`)、焦点。
- **手搓负责(Ink 覆盖不到)**:
  - **鼠标**:`mouse.mjs` 启用 SGR 鼠标上报(`\x1b[?1000h`+`\x1b[?1006h`,滚轮 `?1002`),从 stdin 解析点击/滚动事件;维护一张**可点击区域注册表**(label→行列范围),命中即触发:点 agent 卡→切焦点,点工具卡头→展开,点 C/D 条→展开,滚轮→焦点区对话滚动。命中检测坐标从 Ink 测得的布局或手维护的区域映射得到——**这是本期最大的"手搓"风险点**。
  - **退出收尾**:进入时 alt-screen + 关 readline 行模式;退出/崩溃时**务必还原**(`\x1b[?1049l`、关鼠标上报、显示光标)——挂在现有 `shutdown.mjs` 钩子上,保证任何路径(Ctrl-C/异常)都不残留终端污染。

- **键盘**:`↹` 切焦点、`^O` 开会话、`^W` 关、`/`/`@`/`$` 触发提示、`↑↓` 滚动焦点区历史、`^C` 中断当前 turn(沿用现有 SIGINT 矩阵语义)、`Enter` 发送。

---

## 9. 与现有 CLI 的共存 / 降级

- **TTY 交互**:`cli.mjs` 交互分支检测 `stdout.isTTY && !NO_COLOR && !--no-tui`(新 flag),为真则 `startTui(...)`;否则走**现有行式 REPL**(完全不变)。
- **非 TTY / 管道 / `--task` / CI**:一律走现有纯文本路径,**零改动**(`CLI_UI_DESIGN.md §0.2「非 TTY 优雅降级」这条原则仍然成立)。
- **`--no-tui`**:逃生口,强制老 REPL(出问题时可回退)。
- **已定:TTY 交互默认进 TUI**(新主界面);`--no-tui` 回退老 REPL。

---

## 10. 分期与风险

### 分期
- **P1 — 骨架立起来(不依赖后端未知数):**
  - Ink 三区布局 + 右栏 agents(状态/切换/鼠标点击)+ 焦点区头部(B+E)。
  - A 对话流**文本流式**(用现有 `'delta'`/`'status'`,先不做工具卡片)。
  - C/D 折叠条(数据来自 control-wire / relay-registry)。
  - `/` 与 `@` 命令提示(复用 completer)。
  - alt-screen/鼠标 进入与还原、与 shutdown 钩子打通。
  - 老 REPL 降级路径保持。
- **P2 — 富工具调用卡片(依赖后端改造,codex+omp 一起):**
  - §7 规范化事件模型 + codex/omp **两个注册适配器**(去截断 / 去剥离、补 `tool.*`)。
  - `ToolCard` 展开渲染(diff/output/…)。

### 风险与待办
| 项 | 风险 | 处置 |
|---|---|---|
| ✅ ~~omp 工具事件未知~~(已解) | — | 探针已做(§7):omp 发 `toolcall_*` + `tool_execution_start/end`(顶层,带 toolCallId/args/intent/result),足够渲染卡片。剩余仅"去截断 + 写适配器" |
| codex 非 agentMessage item | 当前被主动剥 payload,工具详情拿不到 | 适配器补 `item/started`+`item/completed` 全类型、保留 payload(UI 单独不压缩路径) |
| 鼠标命中检测 | Ink 不暴露组件坐标,手搓区域映射易错(尤其重排/滚动后) | P1 先做"点 agent 卡"这一条最关键的;其余渐进。区域注册表随渲染更新 |
| **CJK 宽度** | 中文按 2 列宽,布局/截断算错会错位 | Ink 的文本测量是否正确处理东亚宽度需验证;不行则引一个 wcwidth 小库(依赖政策已允许) |
| `$` 语义 | 未定义,见 §6 | 写 P2 前必须和用户敲定 |
| 性能 | Ink 全量重渲染在高频流式下可能抖 | synod 规模小,预计无碍;必要时按 session/区域局部化状态、节流 delta |
| 文档一致性 | 老 `CLI_UI_DESIGN.md` 描述行式 UI | 已加顶部修订说明指向本 spec;本 spec 为新 TUI 的准绳 |

---

## 11. 测试策略

- **纯函数单测**:提示引擎(扩展后的 completer)、规范化事件适配器(喂 omp/codex 原始 message 断言产出的规范条目)、鼠标序列解析(喂 SGR 字节断言事件)、命中检测(喂区域表+坐标断言目标)。这些不需真 agent、不需 TTY。
- **组件渲染**:用 `ink-testing-library` 对各组件做快照/交互断言(注入假 store)。
- **集成**:注入 fake backend(现有 `test/helpers/fake-backend.mjs`)驱动一轮多 session + relay,断言 store 产出的时间线;TUI 渲染层用 ink-testing-library 的 `lastFrame()` 断言关键文本出现(strip ANSI 后)。
- **不破坏现有**:非 TTY/`--task`/老 REPL 的现有验收(A1–A5)必须仍全绿——TUI 是新增分支,不动旧路径。
- 全程 TDD(红→绿),与仓库现有 Tier1 风格一致。

---

## 12. 开放问题

头脑风暴阶段的开放问题**均已敲定**:`$` 搁置(§6)/ TTY 默认进 TUI(§9)/ P2 codex+omp 一起(§10)/ 主题固定留接口(§2)/ omp 事件探针已完成(§7)。

实现层面待定的细节(随实现计划展开):鼠标命中检测的具体实现路径、CJK 宽度是否引 wcwidth 小库、`tool_execution_*` "去截断"的具体改法(后端加原始通道 vs 适配器重解析)。

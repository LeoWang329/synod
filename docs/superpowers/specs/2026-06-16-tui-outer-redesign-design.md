# Synod TUI 最外层交互 — 重设计(2026-06-16)

> 写于 2026-06-16。头脑风暴产出,经用户逐屏在可视化 companion 上确认。
> **取代** `2026-06-13-tui-page-design.md` 的 §4 布局细节与"C/D 常驻折叠条"决策;其余(架构=内核之上的前端、注册制适配器、TTY 默认进 TUI、`--no-tui` 降级、工具卡片)**仍然有效,不变**。
> 本次只重做**最外层交互骨架**;配色/卡片视觉/切换手感等细节留作下一轮。

---

## 1. 为什么推翻旧布局(根因)

旧 L3 布局(右 agents 栏 + 焦点区 + 底部 C/D 折叠条 + 输入 + 状态)被用户判为"像坨屎"。逐屏诊断出的真问题:

- **synod 的魂被画成了最看不懂的东西。** C 编排意图 / D relay 是 synod 区别于"开 N 个终端各自聊"的全部理由(agent 自主指挥 mesh、agent 间互灌数据),却被压成焦点区底部两条灰色折叠条,摘要(`3 cmds · ✓codex#1 · ● new`)连作者自己都要停下来问"这在干嘛"。**最值钱的信息 = 屏上最低可读性的元素。**
- **常驻面板堆砌。** 一屏同时塞:右栏 + 焦点区头部 + A 对话 + C 条 + D 条 + 系统条 + 状态栏。没有重点,眼睛无处落。
- **输入框被四边框包成一个"小盒子"**,视觉上不像"主输入",更像一个挂件。

核心结论:**人类主持人大部分时间是在跟某一个 agent 深聊 + 余光感知全场**;编排/转发是基础设施,不是要天天盯的仪表盘。UI 应让"对话"当主角,让 mesh 的存在感**按需、瞬时**地浮现,而不是常驻占地。

---

## 2. 已锁决策(本次)

| # | 维度 | 决策 |
|---|---|---|
| 1 | **输入框** | 钉屏幕最底部、横贯整宽;**只用上下两根通栏横线**夹住输入区(去掉左右边框,不再是四边盒子)。前缀 `[label] ❯`。 |
| 2 | **状态栏** | 输入框**下方**,独立一条细栏(两者分离,各管各的)。右侧挂计数 `N agents · M 待你 · mesh on`。 |
| 3 | **C 编排意图 / D relay** | **删掉**焦点区底部两条常驻折叠条。改为**瞬时面包屑**:只在 agent 真发生编排(开会话 / relay / 转发)那一下,在对话流里淡淡滚一行(如 `· omp#1 开了 codex#1,把这段 diff 转给它复核`),随历史滚走,**绝不常驻**。目的是保留"它背着我干了啥"的透明度,而非提供一个监控面板。 |
| 4 | **agent 栏** | **保留**在右侧,但**瘦身**:去掉每卡的 `▶ out / ◀ in` relay 箭头两行,回归纯"名单 + 状态 + 最后一行"。状态新增 **"待你"** 态(后台 agent 已产出、在等人看结论/回复)。 |
| 5 | **焦点区** | 只剩**干净对话流**:你的话 / assistant 流式正文 / 工具卡 / 偶尔面包屑(决策 3)/ 后台冒泡(决策 6)。头部保留 `● label · model · effort` + `running/turn/本轮耗时`。 |
| 6 | **后台 agent 感知** | **A+B 双管**:① **流内冒泡(proactive)**——后台 agent 跑完 / 出错 / 反过来问你 → 当前对话流底部淡淡冒一行 `↳ codex#1 复核完了,有结论 · ^↹ 去看`;② **状态栏计数(ambient)**——右侧 `N agents · M 待你`。两者与保留的 agent 栏并存:栏=全员花名册,冒泡=主动打断,计数=环境感知。 |

为什么 agent 栏与 A+B 并存不算冗余:三层感知各司其职(花名册 / 主动打断 / 环境数字),用户明确选择保留栏;删的是 C/D 两条**信息密度高且看不懂**的条,不是花名册。

### 2.1 配色面板 — Catppuccin Mocha(已定)

用户在 4 版对比(Tokyonight / Gruvbox / Catppuccin / Mono)中选定 **Catppuccin Mocha**。Ink `<Text color>` 接受 hex(truecolor 终端直出,旧终端自动降到最近 ANSI)。语义角色 → 色值固定如下,实现照填:

| 语义角色 | 用途 | hex |
|---|---|---|
| bg / bg2 | 主背景 / 面板(titlebar·rail·input·status) | `#1e1e2e` / `#181825` |
| border / border-bright | 普通分隔线 / 输入框上下两根通栏线 | `#313244` / `#45475a` |
| text / dim | 默认正文 / 次要·摘要 | `#cdd6f4` / `#6c7086` |
| accent(blue) | label·焦点·提示符·光标块 | `#89b4fa` |
| you(green) | 用户输入标记 `you ❯` | `#a6e3a1` |
| tool(teal) | 工具卡 | `#94e2d5` |
| ok(green) | 成功 / idle / done | `#a6e3a1` |
| warn(peach) | "待你"态 / 计数 / 高亮提示 | `#fab387` |
| breadcrumb | 编排面包屑(瞬时、压低存在感) | `#7f849c` |
| nudge(mauve) | 后台冒泡 `↳ …` | `#cba6f7` |

留主题接口:这套色值集中成一份 theme 映射(细节层定放哪),日后换主题只改映射。

---

## 3. 新布局

```
┌ synod · mesh ───────────────────────────────── 3 sessions ┐  titlebar(细)
│ ┌─ 焦点区(flex)──────────────────┐ ┌ AGENTS ──── ↹切 ┐ │
│ │ ● omp#1  gpt-5·high·~/proj  run·t4·17s │ │ ▎● omp#1   t4   │ │  ← 选中:左竖条高亮
│ │ you ❯ 把 relay 收尾改稳一点            │ │   running·17s   │ │
│ │ assistant 我来看 onTurnComplete…▌      │ │   ● codex#1 t3  │ │
│ │ ▸ ◇ Read  src/relay.mjs    ✓ 47 lines  │ │   待你看结论    │ │  ← 新"待你"态
│ │ ▾ ✎ Edit  src/relay.mjs    ✓ +2 −1     │ │   ✓ omp#2   t1  │ │
│ │     - const chain = task.then(run)     │ │   idle          │ │
│ │     + chain = task.catch(()=>{})       │ │                 │ │
│ │ · omp#1 开了 codex#1,转给它复核 diff   │ │ + ^O 新会话     │ │  ← 面包屑(瞬时)
│ │ ↳ codex#1 复核完了 · ^↹ 去看           │ │ mesh on         │ │  ← 后台冒泡
│ └────────────────────────────────────────┘ └─────────────────┘ │
├────────────────────────────────────────────────────────────────┤  ← 输入框上线(通栏)
│ [omp#1] ❯ 再给 relay 收尾加个超时兜底…▌                          │
├────────────────────────────────────────────────────────────────┤  ← 输入框下线(通栏)
│ ↹切 ^O开 ^W关 /命令 ^C中断 ?帮助        3 agents · 1 待你 · mesh on│  status(细)
└────────────────────────────────────────────────────────────────┘
```

自上而下:titlebar(细)→ body(焦点区 flex | agent 栏 固定宽)→ 输入框(通栏,上下两线)→ 状态栏(细)。

---

## 4. 与当前实现的改动点(基于 `feat/tui-p1` 实际代码)

> 重要:这是**渲染/布局层重排**,内核(session-manager / control-wire / relay-registry / backend / store 的数据)基本不动。fence 数据(`store.fences`)、relay 数据(`store.relays`)、`entries` 时间线**都已存在**,本次主要是把它们**从"底部条"改投到"流内条目"**,以及给 agent 栏/状态栏补几个字段。

| 组件 | 现状 | 改动 |
|---|---|---|
| `components/InputBar.mjs` | 已通栏,但 `borderStyle="single"`(四边盒子) | 改为只留上下边:`borderTop borderBottom`,关 `borderLeft/Right`。视觉=两根通栏线夹输入。`[label] ❯` 前缀保留。hints 浮层照旧在其上方。 |
| `components/StatusBar.mjs` | 已通栏,显示 `● N running · mesh on` | 右侧改/补为 `N agents · M 待你 · mesh on`(总数 + "待你"计数);左侧快捷键补 `?帮助`。 |
| `components/AgentRail.mjs` | 每卡 5 行,含 `▶ out / ◀ in` 两行 relay 箭头(注释"恒 5 行"供鼠标命中) | **删掉 out/in 两行**;卡内容=`●/✓/●待你 label tN` + 状态行(running/idle/**待你**)+ lastLine。卡高变化 → **同步更新 `mouse.mjs` 命中行数推算**。选中态可由四边框改为左竖条高亮(细节层定)。 |
| `components/FocusPane.mjs` | header + entries 时间线 + **C/D 两条 `CollapsibleStrip`** | **删掉两条 `CollapsibleStrip`**(及其 `expandC/expandD` 相关入参与键位 `^G/^T`)。编排/relay 改为时间线里的**面包屑条目**;后台事件为**冒泡条目**。 |
| `store.mjs` | `appendFence` 写 `state.fences[label]`(喂折叠条);relay 写 `state.relays` | 编排/relay 发生时,**额外向发起会话的 `entries` 推一条 `breadcrumb` 条目**(供流内渲染);后台会话 跑完/出错/被问 → 推 `nudge` 条目到**当前焦点**会话流 + 置该后台会话 `status="awaiting"`(驱动 agent 栏"待你"与状态栏计数)。`fences` 旧字段可在 FocusPane 不再消费后清理(`expandC/expandD` 属 app.mjs state,随键位一并去掉)。 |
| `app.mjs` | 键位含 `^G/^T`(展开 C/D)、`^E/↑↓`(选卡) | 去掉 `^G/^T` 与 `expandC/expandD` 状态;`^↹`(或定一个键)= 跳到"待你"的后台 agent;其余键位(Tab 切焦点、^O/^W、^C、↑↓ 选卡、^E 展卡)保留。 |
| `components/CollapsibleStrip.mjs` | C/D 专用 | 本布局不再使用;可删或留作他用(细节层定)。 |

新增渲染:`entries` 时间线条目类型扩 `breadcrumb`(瞬时面包屑,dim 单行)、`nudge`(后台冒泡,紫色单行 + 可点/快捷跳转)。两者都进**同一条有序时间线**,与工具卡同级。

---

## 5. 不变的部分(继续沿用 2026-06-13 spec)

- 架构:TUI 是挂在现有内核之上的前端,接口不破;非 TTY/`--task`/管道走原纯文本路径不变。
- 输入仍走现有 `dispatch(line,{source:"human"})`;`/` `@` 提示复用 completer。
- 事件适配器注册制(omp/codex)、工具卡片渲染(P2 成果)原样保留。
- TTY 默认进 TUI、`--no-tui` 降级、shutdown 钩子还原终端 — 不变。
- 主题固定一套留接口 — 不变;**配色已定为 Catppuccin Mocha**(色值见 §2.1)。

---

## 6. 留给下一轮(细节层)的开放项

- 配色/主题细化(tokyonight 风),整体观感打磨。
- 工具卡 / 面包屑 / 冒泡 三类条目的具体视觉与图标、措辞。
- agent 栏切换手感:键盘(Tab 循环 / `^↹` 直达待你)+ 鼠标点击命中(卡高变化后的区域映射)。
- **"待你"态的触发判定**:哪些算"待你"——turn 结束且有新产出?relay 入站等待?需要在 store 侧定清楚规则(避免 idle 与 awaiting 抖动)。
- 面包屑措辞模板(开会话 / relay 建立 / 转发消息 各一句)。
- SystemStrip(当前在输入框上方显示最近 3 条系统消息)去留:是否并入面包屑流。

---

## 7. 测试影响

- 受影响单测:`InputBar` / `StatusBar` / `AgentRail` / `FocusPane` 渲染快照、`mouse.mjs` 命中(卡高变化)、`store` 的 breadcrumb/nudge/awaiting 新逻辑。全程 TDD(红→绿)。
- 不破坏:非 TTY/`--task`/老 REPL 验收必须仍全绿(本次只动渲染层)。
```

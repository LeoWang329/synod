# Superpowers 开发链(flow 套件)

把 superpowers 的开发工作流(头脑风暴 → spec → 计划 → subagent 开发 → review)编码成 synod flow。
心智:**JS 当导演、agent 当演员**——确定性 JS 骨架做编排,每个语义判断降解为「一个可解析记号」或「一次人输入」,JS 只做 `if` 和计数、不"理解"。

## 怎么跑

**整体(一键全链):**

```
/flow superpowers {"topic":"给 CLI 加个 --version 旗标","gates":"all"}
```

**单段(分开跑 / 崩了重跑):**

```
/flow superpowers/brainstorm-spec  "主题"
/flow superpowers/spec-to-plan     "<spec 全文>"
/flow superpowers/execute-plan     {"planText":"### Task 1: ...","gates":"all"}
/flow superpowers/final-review
```

入口约定:目录 `superpowers/` + `index.mjs` ⇒ flow 名 = `superpowers`;子 flow = `superpowers/<文件名>`。

## 串法(父 flow `index.mjs`)

父 flow 用 `runWorkflow` 顺序串 4 段,**返回值接力**(spec → plan → diff),接缝按 `gates` 插人审:

```
① brainstorm-spec ──spec──▶ ② spec-to-plan ──plan──▶ ③ execute-plan ──diff──▶ ④ final-review
```

`gates`: `none`(全自动) / `final`(只最后审) / `all`(每接缝人审,首测推荐)。

## 各 flow 职责与输入

| flow | 输入 | 干什么 | 角色 |
|---|---|---|---|
| `superpowers`(index) | `{topic, gates?, testCmd?, maxTurns?}` | 编排 4 段 + gates | — |
| `superpowers/brainstorm-spec` | `{topic, maxTurns?}` | 两把钥匙(`<<<SPEC>>>` 记号 + 人 accept)产 spec | codex + 人 |
| `superpowers/spec-to-plan` | `{specText}` | 产分 task 的 TDD 计划(段头 `### Task N:`),人改稿 | codex + 人 |
| `superpowers/execute-plan` | `{planText, testCmd?, gates?}` | 逐 task `backtrack`:写 → 测 → 审 → 不过回退 | deepseek 写 / codex 审 |
| `superpowers/final-review` | `{testCmd?}` | 审全量 `git diff`,不过让 deepseek 修(≤2 轮) | codex 审 / deepseek 修 |

## 分开跑的代价

父 flow 自动接力产物;单跑时**上游产物要自己喂**——`spec-to-plan` 要 `specText`、`execute-plan` 要带 `### Task N:` 段头的 `planText`。`brainstorm-spec` / `final-review` 无上游依赖,单跑最方便。配合 `/resume <runId>` 可从中断处续跑。

---

详细设计:[`docs/superpowers/specs/2026-06-21-superpowers-dev-flow-design.md`](../../docs/superpowers/specs/2026-06-21-superpowers-dev-flow-design.md)。
flow 创作规则:[`docs/FLOW_AUTHORING.md`](../../docs/FLOW_AUTHORING.md)。

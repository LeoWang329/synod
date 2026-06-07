# 两个地基 — 开工 Checklist(带角色分工)

> 把 [`WORKFLOW_ENGINE_TDD.md`](WORKFLOW_ENGINE_TDD.md) 与 [`AGENT_ORCHESTRATION_TDD.md`](AGENT_ORCHESTRATION_TDD.md) 的两条公共地基拆成可执行细任务。
> 起草 2026-06-07。状态:**执行中**。

## 角色分工

| 角色 | 谁 | 职责 |
|---|---|---|
| **规划 / 协调 / 验收** | Claude Code(我) | 拆任务、派活、监控、**亲自跑 `npm test` + 查 `git diff` 验产物**、把关闭环 |
| **开发** | deepseek-v4-pro(omp 后端,`write:true`) | 按任务写代码 + 测试 |
| **审核** | codex(`write:false`,只读) | 审代码与测试质量,挑问题 |

## 编排协议(每个任务的闭环)

```
我:写任务规格(目标 + 边界 + 验收)
 → deepseek 开发(write,非阻塞派发,短超时轮询)
 → 我:git diff 看产物 + 亲自跑 npm test          ← 不依赖回传文本
 → codex 审核(只读,挑问题)
 → 有问题 → 回 deepseek 修 → 重审;无问题 + 测试绿 → 我验收,进下一任务
```

**运维约定**(踩过的坑):
- deepseek 模型串用 `deepseek/deepseek-v4-pro`(provider 限定);开发会话 `write:true`、effort `xhigh`。
- 派活 `wait:false` + 短超时 `agent_bridge_wait` 轮询;**产物以 `git diff` / 跑测试为准**,不信回传全文。
- 不 `pkill omp`;清理用 `close_session`。daemon 若重启冲掉会话:文件已落盘,查盘补"还差的部分",不从头来。
- 每个任务 deepseek 都要**报告:改了哪些文件 + 自跑 `npm test` 结果**。

---

## 地基 1 · Flow 测试替身(`test/helpers/fake-backend.mjs` + `FakeSession`)

> 这是所有 flow 测试(F0–F7)的前提。纯测试基建,**不碰 `src/` 生产代码**,风险最低 → 先做。

- [x] **T1.1 抽取(dev: deepseek / review: codex)** ✅ codex OK,npm test 35 pass:把 `makeFakeOmpProc` 从 `test/backend.contract.test.mjs` 抽到新建 `test/helpers/fake-backend.mjs` 并 `export`;原测试改为 import 它。**纯重构、零行为变化**。验收:`npm test` 仍全绿,`backend.contract.test.mjs` 断言不变,未碰 `src/`。
- [x] **T1.2 会话级 fake(dev / review)** ✅ codex 审出 5 处不对齐→deepseek 修→codex 复审 OK,npm test 43 pass:在同文件加 `FakeSession`(对齐真实 `Session` 的**消费侧** API:`send(msg,{wait})→文本`、`result()`、`close()`、`on('delta'|'status'|'error',cb)`、`summary()`)与工厂 `fakeOpenBackend({deltas?, text?, failPrompt?, reuse?})`。新增 `test/helpers/fake-backend.test.mjs` 自测:emit deltas、`send(wait)` resolve 累计文本、`close()` 置标志、复用会话不重开。验收:自测绿,`npm test` 全绿。
- [x] **T1.3 契约注释(dev / review)** ✅ 89 行 JSDoc 契约,npm test 43 pass:在 `fake-backend.mjs` 顶部用注释写明 `FakeSession` 契约(让 F1 的 `agent()` 原语照此对接)。验收:codex 确认契约与 `src/backend.mjs` 真实 Session 消费面一致。

**地基 1 整体验收**:`npm test` 全绿;`FakeSession` 接口与真实 Session 消费面对齐并有注释;backend 契约测试行为不变。

---

## 地基 2 · 编排 R0(`cli.mjs` 可注入 + 抽 `session-manager`)

> 依赖地基 1(T2.4 要用 `fakeOpenBackend`)。这是改 `cli.mjs` 的重构,**characterization-first**。

- [ ] **T2.1 刻画测试先行(dev: deepseek / review: codex)**:在 `scripts/acceptance.mjs` 加用例锁现状(`doctor()` skip-if-missing):① 单会话发消息→拿到输出;② `@label` 定向 + `@all` 广播;③ `/use` 切换;④ `Ctrl-D` 退出**无残留子进程**。**这些对当前代码应全过**(锁行为)。验收:有 agent 时新用例全过。
- [ ] **T2.2 入口可注入(dev / review)**:把 `cli.mjs` 入口重构成 `main({ openBackend = 真实, stdin = process.stdin, stdout = process.stdout } = {})`,**默认行为不变**。验收:`npm test` + acceptance 全绿,手动 `node src/cli.mjs` 行为不变。
- [ ] **T2.3 抽 session-manager(dev / review)**:抽出 `src/session-manager.mjs`——`open / enqueue / get / list / closeAll`,**含事件接线**(lineBuf、sendQueue、`status`→flush→重绘 prompt);`cli.mjs` 改为调用它,`openBackend` 经注入传入。验收:行为不变,刻画测试仍绿。
- [ ] **T2.4 单元测试(dev / review)**:新增 `test/session-manager.test.mjs`,注入 `fakeOpenBackend`(来自地基 1),测 open/enqueue/list/closeAll **及事件接线**(delta→lineBuf 输出、status→flush)。验收:单元绿,`npm test` 全绿。

**地基 2 整体验收**:刻画测试 + 新单元测试全绿;`cli.mjs` 对外行为不变;会话管理(含事件接线)可注入 fake 单测。

---

## 顺序与依赖

```
地基1: T1.1 → T1.2 → T1.3
                       ↓ (fakeOpenBackend 就绪)
地基2: T2.1(刻画) → T2.2(注入) → T2.3(抽manager) → T2.4(单测,用 fake)
```

## 进度

> 由我(Claude Code)在每轮闭环后更新此处。
> - **地基 1 ✅ 全部完成**(T1.1/T1.2/T1.3;codex 已审;`npm test` 43 pass)。新增 `test/helpers/fake-backend.mjs`(makeFakeOmpProc + FakeSession + fakeOpenBackend + 契约注释)、`test/helpers/fake-backend.test.mjs`。
> - **地基 2 ⏸ 暂停**(改 `src/cli.mjs`,且 T2.1 刻画测试依赖真 agent)。**等 agent-bridge daemon 稳定(0.6.0 升级完成)后再开工**。任务 #4–#7 处于 pending。

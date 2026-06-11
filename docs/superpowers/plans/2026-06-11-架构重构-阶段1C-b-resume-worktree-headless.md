# 架构重构(阶段 1C-b · resume + RunWorkspace worktree 写隔离 + headless 断点)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐 Task 执行本计划。每个 Step 用 checkbox(`- [ ]`)跟踪。
> 本仓也可沿用三方闭环(deepseek 开发 / codex 只读审+实跑 / Claude Code 验收,见 `docs/HANDOFF.md`)。

**Goal:** 在 1C-a 交付的 per-run 目录与确定性 step key 之上,交付**中断恢复刚需**的三件套:① **workflow step 级 resume**(读 `run.log.jsonl`,前缀匹配的 step 直接回放 logged 输出不开 agent,第一个不匹配处起全部真跑;`synod resume <runId>` + REPL `/resume <runId>`);② **RunWorkspace**(每个 write 任务一个 git worktree 隔离,收尾干净自动合、冲突留人,非 git 拒绝);③ **headless 人在环断点**(`!stdin.isTTY`||`--headless` 下 `approve()`/`reviseWithHuman()` 不等 stdin,写 `checkpoint.json`、完整打印待审内容、退出码 **5**,人回来 resume 续答)。落地后 kill 掉跑一半的 flow 能 `synod resume` 从断点续完;两个 write agent 并行改同一仓库不踩;CI 里遇 approve 不再永久挂死。

**Architecture:** ① 新增 `src/flow/checkpoint.mjs`(读写 `~/.synod/runs/<runId>/checkpoint.json` + `AwaitingHuman` 错误与退出码 5 常量)、`src/flow/replay.mjs`(`parseRunLog` 把 run.log.jsonl 解析为有序已完成 step + `prepareResume` 合并 checkpoint)。② logger 的 `shortHash`(1C-a 产物)提升为模块级导出供重放对账复用;runtime 在 run-state 上挂 `replay` 计划 + `replayStep(runId,{node,input})` 助手,五原语在入口先问重放、命中即回放 logged 输出。③ 新增 `src/run-workspace.mjs`(L2,挨着 SessionPool):`acquire({runId,name})` 用 `git worktree add` 建隔离工作区 + 分支 `synod/<runId>/<name>`,agent 会话 cwd 指向之;`finalize` 逐分支自动合回起始分支、冲突保留留人。④ headless 判定由入口算出经 runtime 注入 approve;approve headless 下写 checkpoint + emit `onApprovalNeeded`(钩子执行归 1D,本计划只 emit)+ 抛 `AwaitingHuman` → flow.main 退出码 5。

**Tech Stack:** Node 20+ 零三方依赖;git 操作用 `node:child_process` 的 `spawnSync("git", …)`(同步天然串行,免并发 git 竞态);`node:async_hooks`/`node:crypto`/`node:fs` 等内置随便用;`node --test` + `test/helpers/fake-backend.mjs`;git worktree 类测试用 `mkdtemp` 临时 git 仓库(`execSync git init`),本计划给出完整 helper。

---

## Scope 与基线

**Spec:** `docs/V1_REVIEW_AND_ARCHITECTURE.md` §4.11(RunWorkspace:worktree 布局 `~/.synod/worktrees/<repo-hash>/<runId>-<name>/`、分支 `synod/<runId>/<name>`、只读不建、收尾自动合/冲突留人、非 git 拒绝、残留治理)、§4.12(持久化与恢复:确定性 step key = 原语调用序号 + 节点名 + 输入 hash、前缀匹配回放、`checkpoint.json`、`synod resume <runId>` / `/resume`、`synod runs` 状态列)、§4.13(headless:`!stdin.isTTY`||`--headless`;approve/reviseWithHuman 写断点 + 完整打印待审内容 + 退出码 5;`onApprovalNeeded` 触发点设计为可挂事件,1D 接线)、§5 路线图 1C 段。排期权威见 `docs/V1.md` 看板「阶段 1C」 + §5 开发工法(5.1 TDD、5.2 验证命令、5.5 提交规范)。

**本计划不含:**
- 通知钩子的**执行**(`onDone`/`onError`/`onApprovalNeeded` 命令钩子 + 终端铃)→ 阶段 1D。本计划只在 approve 断点处 **emit `onApprovalNeeded` 事件**,留好挂点,不实现钩子命令的 spawn/环境变量注入。
- team 恢复(黑板 + 摘要喂 leader)→ 阶段 2。
- 退出码全面规范化(`--json`/`NO_COLOR`/退出码字典)→ 阶段 3。**但退出码 5(awaiting human)本计划即落地**。
- 嵌套 `runWorkflow` 子 run 的跨目录联动重放:resume 只对**顶层 run** 强保证;子 run(独立 runId、独立 per-run 目录)在 resume 时按"无重放计划"真跑(诚实降级,见风险表)。

**基线依赖(1C-a 必须全部落地后开工):** 本计划**直接引用** 1C-a 计划(`docs/superpowers/plans/2026-06-11-架构重构-阶段1C-a-R2整改与flow并发取消.md`)定义的产物,符号名/字段名/路径以 1C-a 计划文本为准,不得另行发明:

| 1C-a 产物 | 形态 | 出处(1C-a) |
|---|---|---|
| per-run 目录 | `~/.synod/runs/<runId>/`,内含 `run.log.jsonl` + `artifacts/` + `latest`(win32 降级 `latest.txt`) | Task 12/13 |
| logger 工厂 | `createLogger({ fs, clock, runsRoot })`;`pathsFor(runId)` / `ensureRunDir(p)` / `writeJSONL(runId, obj)` / `_seqByRun` / `nextSeq(runId)` / `shortHash(s)` | Task 12 Step 3 |
| 确定性 key | step 行携带 `key = \`${seq}:${node}:${shortHash(input)}\``;`shortHash` = `sha1(input).hex.slice(0,8)`;step 行字段 `event/runId/stepId/node/type/attempt/ts/key/durationMs` + `input`\|`inputRef` / `output`\|`outputRef` / `error` / `parentRunId` | Task 12 Step 3 ⑤ |
| runs 命令 | `src/runs.mjs` 的 `listRuns(runsRoot)` → `[{ runId, startedAt, status }]`,status ∈ `done`/`failed`/`running`,按 startedAt 降序;`synod --runs` 子命令 | Task 13 |
| 取消装配 | runtime `getRunState(runId)` run-state `{ reusedSessions, keyChains, disposed, lastSinkError, controller }`;`signalFor(runId)` / `abortRun(ctx)`;`createRuntime` 收 `signal`/`runsRoot` | Task 8/12 |
| abortable | `src/flow/api/abortable.mjs` 的 `raceAbort(promise, signal, onAbort)` / `abortError()` | Task 8 |
| 原语 getSignal | `createAgent`/`createAgentLoop`/`createBash`/`createApprove` 收 `getSignal`;`agentOnce` 取 `const signal = opts.signal ?? getSignal?.(ctx.runId)` | Task 8/9 |
| InputRouter | `src/input-router.mjs` 的 `createInputRouter({stdin,stdout})` → `{ rl, onLine, claim, release, onSigint, pause, resume, close }` | Task 10 |
| current-run | `runWithRuntime(rt, fn)` / `getCurrentRuntime()` / `getCurrentRuntimeRaw()`(AsyncLocalStorage) | Task 7 |
| cli runFlow | cli.mjs `main` 内 `runFlow(flowArgv)` 包裹,注 `flowIo`(`question=(p,{signal})=>router.claim({prompt:p,signal})`)+ `signal: ctrl.signal`;`_activeFlows`/`_pendingFlows`;`flowsRoot`;`config` | Task 11 |
| flow.main 签名 | `main({ argv, stdout, stderr, openBackend, workflowsRoot, cwd, config, io, signal, runsRoot, fs })`;`parseFlowArgs` 支持 `--`;`discoverFlows(dir)` → `{ flows, errors }`;run 路径**直接 `loadFlow`**;`writeLatestPointer(runsRoot, runId)`;默认 `runsRoot = ~/.synod/runs` | Task 11/12/13 |
| revise 透传 | `createReviseWithHuman({ agent, approve, logger })`,`reviseWithHuman(ctx, draft, opts)` 把 `opts` 原样透传内部 `agent()`(`{ ...opts, prompt, reuse: true }`),不再硬塞默认 agent | Task 4 |

**开工检查(动笔写 Task 1 前,逐条断言 1C-a 产物存在):**

```bash
# 1) per-run 目录与确定性 key 已落地
git grep -n "function shortHash" src/flow/logger.mjs
git grep -n "function pathsFor"  src/flow/logger.mjs
git grep -n "function nextSeq"   src/flow/logger.mjs
git grep -n "createLogger({ fs, clock, runsRoot })" src/flow/runtime.mjs
# 2) runs.mjs + --runs 子命令
test -f src/runs.mjs && git grep -n "export function listRuns" src/runs.mjs
git grep -n "args.runs" src/cli.mjs
# 3) 取消装配
git grep -n "function signalFor" src/flow/runtime.mjs
git grep -n "function abortRun"  src/flow/runtime.mjs
git grep -n "controller" src/flow/runtime.mjs
# 4) abortable + InputRouter + current-run(ALS)
test -f src/flow/api/abortable.mjs && git grep -n "export function raceAbort" src/flow/api/abortable.mjs
test -f src/input-router.mjs && git grep -n "export function createInputRouter" src/input-router.mjs
git grep -n "runWithRuntime" src/flow/current-run.mjs
# 5) flow.main 已接 runsRoot/io/signal、discoverFlows 返回 {flows,errors}
git grep -n "runsRoot" src/flow.mjs
git grep -n "{ flows, errors }" src/flow/loader.mjs || git grep -n "errors.push" src/flow/loader.mjs
```

**任一断言失败 → 停工**:说明 1C-a 尚未全部落地,本计划无地基。先把 1C-a 执行完(`npm test` 全绿 + e2e 不回归)再回来。

**分支建议:** `flow-1c-b`(从 1C-a 合并后的 main 切出)。

**硬约束(违者打回):**
1. **零第三方依赖**:仅 `node:*` 内置。git 操作用 `node:child_process` 的 `spawnSync("git", args, { cwd })`(仓库现有 backend 探针即 `spawnSync` 风格,沿用;flow 内已有 `node:child_process` 用法,见 `src/flow/api/bash.mjs`)。
2. **Windows 兼容横切**:每个含进程 / 路径 / 退出码 / headless 的 Task 写明 win32 行为(分支或显式降级,不得静默坏)。本计划三处 win32 显式说明:① worktree 路径全用 `node:path` 拼接、不依赖 symlink(git worktree 本身跨平台),`git worktree`/`merge` 退出码跨平台一致;② 退出码 5 在 win32 由 `process.exit(5)` 原样返回(Windows 进程退出码 0–255 透传);③ headless 判定 `!stdin.isTTY` 在 win32 行为一致(管道/重定向 isTTY 为 undefined → falsy → headless)。
3. **flow 确定性要求向作者明示**:resume 前缀匹配要求 flow 控制流确定(别用 `Date.now()`/`Math.random()` 决定走哪个分支)。Task 12 在 `docs/FLOW_AUTHORING.md` 增补「resume 与确定性」节,给出完整文档文本。
4. **主持人模式零回归**:现有 e2e A1–A8(+E1–4)必须全过;1C-a 的 `test:e2e-shutdown` S1/S2、`test:e2e-flow` 不回归;`/open /use /sessions @label @all /relay /unrelay /relays /flow /exit` 行为不变(新增只读子命令 `synod resume`、REPL `/resume`,以及 `synod runs` 状态列文案增强)。
5. **每 Task `npm test` 全绿才 commit**;commit message 中文 conventional commits(`feat(resume):` / `feat(workspace):` / `feat(headless):` / `feat(runs):` / `docs(flow):`)。
6. **resume 不开 agent**:命中重放的 step **绝不**调用 `openBackend` / 不 spawn 子进程 / 不 exec bash —— 这是 resume 的第一不变量,每个原语的重放分支在真工作之前短路返回,测试用"openBackend 抛错"的注入断言它没被调用。

## File Structure

```
src/flow/checkpoint.mjs        新增 — checkpoint.json 读写 + AwaitingHuman 错误 + EXIT_AWAITING_HUMAN=5
src/flow/replay.mjs            新增 — parseRunLog(run.log.jsonl → 有序已完成 step) + prepareResume(合并 checkpoint)
src/run-workspace.mjs          新增 — RunWorkspace(git worktree acquire/finalize/非git拒绝/残留扫描)
src/flow/logger.mjs            修改 — shortHash 由 createLogger 闭包内提升为模块级 export(作用域提升,行为不变)
src/flow/runtime.mjs           修改 — run-state 挂 replay 计划;replayStep 助手;createCtx 透传 runId;
                                      headless/events/runWorkspace 注入;acquireWorkspace/finalizeWorkspaces;
                                      原语工厂传 getReplay
src/flow/api/agent.mjs         修改 — agentOnce 入口问重放命中即回放;write+workspace → worktree cwd;
                                      sessionKeyOf 纳入 workspace
src/flow/api/agentLoop.mjs     修改 — 会话改惰性开;每 turn 问重放;命中回放不开 agent
src/flow/api/bash.mjs          修改 — 入口问重放;命中回放 logged {stdout,stderr,code} 不 exec
src/flow/api/approve.mjs       修改 — 入口问重放(回放 logged 决定);headless 写断点 + emit onApprovalNeeded + 抛 AwaitingHuman
src/flow.mjs                   修改 — main 接 resume/headless/runWorkspace;启动写 checkpoint;收尾 finalize 摘要;
                                      AwaitingHuman → 退出码 5;parseFlowArgs 加 --headless
src/cli.mjs                    修改 — `synod resume <runId>` 子命令;runFlow 注 headless/runWorkspace;resumeFlow 桥接 REPL
src/repl-dispatch.mjs          修改 — `/resume <runId>` 命令
src/runs.mjs                   修改 — listRuns 读 checkpoint 增强状态列 done/failed@<node>/awaiting-approval + worktrees
docs/FLOW_AUTHORING.md         修改 — 增补「8. resume 与确定性」节
test/flow.checkpoint.test.mjs            新增
test/flow.replay.test.mjs                新增
test/flow.resume.agent.test.mjs          新增
test/flow.resume.bash-approve.test.mjs   新增
test/flow.headless.test.mjs              新增
test/run-workspace.test.mjs              新增
test/flow.workspace.test.mjs             新增
test/runs.test.mjs                       追加(1C-a 已建)
test/flow.resume.integration.test.mjs    新增
test/helpers/git-repo.mjs                新增 — mkdtemp 临时 git 仓库 helper(worktree 测试共用)
```

---

# Part A · 持久化与恢复(resume + checkpoint)

> Part A 全部 TDD。Task 1→7。先做断点文件与重放解析两块纯数据地基(可脱离 runtime 单测),再装配进 runtime 与五原语,最后接 `synod resume` / `/resume` 入口与 `synod runs` 状态列。

---

### Task 1: `src/flow/checkpoint.mjs` — 断点文件 + AwaitingHuman + 退出码 5

断点文件是尸检与 resume 的共同入口(§4.12-4):headless 人在环退出与异常中断都写它(停在哪个 step、待审内容、worktree 清单)。它也承载 resume 复跑所需的 `flowName`/`input`/`cwd`——硬 kill(SIGKILL)写不进文件,故 flow 启动即写一份 `status:"running"` 的初始 checkpoint。

**Files:**
- Create: `src/flow/checkpoint.mjs`
- Test: `test/flow.checkpoint.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/flow.checkpoint.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCheckpoint, readCheckpoint, EXIT_AWAITING_HUMAN, awaitingHumanError, isAwaitingHuman,
} from "../src/flow/checkpoint.mjs";

function runsRootTmp() {
  return mkdtempSync(join(tmpdir(), "synod-ckpt-"));
}

test("退出码常量 = 5;awaitingHumanError 可被 isAwaitingHuman 识别", () => {
  assert.equal(EXIT_AWAITING_HUMAN, 5);
  const e = awaitingHumanError({ runId: "r1", node: "approve" });
  assert.equal(e.name, "AwaitingHuman");
  assert.equal(e.runId, "r1");
  assert.equal(e.exitCode, 5);
  assert.equal(isAwaitingHuman(e), true);
  assert.equal(isAwaitingHuman(new Error("nope")), false);
});

test("writeCheckpoint 建 per-run 目录并写 checkpoint.json;readCheckpoint 取回", () => {
  const root = runsRootTmp();
  writeCheckpoint(root, "run-a", {
    flowName: "build", input: { x: 1 }, cwd: "/proj", status: "running",
  });
  const p = join(root, "run-a", "checkpoint.json");
  assert.ok(existsSync(p));
  const got = readCheckpoint(root, "run-a");
  assert.equal(got.runId, "run-a");
  assert.equal(got.flowName, "build");
  assert.deepEqual(got.input, { x: 1 });
  assert.equal(got.status, "running");
  assert.equal(typeof got.startedAt, "number");
  assert.equal(typeof got.updatedAt, "number");
});

test("writeCheckpoint 二次调用是合并补丁:保留 startedAt/flowName,更新 status+stoppedAt", () => {
  const root = runsRootTmp();
  writeCheckpoint(root, "run-b", { flowName: "f", input: null, cwd: "/p", status: "running" });
  const first = readCheckpoint(root, "run-b");
  writeCheckpoint(root, "run-b", {
    status: "awaiting-approval",
    stoppedAt: { node: "approve", type: "approve", inputHash: "abc12345" },
    pending: { content: "ready?" },
  });
  const got = readCheckpoint(root, "run-b");
  assert.equal(got.startedAt, first.startedAt, "startedAt 不被覆盖");
  assert.equal(got.flowName, "f", "已有字段不被补丁抹掉");
  assert.equal(got.status, "awaiting-approval");
  assert.equal(got.stoppedAt.node, "approve");
  assert.equal(got.pending.content, "ready?");
  assert.ok(got.updatedAt >= first.updatedAt);
});

test("readCheckpoint:不存在 → null;坏 JSON → null(不抛)", () => {
  const root = runsRootTmp();
  assert.equal(readCheckpoint(root, "ghost"), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.checkpoint.test.mjs`
Expected: FAIL — `Cannot find module '../src/flow/checkpoint.mjs'`

- [ ] **Step 3: 实现**

```js
// synod/src/flow/checkpoint.mjs — 断点文件(resume 与尸检的共同入口,§4.12-4)。
//
// 落点:~/.synod/runs/<runId>/checkpoint.json。字段:
//   { runId, flowName, input, cwd, status, startedAt, updatedAt,
//     stoppedAt:{node,type,inputHash}|null, pending:{content}|null,
//     error:string|null, worktrees:[{name,branch,path}] }
//   status ∈ "running" | "done" | "failed" | "awaiting-approval"
//
// 设计:writeCheckpoint 是"合并补丁"——读旧文件浅合并新字段,故 flow 启动写一份
// running 初始档(含 flowName/input/cwd,供 resume 复跑;硬 kill 也留得住),
// 后续 headless 断点/异常只补 status/stoppedAt/pending/error。同步 fs:checkpoint
// 写在原语边界(approve)与 flow 收尾,量极小,同步免去 async 传染。
import fs from "node:fs";
import path from "node:path";

/** 退出码 5 = awaiting human(§4.13;阶段 3 退出码字典正式收编,本计划先落地)。 */
export const EXIT_AWAITING_HUMAN = 5;

/** 构造"等人"专用错误:flow.main 据此返回退出码 5。 */
export function awaitingHumanError({ runId, node }) {
  const e = new Error(
    `awaiting human at node "${node}" (run ${runId}) — resume with: synod resume ${runId}`,
  );
  e.name = "AwaitingHuman";
  e.runId = runId;
  e.node = node;
  e.exitCode = EXIT_AWAITING_HUMAN;
  return e;
}

export function isAwaitingHuman(err) {
  return Boolean(err) && err.name === "AwaitingHuman";
}

function checkpointPath(runsRoot, runId) {
  return path.join(runsRoot, runId, "checkpoint.json");
}

/** 读取 checkpoint;不存在或坏 JSON → null(尽力而为,绝不抛)。 */
export function readCheckpoint(runsRoot, runId) {
  try {
    const raw = fs.readFileSync(checkpointPath(runsRoot, runId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 合并写 checkpoint。首次写补 runId/startedAt;每次写更新 updatedAt。
 * patch 里出现的键覆盖旧值;未出现的键保留(浅合并)。
 */
export function writeCheckpoint(runsRoot, runId, patch = {}) {
  const dir = path.join(runsRoot, runId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* 目录可能已存在 */ }
  const prev = readCheckpoint(runsRoot, runId) ?? {};
  const now = Date.now();
  const next = {
    runId,
    startedAt: prev.startedAt ?? now,
    ...prev,
    ...patch,
    runId, // 锁死 runId 不被 patch 覆盖
    updatedAt: now,
  };
  fs.writeFileSync(checkpointPath(runsRoot, runId), JSON.stringify(next, null, 2) + "\n");
  return next;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/flow.checkpoint.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/flow/checkpoint.mjs test/flow.checkpoint.test.mjs
git commit -m "feat(resume): checkpoint.json 读写 + AwaitingHuman 错误与退出码 5 常量"
```

---

### Task 2: `src/flow/replay.mjs` — run.log 重放解析 + resume 准备

把 1C-a 的 `run.log.jsonl` 解析成**有序的已完成 step 列表**(step:started/step:succeeded 按 `stepId` 配对,只收 succeeded;遇 step:failed 即边界)。每条携带 `node`、`hash`(从 1C-a 的 `key` 段 `seq:node:hash8` 抽出第三段)、`output`(内联 `output` 或读 `outputRef` artifact 全路径)、原始 `entry`(供 bash/approve 取 `code`/`stderr`/`accepted`/`aborted` 等)。`prepareResume` 再合并 checkpoint 给出 `{ flowName, input, cwd, steps }`。

**Files:**
- Create: `src/flow/replay.mjs`
- Test: `test/flow.replay.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/flow.replay.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunLog, prepareResume } from "../src/flow/replay.mjs";
import { writeCheckpoint } from "../src/flow/checkpoint.mjs";

function makeRun(lines) {
  const root = mkdtempSync(join(tmpdir(), "synod-replay-"));
  const runId = "run-x";
  const dir = join(root, runId);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "run.log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { root, runId, dir };
}

test("parseRunLog:succeeded step 按日志顺序收集,node/hash/output 抽取正确", async () => {
  const { root, runId } = makeRun([
    { event: "step:started",   runId: "run-x", stepId: "s1", node: "omp",  type: "agent", attempt: 1, ts: 1, key: "0:omp:11111111" },
    { event: "step:succeeded", runId: "run-x", stepId: "s1", node: "omp",  type: "agent", attempt: 1, ts: 2, durationMs: 1, key: "0:omp:11111111", input: "p1", output: "OUT1" },
    { event: "step:started",   runId: "run-x", stepId: "s2", node: "bash", type: "bash",  attempt: 1, ts: 3, key: "1:bash:22222222" },
    { event: "step:succeeded", runId: "run-x", stepId: "s2", node: "bash", type: "bash",  attempt: 1, ts: 4, durationMs: 1, key: "1:bash:22222222", input: "ls", output: "a\nb", code: 0 },
  ]);
  const { steps, sawFailure } = await parseRunLog(join(root, runId));
  assert.equal(sawFailure, false);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.node), ["omp", "bash"]);
  assert.deepEqual(steps.map((s) => s.hash), ["11111111", "22222222"]);
  assert.equal(steps[0].output, "OUT1");
  assert.equal(steps[1].entry.code, 0);
});

test("parseRunLog:step:failed 标记边界,失败 step 不进 steps", async () => {
  const { root, runId } = makeRun([
    { event: "step:started",   runId: "run-x", stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 1, key: "0:omp:aaaaaaaa" },
    { event: "step:succeeded", runId: "run-x", stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 2, key: "0:omp:aaaaaaaa", output: "OK" },
    { event: "step:started",   runId: "run-x", stepId: "s2", node: "omp", type: "agent", attempt: 1, ts: 3, key: "1:omp:bbbbbbbb" },
    { event: "step:failed",    runId: "run-x", stepId: "s2", node: "omp", type: "agent", attempt: 1, ts: 4, key: "1:omp:bbbbbbbb", error: { message: "boom" } },
  ]);
  const { steps, sawFailure, failedNode } = await parseRunLog(join(root, runId));
  assert.equal(steps.length, 1, "只 s1 完成");
  assert.equal(sawFailure, true);
  assert.equal(failedNode, "omp");
});

test("parseRunLog:大输出走 outputRef artifact → 读回全文", async () => {
  const { root, runId, dir } = makeRun([]);
  const big = "Z".repeat(500);
  const refPath = join(dir, "artifacts", "s9.output.txt");
  writeFileSync(refPath, big);
  writeFileSync(join(dir, "run.log.jsonl"),
    JSON.stringify({ event: "step:started",   runId, stepId: "s9", node: "omp", type: "agent", attempt: 1, ts: 1, key: "0:omp:cccccccc" }) + "\n" +
    JSON.stringify({ event: "step:succeeded", runId, stepId: "s9", node: "omp", type: "agent", attempt: 1, ts: 2, key: "0:omp:cccccccc", input: "p", outputRef: refPath }) + "\n");
  const { steps } = await parseRunLog(dir);
  assert.equal(steps[0].output, big, "outputRef 被读回全文");
});

test("parseRunLog:run.log 不存在 → 空 steps(不抛)", async () => {
  const root = mkdtempSync(join(tmpdir(), "synod-replay-none-"));
  const { steps, sawFailure } = await parseRunLog(join(root, "nope"));
  assert.deepEqual(steps, []);
  assert.equal(sawFailure, false);
});

test("prepareResume:合并 checkpoint(flowName/input/cwd)+ run.log(steps)", async () => {
  const { root, runId, dir } = makeRun([
    { event: "step:started",   runId, stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 1, key: "0:omp:dddddddd" },
    { event: "step:succeeded", runId, stepId: "s1", node: "omp", type: "agent", attempt: 1, ts: 2, key: "0:omp:dddddddd", input: "p", output: "OUT" },
  ]);
  writeCheckpoint(root, runId, { flowName: "build", input: { goal: "x" }, cwd: "/proj", status: "failed" });
  const r = await prepareResume(root, runId);
  assert.equal(r.flowName, "build");
  assert.deepEqual(r.input, { goal: "x" });
  assert.equal(r.cwd, "/proj");
  assert.equal(r.steps.length, 1);
});

test("prepareResume:无 checkpoint → 抛带 runId 的错(无从复跑 flowName/input)", async () => {
  const root = mkdtempSync(join(tmpdir(), "synod-resume-noc-"));
  mkdirSync(join(root, "run-z"), { recursive: true });
  writeFileSync(join(root, "run-z", "run.log.jsonl"), "");
  await assert.rejects(prepareResume(root, "run-z"), /no checkpoint.*run-z/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.replay.test.mjs`
Expected: FAIL — `Cannot find module '../src/flow/replay.mjs'`

- [ ] **Step 3: 实现**

```js
// synod/src/flow/replay.mjs — run.log.jsonl 重放解析 + resume 准备(§4.12)。
//
// resume 的对账依据是 1C-a 的确定性 step key(`<seq>:<node>:<hash8>`)。本模块把
// run.log 解析成**有序的已完成 step**;runtime 的 replayStep 据此前缀匹配:第 i 个
// 原语调用与 steps[i] 比 node+hash,匹配则回放 steps[i].output(不开 agent),
// 第一个不匹配处起重放停用、全部真跑。
//
// 诚实限制:seq 在 1C-a 由 logStep 在调用完成时分配,顺序流下 = 调用序;并发流
// (Promise.all)下 = 完成序(不确定),故并发 run 的 resume 可能整段失配→真跑
// (不损坏,只是不省)。FLOW_AUTHORING「resume 与确定性」节向作者明示。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readCheckpoint } from "./checkpoint.mjs";

const LOG_FILE = "run.log.jsonl";

/**
 * 解析一个 run 目录的 run.log.jsonl。
 * @param {string} runDir 绝对路径 ~/.synod/runs/<runId>
 * @returns {Promise<{ steps: Array, sawFailure: boolean, failedNode: string|null }>}
 *   steps[i] = { key, node, type, hash, output, entry }
 */
export async function parseRunLog(runDir) {
  let text;
  try {
    text = await readFile(path.join(runDir, LOG_FILE), "utf8");
  } catch {
    return { steps: [], sawFailure: false, failedNode: null };
  }

  const started = new Map(); // stepId → started entry(占位,保序)
  const order = [];          // 按 succeeded 出现顺序的 stepId
  const succeeded = new Map(); // stepId → succeeded entry
  let sawFailure = false;
  let failedNode = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === "step:started") {
      started.set(e.stepId, e);
    } else if (e.event === "step:succeeded") {
      succeeded.set(e.stepId, e);
      order.push(e.stepId);
    } else if (e.event === "step:failed") {
      sawFailure = true;
      if (failedNode === null) failedNode = e.node ?? null;
    }
    // session:* 行与本模块无关,忽略
  }

  const steps = [];
  for (const stepId of order) {
    const entry = succeeded.get(stepId);
    const hash = String(entry.key ?? "").split(":")[2] ?? "";
    let output = entry.output ?? null;
    if (output == null && entry.outputRef) {
      try { output = await readFile(entry.outputRef, "utf8"); }
      catch { output = null; }
    }
    steps.push({
      key: entry.key ?? null,
      node: entry.node,
      type: entry.type,
      hash,
      output,
      entry,
    });
  }
  return { steps, sawFailure, failedNode };
}

/**
 * 准备 resume:合并 checkpoint(flowName/input/cwd)与 run.log(steps)。
 * @returns {Promise<{ runId, flowName, input, cwd, steps, status }>}
 */
export async function prepareResume(runsRoot, runId) {
  const ckpt = readCheckpoint(runsRoot, runId);
  if (!ckpt || typeof ckpt.flowName !== "string" || !ckpt.flowName) {
    throw new Error(
      `resume: no checkpoint (or missing flowName) for run "${runId}" — nothing to resume`,
    );
  }
  const { steps } = await parseRunLog(path.join(runsRoot, runId));
  return {
    runId,
    flowName: ckpt.flowName,
    input: ckpt.input,
    cwd: ckpt.cwd,
    steps,
    status: ckpt.status ?? null,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/flow.replay.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/flow/replay.mjs test/flow.replay.test.mjs
git commit -m "feat(resume): run.log.jsonl 重放解析(parseRunLog/prepareResume)"
```

---

### Task 3: logger.shortHash 导出 + runtime 重放装配

把 1C-a 定义在 `createLogger` 闭包内的 `shortHash` 提升为模块级 `export`(作用域提升,实现一字不改),供 runtime 的 `replayStep` 用同一算法算输入 hash 对账。runtime 在 `getRunState` 新建 run-state 时按 `replay` 计划挂 `{ replaySteps, replayCursor, replayActive }`;新增 `replayStep(runId,{node,input})` 助手与 `getReplay` 透传给五原语;`createCtx` 透传 `runId`(resume 复用旧 runId)。

**Files:**
- Modify: `src/flow/logger.mjs`(`shortHash` 提升为模块级导出)
- Modify: `src/flow/runtime.mjs`(replay 计划 + `replayStep` + `createCtx` runId + 原语传 `getReplay`)
- Test: `test/flow.resume.agent.test.mjs` 的 runtime 装配用例(本 Task 先建文件,放 replayStep 的纯装配断言;原语命中在 Task 4)

> 注:本 Task 引用的 logger 形态以 **1C-a Task 12 Step 3** 为准(`createLogger({ fs, clock, runsRoot })`、`shortHash` = `createHash("sha1").update(...).digest("hex").slice(0,8)`、key = `${seq}:${node}:${shortHash(input)}`)。`runtime.createRuntime` 形态以 **1C-a Task 8/12** 为准(已含 `signal`/`runsRoot`/`getRunState` 的 `controller`)。下方改动是在 1C-a 改后形态上**叠加**。

- [ ] **Step 1: 写失败测试(新建 test/flow.resume.agent.test.mjs 的装配段)**

```js
// test/flow.resume.agent.test.mjs — Task 3 装配 + Task 4 命中回放。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRuntime } from "../src/flow/runtime.mjs";
import { shortHash } from "../src/flow/logger.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };
const h8 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 8);

test("logger.shortHash 是模块级导出且 = sha1 前 8 位(与 1C-a key 同源)", () => {
  assert.equal(typeof shortHash, "function");
  assert.equal(shortHash("hello"), h8("hello"));
});

test("createCtx 透传 runId(resume 复用旧 runId)", () => {
  const rt = createRuntime({ fs: nullFs, clock: () => 0 });
  const ctx = rt.createCtx({}, { cwd: "/tmp", runId: "old-run-1" });
  assert.equal(ctx.runId, "old-run-1");
});

test("replay 计划下 replayStep 前缀匹配 node+hash,命中推进游标;失配后停用", () => {
  const steps = [
    { node: "omp", hash: h8("p1"), output: "O1", type: "agent", entry: {} },
    { node: "bash", hash: h8("ls"), output: "L", type: "bash", entry: { code: 0 } },
  ];
  const rt = createRuntime({
    fs: nullFs, clock: () => 0,
    replay: { runId: "r", steps },
  });
  // 强制 run-state 用 runId "r"
  const ctx = rt.createCtx({}, { cwd: "/tmp", runId: "r" });
  // 第 1 调用:omp/p1 命中
  let rep = rt._replayStep(ctx.runId, { node: "omp", input: "p1" });
  assert.equal(rep.hit, true);
  assert.equal(rep.output, "O1");
  // 第 2 调用:node 失配(给 bash 传错 input)→ miss + 停用
  rep = rt._replayStep(ctx.runId, { node: "bash", input: "WRONG" });
  assert.equal(rep.hit, false);
  // 第 3 调用:即便内容能对上 steps[1],重放已停用 → 仍 miss
  rep = rt._replayStep(ctx.runId, { node: "bash", input: "ls" });
  assert.equal(rep.hit, false);
});

test("无 replay 计划:replayStep 永远 miss(常态零开销)", () => {
  const rt = createRuntime({ fs: nullFs, clock: () => 0 });
  const ctx = rt.createCtx({}, { cwd: "/tmp", runId: "fresh" });
  assert.equal(rt._replayStep(ctx.runId, { node: "omp", input: "x" }).hit, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.resume.agent.test.mjs`
Expected: FAIL — `shortHash` 未从 logger 导出;`createRuntime` 不认 `replay`;`createCtx` 不透传 runId;`rt._replayStep` 未定义。

- [ ] **Step 3: 实现**

① `src/flow/logger.mjs`:把 1C-a 定义在 `createLogger` 闭包内的 `shortHash` 提升为模块级导出,闭包内改为引用该导出(行为不变)。在文件顶部(`import { randomUUID, createHash } from "node:crypto";` 之后,1C-a 已把 createHash 引入)加:

```js
/**
 * shortHash(s) — 确定性 step key 的输入 hash 段(sha1 前 8 位)。
 * 1C-b resume 的 replayStep 复用同一算法对账,故由 createLogger 闭包提升为
 * 模块级导出(实现一字不改,仅作用域提升)。
 */
export function shortHash(s) {
  return createHash("sha1")
    .update(typeof s === "string" ? s : JSON.stringify(s ?? ""))
    .digest("hex")
    .slice(0, 8);
}
```

并删除 `createLogger` 闭包内 1C-a 的 `function shortHash(s) { … }` 局部定义(闭包内对 `shortHash(input)` 的调用自动落到模块级导出,语义一致)。

② `src/flow/runtime.mjs`:

- 顶部 import 补 `import { shortHash } from "./logger.mjs";`(logger 已 import,补具名)。
- `createRuntime` 解构加 `replay`(1C-a 已有 `signal`/`runsRoot`/`runWorkspace` 由后续 Task 加,此处只加 `replay`):

```js
export function createRuntime({
  fs, clock, openBackend, io, progress, config, signal, runsRoot, replay,
  workflowsRoot, maxDepth, maxActiveSubRuns,
} = {}) {
```

- `getRunState`(1C-a 改后含 `controller`)新建分支里挂 replay 计划(只对 `replay.runId` 命中的 run 挂):

```js
  function getRunState(runId) {
    let rs = _runs.get(runId);
    if (!rs) {
      const controller = new AbortController();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      rs = {
        reusedSessions: new Map(),
        keyChains: new Map(),
        disposed: false,
        lastSinkError: null,
        controller,
        // 1C-b:仅顶层 resume run 挂重放计划;子 run(runWorkflow,不同 runId)无计划→真跑。
        replay: (replay && replay.runId === runId)
          ? { steps: replay.steps ?? [], cursor: 0, active: (replay.steps ?? []).length > 0 }
          : null,
      };
      _runs.set(runId, rs);
    }
    return rs;
  }
```

> 注:`signal`/`controller` 段落是 1C-a Task 8 的原文,本计划照抄上下文以便定位;实际只新增 `replay:` 一行。

- 在 `signalFor`/`abortRun`(1C-a 产物)之后新增 `replayStep`:

```js
  /**
   * replayStep(runId, { node, input }) — resume 前缀匹配(§4.12-1)。
   * 命中(node+hash 与游标处 step 相等)→ 回放 logged 输出并推进游标;
   * 失配 → 永久停用本 run 的重放(此后全部真跑)。无计划恒 miss。
   */
  function replayStep(runId, { node, input }) {
    const rs = getRunState(runId);
    const plan = rs.replay;
    if (!plan || !plan.active) return { hit: false };
    const expected = plan.steps[plan.cursor];
    if (!expected) { plan.active = false; return { hit: false }; }
    if (expected.node === node && expected.hash === shortHash(input)) {
      plan.cursor += 1;
      return { hit: true, output: expected.output, entry: expected.entry, type: expected.type };
    }
    plan.active = false;
    return { hit: false };
  }
```

- `createCtx` 包装(1C-a runtimeObj 的 `createCtx(input, { cwd })`)透传 runId:

```js
    createCtx(input, { cwd, runId } = {}) {
      return createCtx({ input, cwd, runId });
    },
```

- 原语工厂(`createAgent`/`createAgentLoop`/`createBash`/`createApprove`,1C-a 已传 `getSignal: signalFor`)各补 `getReplay: replayStep`:

```js
  const agent = createAgent({
    openBackend: resolvedOpenBackend, logger,
    getRunState, removeReusedSession, progress, config,
    getSignal: signalFor, getReplay: replayStep,
  });
  const bash = createBash({ logger, getSignal: signalFor, getReplay: replayStep });
  const agentLoop = createAgentLoop({
    openBackend: resolvedOpenBackend, logger, config, progress,
    getSignal: signalFor, getReplay: replayStep,
  });
  const approve = createApprove({ io: resolvedIo, logger, getSignal: signalFor, getReplay: replayStep });
```

- runtimeObj 暴露内部助手供测试(放在 `_getRunState` 旁):

```js
    /** Escape hatch for resume tests. */
    _replayStep: replayStep,
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/flow.resume.agent.test.mjs test/flow.logger.test.mjs test/flow.perrun.test.mjs && npm test`
Expected: 装配 4 测全绿;`flow.logger`/`flow.perrun`(1C-a)不回归(`shortHash` 提升后闭包内调用结果不变,key 字段一致)。

- [ ] **Step 5: Commit**

```bash
git add src/flow/logger.mjs src/flow/runtime.mjs test/flow.resume.agent.test.mjs
git commit -m "feat(resume): logger.shortHash 导出 + runtime 重放装配(replayStep/createCtx runId/getReplay)"
```

---

### Task 4: agent / agentLoop 命中重放回放(不开 agent)

`agentOnce` 入口在取/建会话**之前**问重放:命中即返回 logged 输出,**绝不** `openBackend`。`agentLoop` 把会话改为**惰性开**——每 turn 先问重放,命中用 logged 输出走 `until`/`maxTurns`,不开 agent;第一个真 turn 才惰性 `openBackend`。

**Files:**
- Modify: `src/flow/api/agent.mjs`(`createAgent` 收 `getReplay`;`agentOnce` 入口重放)
- Modify: `src/flow/api/agentLoop.mjs`(`createAgentLoop` 收 `getReplay`;会话惰性 + 每 turn 重放)
- Test: `test/flow.resume.agent.test.mjs`(追加)

> 注:`agentLoop` 整体替换 **1C-a Task 8 改后**的版本(1C-a 在 send 处包 `raceAbort(…, signal, …)` 并取 `signal = opts.signal ?? getSignal?.(ctx.runId)`)。下方完整实现已并入 1C-a 的 `raceAbort`/`signal`,**改动点**为:会话开口改惰性 + 每 turn 重放短路。`agent.mjs` 的 `send` 处 `raceAbort` 同样是 1C-a 产物,照抄上下文。

- [ ] **Step 1: 写失败测试(追加到 test/flow.resume.agent.test.mjs)**

```js
import { createHash as _ch } from "node:crypto";

function throwingOpenBackend() {
  return async () => { throw new Error("openBackend MUST NOT be called on replay hit"); };
}

test("agent 命中重放:回放 logged 输出,绝不 openBackend", async () => {
  const steps = [{ node: "omp", hash: h8("do it"), output: "REPLAYED", type: "agent", entry: {} }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    openBackend: throwingOpenBackend(),
    replay: { runId: "r", steps },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const out = await runtime.agent(ctx, { agent: "omp", prompt: "do it" });
  assert.equal(out, "REPLAYED");
});

test("agent 失配后真跑:第一个不匹配处起 openBackend 被调用", async () => {
  let opened = 0;
  const { FakeSession } = await import("./helpers/fake-backend.mjs");
  const steps = [{ node: "omp", hash: h8("first"), output: "R1", type: "agent", entry: {} }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    openBackend: async () => { opened += 1; return new FakeSession({ deltas: ["LIVE"] }); },
    replay: { runId: "r", steps },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  assert.equal(await runtime.agent(ctx, { agent: "omp", prompt: "first" }), "R1");
  assert.equal(opened, 0, "首个命中重放,不开 agent");
  assert.equal(await runtime.agent(ctx, { agent: "omp", prompt: "second" }), "LIVE");
  assert.equal(opened, 1, "失配后真开一次");
});

test("agentLoop 全 turn 命中重放:不 openBackend,until 用 logged 输出", async () => {
  const steps = [
    { node: "omp", hash: h8("t1"), output: "step-1", type: "agentLoop", entry: {} },
    { node: "omp", hash: h8("t2"), output: "DONE",   type: "agentLoop", entry: {} },
  ];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    openBackend: throwingOpenBackend(),
    replay: { runId: "r", steps },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const out = await runtime.agentLoop(ctx, {
    agent: "omp",
    prompt: (turn) => (turn === 1 ? "t1" : "t2"),
    until: (o) => o === "DONE",
    maxTurns: 5,
  });
  assert.equal(out, "DONE");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.resume.agent.test.mjs`
Expected: FAIL — agent/agentLoop 未问重放 → 命中用例里 `openBackend` 抛 "MUST NOT be called"。

- [ ] **Step 3: 实现**

① `src/flow/api/agent.mjs`:

- `createAgent` 解构加 `getReplay`(与 1C-a 的 `getSignal` 并列):

```js
export function createAgent({
  openBackend, logger, getRunState, removeReusedSession, progress, config,
  getSignal, getReplay,
}) {
```

- `agentOnce`(:96)在函数体最前(`const sink = progress;` 之前)插入重放短路:

```js
  async function agentOnce(
    ctx,
    { agent: agentName, model, effort, write, mesh, systemPrompt, workspace, prompt, reuse, signal: optSignal },
  ) {
    // ── resume 重放(§4.12-1):命中即回放 logged 输出,绝不 openBackend ──
    const rep = getReplay?.(ctx.runId, { node: agentName, input: prompt });
    if (rep?.hit) return rep.output ?? "";

    const sink = progress;
    // …（其余 1C-a 原文不变:取/建会话、send 包 raceAbort、logStep、close）…
```

> 注:`agentOnce` 的解构里 `workspace` 字段为 Task 10 预留(本 Task 不用 worktree,先纳入解构避免 Task 10 再改签名);`signal: optSignal` 是 1C-a 的 signal 入参(1C-a 在 `agentOnce` 取 `const signal = optSignal ?? getSignal?.(ctx.runId);`,本 Task 不改该行)。`workspace` 必须出现在解构里——`resolveOpts`(已读 `src/flow/api/resolve-opts.mjs`)对未知字段是**透传**(spread 全部 entries),故 `workspace` 能到达此处。

② `src/flow/api/agentLoop.mjs`:整体替换 `agentLoop` 函数(并入 1C-a 的 `raceAbort`/`signal`,改动点 = 惰性开会话 + 每 turn 重放)。`createAgentLoop` 解构加 `getReplay`、`getSignal`(1C-a 已加 getSignal),顶部 import `raceAbort`(1C-a Task 8 已加):

```js
import { makeResolveOpts } from "./resolve-opts.mjs";
import { raceAbort } from "./abortable.mjs";   // 1C-a Task 8 已加

export function createAgentLoop({ openBackend, logger, config, progress, getSignal, getReplay }) {
  const bg = (p) => p.catch(() => {});
  const resolveOpts = makeResolveOpts(config);

  async function agentLoop(ctx, rawOpts) {
    const opts = resolveOpts(rawOpts);
    const {
      agent: agentName, model, effort, write, mesh, systemPrompt,
      prompt, until, maxTurns = 5,
    } = opts;
    // ── Validation(1C-a/基线原文,不变)──────────────────────────────
    if (!ctx || typeof ctx.runId !== "string" || !ctx.runId) {
      throw new Error("agentLoop: ctx.runId is required (non-empty string)");
    }
    if (!ctx.cwd || typeof ctx.cwd !== "string") {
      throw new Error("agentLoop: ctx.cwd is required (non-empty string)");
    }
    if (typeof agentName !== "string" || !agentName) {
      throw new Error("agentLoop: agent name is required (non-empty string)");
    }
    if (model !== undefined && model !== null && (typeof model !== "string" || !model)) {
      throw new Error(`agentLoop: model must be a non-empty string or null/undefined, got ${typeof model}`);
    }
    if (typeof prompt !== "string" && typeof prompt !== "function") {
      throw new Error("agentLoop: prompt must be a string or function(turn, prevOutput) => string");
    }
    if (typeof until !== "function") {
      throw new Error("agentLoop: until must be a function(output, turn) => boolean");
    }
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error("agentLoop: maxTurns must be a positive integer");
    }

    const signal = opts.signal ?? getSignal?.(ctx.runId);   // 1C-a
    const sink = progress;

    // 会话惰性开:全 turn 命中重放时绝不开 agent(resume 第一不变量)。
    let session = null;
    let sessionId = null;
    let onDelta = null;

    async function ensureSession() {
      if (session) return;
      try {
        session = await openBackend({ agent: agentName, model, effort, write, mesh, systemPrompt, cwd: ctx.cwd });
      } catch (openErr) {
        await bg(logger.logStep(ctx, {
          node: agentName, type: "agentLoop", attempt: 1, error: openErr,
          meta: { agent: agentName, model: model ?? null },
        }));
        throw openErr;
      }
      sessionId = session.summary().id;
      await bg(logger.logSession(ctx, {
        event: "session:open", sessionId, agent: agentName, model: model ?? null, reused: false,
      }));
      if (sink) {
        onDelta = (chunk) => { try { sink.emit({ type: "delta", agent: agentName, model, text: chunk }); } catch {} };
        session.on("delta", onDelta);
      }
    }

    let lastOutput = "";
    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        const promptText = typeof prompt === "function" ? prompt(turn, lastOutput) : prompt;

        // ── resume 重放:命中即用 logged 输出,不开 agent ──
        const rep = getReplay?.(ctx.runId, { node: agentName, input: promptText });
        if (rep?.hit) {
          lastOutput = rep.output ?? "";
          if (until(lastOutput, turn)) return lastOutput;
          continue;
        }

        await ensureSession();
        if (sink) { try { sink.emit({ type: "start", agent: agentName, model }); } catch {} }

        let result;
        try {
          result = await raceAbort(
            session.send(promptText, { wait: true }),
            signal,
            () => { try { session.close(); } catch {} },
          );
        } catch (sendErr) {
          await bg(logger.logStep(ctx, {
            node: agentName, type: "agentLoop", attempt: turn, error: sendErr, input: promptText,
            meta: { agent: agentName, model: model ?? null, turn, maxTurns },
          }));
          throw sendErr;
        }

        lastOutput = result.text ?? "";
        await logger.logStep(ctx, {
          node: agentName, type: "agentLoop", attempt: turn, output: lastOutput, input: promptText,
          meta: { agent: agentName, model: model ?? null, turn, maxTurns },
        });
        if (until(lastOutput, turn)) return lastOutput;
      }
      return lastOutput;
    } finally {
      if (onDelta && session) session.off("delta", onDelta);
      if (session) {
        session.close();
        await bg(logger.logSession(ctx, {
          event: "session:close", sessionId, agent: agentName, model: model ?? null, reused: false,
        }));
      }
    }
  }

  return agentLoop;
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/flow.resume.agent.test.mjs test/flow.agent.test.mjs test/flow.agentloop.test.mjs test/flow.cancel.test.mjs && npm test`
Expected: 全绿。无 replay 计划时 `getReplay?.()` 返回 `{hit:false}`,agent/agentLoop 行为与 1C-a 完全一致(agentLoop 会话在 turn 1 惰性开,与改前"循环前开"对外等价:session:open 仍在首 turn 前落)。`flow.cancel`(1C-a)的 raceAbort 路径不回归。

- [ ] **Step 5: Commit**

```bash
git add src/flow/api/agent.mjs src/flow/api/agentLoop.mjs test/flow.resume.agent.test.mjs
git commit -m "feat(resume): agent/agentLoop 命中重放回放 logged 输出(不开 agent)"
```

---

### Task 5: bash / approve 命中重放回放

`bash` 入口问重放:命中回放 logged `{ stdout, stderr, code }`(stderr 取自 1C-a 截断后的 `meta.stderr`,可能截断,文档注明),**绝不 exec**。`approve` 入口问重放:命中按 logged 决定(`entry.accepted`/`entry.aborted`/`output`=feedback)重建结构化结果,**不重新打印待审内容、不重新问**。`reviseWithHuman` 无需改动(它经 `agent`/`approve` 间接重放,1C-a 已使其 opts 原样透传)。

**Files:**
- Modify: `src/flow/api/bash.mjs`(`createBash` 收 `getReplay`;入口重放)
- Modify: `src/flow/api/approve.mjs`(`createApprove` 收 `getReplay`;入口重放)
- Test: `test/flow.resume.bash-approve.test.mjs`

> 注:`bash`/`approve` 的 `getSignal` 入参与 signal 缺省回落是 **1C-a Task 9** 产物,照抄上下文,本 Task 只在其入口前加重放短路。

- [ ] **Step 1: 写失败测试**

```js
// test/flow.resume.bash-approve.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRuntime } from "../src/flow/runtime.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };
const h8 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 8);

test("bash 命中重放:回放 logged {stdout,stderr,code},绝不 exec 子进程", async () => {
  const steps = [{
    node: "bash", hash: h8("rm -rf /"), output: "fake-out", type: "bash",
    entry: { code: 0, stderr: "warn" },
  }];
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, replay: { runId: "r", steps } });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.bash(ctx, "rm -rf /");   // 危险命令:命中重放绝不真跑
  assert.equal(r.stdout, "fake-out");
  assert.equal(r.stderr, "warn");
  assert.equal(r.code, 0);
});

test("bash 失配真跑:第一个不匹配处起真 exec", async () => {
  const steps = [{ node: "bash", hash: h8("echo first"), output: "first", type: "bash", entry: { code: 0 } }];
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, replay: { runId: "r", steps } });
  const ctx = runtime.createCtx({}, { cwd: process.cwd(), runId: "r" });
  assert.equal((await runtime.bash(ctx, "echo first")).stdout, "first");   // 重放
  const live = await runtime.bash(ctx, "echo second");                      // 真跑
  assert.match(live.stdout, /second/);
  assert.equal(live.code, 0);
});

test("approve 命中重放:按 logged 决定重建结果,不重新问(io.question 永挂也不卡)", async () => {
  const stepsAccept = [{ node: "approve", hash: h8("ready?"), output: "accept", type: "approve", entry: { accepted: true, aborted: false } }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, replay: { runId: "r", steps: stepsAccept },
    io: { stdout: { write() {} }, stdin: {}, question: () => new Promise(() => {}) }, // 永不应答
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.approve(ctx, { content: "ready?" });
  assert.deepEqual(r, { accepted: true });
});

test("approve 重放 feedback:回放 {accepted:false, feedback}", async () => {
  const steps = [{ node: "approve", hash: h8("doc"), output: "改第一段", type: "approve", entry: { accepted: false, aborted: false } }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, replay: { runId: "r", steps },
    io: { stdout: { write() {} }, stdin: {}, question: () => new Promise(() => {}) },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.approve(ctx, { content: "doc" });
  assert.deepEqual(r, { accepted: false, feedback: "改第一段" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.resume.bash-approve.test.mjs`
Expected: FAIL — bash 真 exec 危险命令(或返回真实输出而非 "fake-out");approve 走 `io.question` 永挂 → 测试超时。

- [ ] **Step 3: 实现**

① `src/flow/api/bash.mjs`:`createBash` 解构加 `getReplay`(与 1C-a 的 `getSignal` 并列);`bash` 入口前加重放短路:

```js
export function createBash({ logger, getSignal, getReplay }) {
  async function bash(ctx, cmd, { cwd, signal } = {}) {
    // ── resume 重放(§4.12-1):命中回放 logged 结果,绝不 exec ──
    const rep = getReplay?.(ctx.runId, { node: "bash", input: cmd });
    if (rep?.hit) {
      return {
        stdout: (rep.output ?? "").trimEnd(),
        stderr: rep.entry?.stderr ?? "",   // 注:1C-a 截断 stderr 入 meta,重放亦可能截断
        code: typeof rep.entry?.code === "number" ? rep.entry.code : 0,
      };
    }
    const sig = signal ?? getSignal?.(ctx.runId);   // 1C-a Task 9
    // …（其余 1C-a 原文不变:execAsync({ signal: sig }) + logStep）…
```

② `src/flow/api/approve.mjs`:`createApprove` 解构加 `getReplay`;`approve` 在**呈现 content 之前**插入重放短路:

```js
export function createApprove({ io, logger, getSignal, getReplay }) {
  async function approve(ctx, opts = {}) {
    const {
      content,
      prompt = "(accept / feedback / /abort): ",
    } = opts;

    // ── resume 重放(§4.12-1):命中按 logged 决定重建结果,不重新呈现/不重新问 ──
    const rep = getReplay?.(ctx.runId, { node: "approve", input: content != null ? String(content) : "" });
    if (rep?.hit) {
      if (rep.entry?.aborted) return { aborted: true };
      if (rep.entry?.accepted) return { accepted: true };
      return { accepted: false, feedback: rep.output ?? "" };
    }

    const signal = opts.signal ?? getSignal?.(ctx.runId);   // 1C-a Task 9
    // …（其余 1C-a 原文不变:呈现 content、io.question、分类、logStep）…
```

> 注:approve 重放的输入 hash 必须与 1C-a logStep 记录的 `input` 一致——1C-a approve 记 `input: content != null ? String(content) : ""`,故重放问的 input 用同一表达式,hash 才对得上。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/flow.resume.bash-approve.test.mjs test/flow.bash.test.mjs test/flow.approve.test.mjs test/flow.revise.test.mjs && npm test`
Expected: 全绿。无 replay 时行为与 1C-a 一致(bash 真 exec、approve 真问)。`flow.revise`(1C-a 透传)经 agent/approve 间接重放,不需改 reviseWithHuman。

- [ ] **Step 5: Commit**

```bash
git add src/flow/api/bash.mjs src/flow/api/approve.mjs test/flow.resume.bash-approve.test.mjs
git commit -m "feat(resume): bash/approve 命中重放回放(approve 复用 logged 决定)"
```

---

### Task 6: `synod resume <runId>` + 启动写 checkpoint + REPL `/resume`

flow.main 接 resume 模式(复用旧 runId + 注入 replay 计划 + checkpoint 里的 flowName/input/cwd),并在 run 启动即写 `status:"running"` 初始 checkpoint(硬 kill 也留得住复跑信息),成功写 `done`、失败写 `failed`。cli 加 `synod resume <runId>` 子命令(读 checkpoint+log → flow.main resume);REPL 加 `/resume <runId>`。

**Files:**
- Modify: `src/flow.mjs`(`main` 接 `resume`/`headless`;启动写 checkpoint;成功/失败更新 checkpoint;`parseFlowArgs` 加 `--headless`)
- Modify: `src/cli.mjs`(`synod resume <runId>` 子命令;`resumeFlow` 桥接传给 dispatch)
- Modify: `src/repl-dispatch.mjs`(`/resume <runId>`)
- Test: `test/flow.resume.integration.test.mjs`、`test/repl-dispatch.test.mjs`(追加)

> 注:flow.main 形态以 **1C-a Task 11/12/13** 为准(已接 `io`/`signal`/`runsRoot`/`config`,run 路径直接 `loadFlow`,`writeLatestPointer`)。本 Task 在其上叠加 `resume`/`headless` 入参与 checkpoint 落盘。`--headless` 的判定语义在 Task 8 完整启用;本 Task 先把 flag 解析进 `parseFlowArgs`(避免 Task 8 再动 parser)。

- [ ] **Step 1: 写失败测试(新建 test/flow.resume.integration.test.mjs)**

```js
// test/flow.resume.integration.test.mjs — kill 一半 → resume 续完。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as flowMain } from "../src/flow.mjs";
import { readCheckpoint } from "../src/flow/checkpoint.mjs";
import { prepareResume } from "../src/flow/replay.mjs";

function collector() { const c = []; return { write: (s) => { c.push(s); return true; }, text: () => c.join("") }; }

function setupFlow(body) {
  const proj = mkdtempSync(join(tmpdir(), "synod-resume-proj-"));
  mkdirSync(join(proj, "workflows"));
  writeFileSync(join(proj, "workflows", "two.mjs"), body);
  const runsRoot = mkdtempSync(join(tmpdir(), "synod-resume-runs-"));
  return { proj, runsRoot };
}

// flow:第一步 bash(echo A),第二步 agent;首跑让 agent 抛错(模拟中断),
// resume 时第一步重放、第二步真跑成功。
const FLOW = `
import { bash, agent } from "synod/flow";
export const meta = { description: "two-step" };
export async function run(ctx) {
  const a = await bash(ctx, "echo A");
  const b = await agent(ctx, { agent: "omp", prompt: "make B" });
  return { a: a.stdout, b };
}
`;

test("首跑 agent 失败写 failed checkpoint;resume 重放 bash + 真跑 agent 成功", async () => {
  const { proj, runsRoot } = setupFlow(FLOW);
  const stdout1 = collector(); const stderr1 = collector();
  // 首跑:openBackend 抛错 → agent step:failed → flow 返回 1
  const failBackend = async () => { throw new Error("backend down"); };
  const code1 = await flowMain({
    argv: ["two"], stdout: stdout1, stderr: stderr1,
    openBackend: failBackend, workflowsRoot: join(proj, "workflows"),
    cwd: proj, runsRoot,
    // fs 缺省 → flow.main 用默认真 fs(logger 需 mkdir/appendFile/writeFile)
  });
  assert.equal(code1, 1, "首跑失败");
  // 找到 runId(checkpoint 落在 runsRoot/<runId>)
  const { runId } = findOnlyRun(runsRoot);
  const ck = readCheckpoint(runsRoot, runId);
  assert.equal(ck.status, "failed");
  assert.equal(ck.flowName, "two");

  // resume:bash 步重放(不真跑),agent 步真开(这次成功)
  const r = await prepareResume(runsRoot, runId);
  assert.equal(r.steps.length >= 1, true, "bash 步已完成可重放");
  let opened = 0;
  const okBackend = async () => {
    opened += 1;
    const { FakeSession } = await import("./helpers/fake-backend.mjs");
    return new FakeSession({ deltas: ["B-DONE"] });
  };
  const stdout2 = collector(); const stderr2 = collector();
  const code2 = await flowMain({
    argv: ["two"], stdout: stdout2, stderr: stderr2,
    openBackend: okBackend, workflowsRoot: join(proj, "workflows"),
    cwd: proj, runsRoot,
    resume: { runId, input: r.input, steps: r.steps },
  });
  assert.equal(code2, 0, "resume 续完");
  assert.equal(opened, 1, "只为真跑的 agent 步开一次 backend(bash 步重放未开)");
  assert.match(stdout2.text(), /B-DONE/);
  assert.equal(readCheckpoint(runsRoot, runId).status, "done");
});

function findOnlyRun(runsRoot) {
  const ents = readdirSync(runsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  return { runId: ents[0].name };
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.resume.integration.test.mjs`
Expected: FAIL — flow.main 不认 `resume`/`runsRoot`(若 1C-a 已加 runsRoot 则 resume 仍不认);首跑不写 checkpoint(`readCheckpoint` → null)。

- [ ] **Step 3: 实现**

① `src/flow.mjs`:

- `parseFlowArgs`(:43)`out` 加 `headless: false`,switch 内加 `case "--headless": out.headless = true; break;`(放在 `case "--progress":` 之后)。

- `main` 签名(1C-a 改后)加 `resume`/`headless`:

```js
export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  openBackend: ob = openBackend,
  workflowsRoot: defaultRoot = resolve(process.cwd(), "workflows"),
  cwd = process.cwd(),
  config: injectedConfig,
  io: injectedIo,
  signal: externalSignal,
  runsRoot: runsRootOpt,                // 1C-a Task 12
  resume,                               // 1C-b: { runId, input, steps } | undefined
  headless: injectedHeadless,           // 1C-b
  fs: realFs = { writeFile, appendFile, mkdir },   // 1C-a Task 12 已加 mkdir
} = {}) {
```

- 顶部 import 补:`import os from "node:os";`(若 1C-a 未引)、`import { writeCheckpoint } from "./flow/checkpoint.mjs";`、`import { isAwaitingHuman } from "./flow/checkpoint.mjs";`、`import { prepareResume } from "./flow/replay.mjs";`(prepareResume 供 cli 调,flow.main 内不直接用,但导出链需要——实际 flow.main 收 `resume` 已展开,不必 import prepareResume;此处只 import writeCheckpoint/isAwaitingHuman)。

- `runsRoot` 解析(1C-a):`const runsRoot = runsRootOpt ?? resolve(os.homedir(), ".synod", "runs");`

- headless 判定(本 Task 解析、Task 8 启用):`const headless = injectedHeadless ?? args.headless;`

- 找到 flow 后、`createCtx` 处(1C-a:run 直接 `loadFlow`),改为支持 resume 复用 runId 与 input:

```js
  // resume:复用旧 runId + 旧 input;否则正常解析 argv input。
  const flowInput = resume ? resume.input : parseInput(args.input);
  const ctx = runtime.createCtx(flowInput, { cwd, runId: resume?.runId });
```

- `createRuntime`(1C-a)调用加 `runsRoot`/`headless`/`replay`:

```js
    runtime = createRuntime({
      openBackend: ob,
      workflowsRoot: root,
      clock: () => Date.now(),
      fs: realFs,
      progress: progressSink,
      config,
      io: injectedIo,
      signal: externalSignal,
      runsRoot,
      headless,                                   // 1C-b(Task 8 接 approve)
      replay: resume ? { runId: resume.runId, steps: resume.steps } : undefined, // 1C-b
    });
```

> 注:`createCtx` 必须在 `createRuntime` 之后调用(runtime.createCtx 才存在)——1C-a 顺序已是先建 runtime 后建 ctx,保持不变。

- 启动写初始 checkpoint(在 `const ctx = …` 之后、`runFlow` 之前):

```js
  // 启动即写 checkpoint(running)——含 flowName/input/cwd,硬 kill 也留得住复跑信息。
  try {
    writeCheckpoint(runsRoot, ctx.runId, {
      flowName: args.name, input: flowInput ?? null, cwd, status: "running",
    });
  } catch { /* checkpoint 写失败不阻断主流程 */ }
```

- run 收尾(1C-a 的 `try { runFlow … return 0 } catch { … return 1 }`)改为更新 checkpoint + 退出码 5 分支:

```js
  try {
    const result = await runFlow(runtime, flow, ctx, flowInput);
    try { writeCheckpoint(runsRoot, ctx.runId, { status: "done" }); } catch {}
    if (result !== undefined) {
      stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
    return 0;
  } catch (err) {
    if (isAwaitingHuman(err)) {
      // approve headless 断点已写 awaiting-approval checkpoint + 打印待审内容(Task 8)。
      stderr.write(`Awaiting human at run ${ctx.runId}. Resume: synod resume ${ctx.runId}\n`);
      return err.exitCode;   // = 5
    }
    try {
      writeCheckpoint(runsRoot, ctx.runId, {
        status: "failed", error: err.message,
        stoppedAt: { node: err.node ?? null, type: null, inputHash: null },
      });
    } catch {}
    stderr.write(`Error: flow "${args.name}" failed: ${err.message}\n`);
    return 1;
  }
```

② `src/cli.mjs`:

- 顶部 import 补:`import { prepareResume } from "./flow/replay.mjs";`、`import os from "node:os";`(1C-a Task 13 已引 os)。

- `main` 在 `const args = parseArgs(argv.slice(2));` **之前**拦截 `resume` 子命令(parseArgs 会把 `resume` 当未知参数报错,故前置):

```js
  const rawArgv = argv.slice(2);
  if (rawArgv[0] === "resume") {
    return resumeCommand({
      runId: rawArgv[1], stdin, stdout, stderr, openBackend, env,
    });
  }
```

- 新增 `resumeCommand`(放在 `main` 之前的模块级):

```js
// synod resume <runId> — 读 checkpoint + run.log 续跑(§4.12-3)。
async function resumeCommand({ runId, stdin = process.stdin, stdout, stderr, openBackend, env }) {
  if (!runId) {
    stderr.write("synod: usage: synod resume <runId>\n");
    return 2;
  }
  const runsRoot = path.resolve(env.SYNOD_HOME || os.homedir(), ".synod", "runs");
  let prepared;
  try {
    prepared = await prepareResume(runsRoot, runId);
  } catch (err) {
    stderr.write(`synod: ${err.message}\n`);
    return 1;
  }
  // 配置同启动期:加载 + 注册(flow.main 收 config 则不重复注册)。
  let config;
  try {
    config = await loadConfig({ cwd: path.resolve(prepared.cwd || process.cwd()), home: env.SYNOD_HOME || undefined });
    await registerConfigBackends(config);
  } catch (err) {
    stderr.write(`synod: ${err.message}\n`);
    return 2;
  }
  const flowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
  const headless = !stdin.isTTY;   // resume 在 TTY 下正常提问续答;管道/CI 仍 headless
  return flowMain({
    argv: ["--progress", prepared.flowName],
    stdout, stderr, openBackend,
    workflowsRoot: flowsRoot,
    cwd: prepared.cwd || process.cwd(),
    config,
    runsRoot,
    resume: { runId: prepared.runId, input: prepared.input, steps: prepared.steps },
    headless,
  });
}
```

> 注:`resumeCommand` 用 `workflowsRoot: flowsRoot`(synod 包内 workflows/),与 cli 交互模式的 `/flow` 一致(1C-a)。若 flow 实际在项目目录,1C-a 的 `config.flows` 搜索路径覆盖(loadFlow 多目录);本计划 resume 沿用 flow.main 的 loadFlow 解析(含 config.flows)。

- REPL 桥接:在交互模式 `runFlow` 旁加 `resumeFlow`(供 dispatch `/resume` 用),并传入 `createReplDispatch`:

```js
  const resumeFlow = async (runId) => {
    const runsRoot = path.resolve(env.SYNOD_HOME || os.homedir(), ".synod", "runs");
    let prepared;
    try { prepared = await prepareResume(runsRoot, runId); }
    catch (err) { stderr.write(`synod: ${err.message}\n`); return 1; }
    const p = flowMain({
      argv: ["--progress", prepared.flowName],
      stdout, stderr, openBackend, workflowsRoot: flowsRoot,
      cwd: prepared.cwd || cwd, config, runsRoot,
      resume: { runId: prepared.runId, input: prepared.input, steps: prepared.steps },
      io: flowIo, signal: undefined,   // REPL 交互:TTY 提问续答,headless 默认 false
      headless: false,
    });
    _pendingFlows.add(p);
    p.finally(() => _pendingFlows.delete(p)).catch(() => {});
    return p;
  };
```

> 注:`flowIo` 是 1C-a Task 11 在 cli runFlow 处构造的共享 router io(`question=(p,{signal})=>router.claim(...)`)。`resumeFlow` 复用它,使 resume 在 REPL 下经唯一 readline 提问。

- `createReplDispatch`(1C-a)调用加 `resumeFlow`:

```js
  const dispatch = createReplDispatch({
    sm, registry, stdout, stderr,
    defaultAgent: args.agent,
    guardrails: { maxSessions: 10, maxDepth: 3, allowWrite: false },
    runFlow, resumeFlow, config,
  });
```

③ `src/repl-dispatch.mjs`:`createReplDispatch` 解构加 `resumeFlow`;human 分支 `/flow` 之后加 `/resume`:

```js
export function createReplDispatch({ sm, registry, stdout, stderr, defaultAgent, guardrails, runFlow, resumeFlow, config = { agents: {} } }) {
  const _resumeFlow = resumeFlow || (async () => {
    stderr.write("resume unavailable in this context\n");
  });
```

human 分支(`/flow` 处理后):

```js
    if (cmd === "/resume") {
      const runId = (rest[0] || "").trim();
      if (!runId) {
        stderr.write("usage: /resume <runId>\n");
        return { redraw: true };
      }
      stdout.write(`Resuming run "${runId}"...\n`);
      return _resumeFlow(runId).then(() => ({ redraw: true }), () => ({ redraw: true }));
    }
```

并在 cli.mjs `printHelp` 的 REPL commands 段补一行:`"  /resume <runId>      Resume a flow run from its checkpoint",`(放 `/flow` 行后)。

- [ ] **Step 2(repl 追加测试)→ Step 1 补充 test/repl-dispatch.test.mjs**

```js
test("/resume <runId> 调 resumeFlow", async () => {
  const seen = [];
  const { createReplDispatch } = await import("../src/repl-dispatch.mjs");
  const dispatch = createReplDispatch({
    sm: { _sessions: new Map(), open: async () => "omp#1" },
    registry: { add() {} }, stdout: { write() {} }, stderr: { write() {} },
    defaultAgent: "omp",
    resumeFlow: async (id) => { seen.push(id); },
  });
  const r = await dispatch("/resume run-42", { source: "human" });
  assert.equal(r.redraw, true);
  assert.deepEqual(seen, ["run-42"]);
});

test("/resume 缺 runId → usage,不调 resumeFlow", async () => {
  const errs = [];
  const { createReplDispatch } = await import("../src/repl-dispatch.mjs");
  const dispatch = createReplDispatch({
    sm: { _sessions: new Map(), open: async () => "omp#1" },
    registry: { add() {} }, stdout: { write() {} }, stderr: { write: (s) => errs.push(s) },
    defaultAgent: "omp",
    resumeFlow: async () => { throw new Error("should not call"); },
  });
  const r = dispatch("/resume", { source: "human" });
  const res = r && typeof r.then === "function" ? await r : r;
  assert.equal(res.redraw, true);
  assert.match(errs.join(""), /usage: \/resume/);
});
```

- [ ] **Step 3: 跑测试确认失败 → 实现(同上)→ 确认通过 + 全量回归**

Run: `node --test test/flow.resume.integration.test.mjs test/repl-dispatch.test.mjs && npm test`
Expected: 全绿。`cli.integration`/`repl-dispatch` 既有用例不回归(resume 是新增只读分支;`resumeFlow` 缺省 stub 不影响既有 /flow)。

- [ ] **Step 4: Commit**

```bash
git add src/flow.mjs src/cli.mjs src/repl-dispatch.mjs test/flow.resume.integration.test.mjs test/repl-dispatch.test.mjs
git commit -m "feat(resume): synod resume <runId> + 启动写 checkpoint + REPL /resume"
```

---

### Task 7: `synod runs` 状态列增强(done / failed@<node> / awaiting-approval)

1C-a 的 `listRuns` 按 run.log 末行猜 `done/failed/running`。1C-b 让它**优先读 checkpoint**(权威状态):`done`/`failed`(带 `failed@<stoppedAt.node>`)/`awaiting-approval`/`running`,并带出 `worktrees`(为 Part C 的残留可见)。无 checkpoint 时回落到 1C-a 的 log 末行猜测。

**Files:**
- Modify: `src/runs.mjs`(`listRuns` 读 checkpoint 增强 status + worktrees)
- Modify: `src/cli.mjs`(`--runs` 输出列含状态文案;1C-a 已建 `--runs` 分支,此处只调格式)
- Test: `test/runs.test.mjs`(追加)

- [ ] **Step 1: 写失败测试(追加到 test/runs.test.mjs)**

```js
import { writeCheckpoint } from "../src/flow/checkpoint.mjs";

test("listRuns 优先读 checkpoint:awaiting-approval / failed@<node>", () => {
  const root = mkdtempSync(join(tmpdir(), "synod-runs-ck-"));
  // run-aw:awaiting-approval
  mkdirSync(join(root, "run-aw"));
  writeFileSync(join(root, "run-aw", "run.log.jsonl"),
    JSON.stringify({ event: "step:succeeded", runId: "run-aw", node: "n", type: "agent", ts: 1000, key: "0:n:x" }) + "\n");
  writeCheckpoint(root, "run-aw", { flowName: "f", input: null, cwd: "/p", status: "awaiting-approval",
    stoppedAt: { node: "approve", type: "approve", inputHash: "h" } });
  // run-fail:failed@build
  mkdirSync(join(root, "run-fail"));
  writeFileSync(join(root, "run-fail", "run.log.jsonl"),
    JSON.stringify({ event: "step:failed", runId: "run-fail", node: "build", type: "agent", ts: 2000, key: "0:build:y" }) + "\n");
  writeCheckpoint(root, "run-fail", { flowName: "f", input: null, cwd: "/p", status: "failed",
    stoppedAt: { node: "build", type: "agent", inputHash: "h" }, error: "boom" });

  const runs = Object.fromEntries(listRuns(root).map((r) => [r.runId, r]));
  assert.equal(runs["run-aw"].status, "awaiting-approval");
  assert.equal(runs["run-fail"].status, "failed");
  assert.equal(runs["run-fail"].failedNode, "build");
});

test("listRuns:无 checkpoint → 回落 log 末行猜测(1C-a 行为不回归)", () => {
  const root = mkdtempSync(join(tmpdir(), "synod-runs-nock-"));
  mkdirSync(join(root, "run-old"));
  writeFileSync(join(root, "run-old", "run.log.jsonl"),
    JSON.stringify({ event: "step:succeeded", runId: "run-old", node: "n", type: "agent", ts: 5, key: "0:n:z" }) + "\n");
  const r = listRuns(root)[0];
  assert.equal(r.runId, "run-old");
  assert.ok(["done", "failed", "running"].includes(r.status));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/runs.test.mjs`
Expected: FAIL — `listRuns` 不读 checkpoint(`run-aw` 被猜成 `done`;无 `failedNode` 字段)。

- [ ] **Step 3: 实现**

① `src/runs.mjs`:顶部 import 补 `import { readCheckpoint } from "./flow/checkpoint.mjs";`。`listRuns`(1C-a)的每个 run 循环里,先读 checkpoint,优先用其 status:

```js
export function listRuns(runsRoot) {
  let names;
  try { names = fs.readdirSync(runsRoot, { withFileTypes: true }); }
  catch { return []; }
  const runs = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const logPath = path.join(runsRoot, ent.name, "run.log.jsonl");
    let startedAt = null, status = "running", failedNode = null, worktrees = [];

    // 1C-b:checkpoint 是权威状态来源(awaiting-approval 等)。
    const ck = readCheckpoint(runsRoot, ent.name);
    if (ck) {
      status = ck.status ?? "running";
      startedAt = ck.startedAt ?? null;
      failedNode = ck.stoppedAt?.node ?? null;
      worktrees = Array.isArray(ck.worktrees) ? ck.worktrees : [];
    }

    // 无 checkpoint(或缺 startedAt)→ 回落 1C-a 的 log 末行猜测。
    if (!ck || startedAt == null) {
      try {
        const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
        if (lines.length && lines[0]) {
          const first = JSON.parse(lines[0]);
          if (startedAt == null) startedAt = first.ts ?? null;
          if (!ck) {
            const last = JSON.parse(lines[lines.length - 1]);
            status = last.event === "step:failed" ? "failed"
              : last.event === "step:succeeded" || last.event === "session:close" ? "done"
              : "running";
          }
        }
      } catch { if (!ck) continue; }
    }
    runs.push({ runId: ent.name, startedAt, status, failedNode, worktrees });
  }
  runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return runs;
}
```

② `src/cli.mjs`:1C-a 的 `--runs` 输出行改为带 `failed@<node>` 文案:

```js
    for (const r of runs) {
      const when = r.startedAt ? new Date(r.startedAt).toISOString() : "?";
      const status = r.status === "failed" && r.failedNode ? `failed@${r.failedNode}` : r.status;
      const wt = r.worktrees && r.worktrees.length ? `  worktrees=${r.worktrees.length}` : "";
      stdout.write(`${r.runId}  ${when}  ${status}${wt}\n`);
    }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/runs.test.mjs && npm test`
Expected: 全绿。1C-a 的 listRuns 无-checkpoint 回落分支保留,旧用例不回归;新字段 `failedNode`/`worktrees` 对旧调用方无害(多余字段)。

- [ ] **Step 5: Commit**

```bash
git add src/runs.mjs src/cli.mjs test/runs.test.mjs
git commit -m "feat(runs): synod runs 状态列 done/failed@<node>/awaiting-approval(读 checkpoint)"
```

---

# Part B · headless 人在环断点

> Part B 一个 Task。headless 判定由入口算出经 runtime 注入 approve;approve headless 下不等 stdin——写 checkpoint(awaiting-approval)+ 完整打印待审内容到 stdout + emit `onApprovalNeeded`(1D 接钩子)+ 抛 `AwaitingHuman`(flow.main → 退出码 5)。

---

### Task 8: approve headless 断点 + 退出码 5 + onApprovalNeeded 事件挂点

**Files:**
- Modify: `src/flow/runtime.mjs`(`createRuntime` 收 `headless`/`events`;透传 `createApprove`;暴露 `runsRoot` 给 approve 写 checkpoint)
- Modify: `src/flow/api/approve.mjs`(headless 分支:写 checkpoint + 打印 + emit + 抛 AwaitingHuman)
- Test: `test/flow.headless.test.mjs`

> 注:`reviseWithHuman` 内部首个 `approve()` 在 headless 下即抛 `AwaitingHuman`,沿调用栈冒泡到 flow.main → 退出码 5。无需改 reviseWithHuman(1C-a 已使其 opts 透传 + cooperative abort)。resume 时该 approve 节点在 TTY 下正常提问续答(headless=false)。

- [ ] **Step 1: 写失败测试(新建 test/flow.headless.test.mjs)**

```js
// test/flow.headless.test.mjs — §4.13 headless approve 断点 + 退出码 5。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/flow/runtime.mjs";
import { readCheckpoint, isAwaitingHuman } from "../src/flow/checkpoint.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };

test("headless approve:不问 stdin,写 checkpoint(awaiting-approval)+ 打印待审 + emit + 抛 AwaitingHuman", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "synod-hl-"));
  const out = [];
  const events = new EventEmitter();
  const seen = [];
  events.on("approvalNeeded", (info) => seen.push(info));
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, runsRoot,
    headless: true, events,
    io: { stdout: { write: (s) => out.push(s) }, stdin: {}, question: () => { throw new Error("must not ask"); } },
  });
  const ctx = runtime.createCtx({}, { cwd: "/p", runId: "hl-run" });
  // checkpoint 需先有 running 档(flow.main 启动写;此处测试直接预置)
  const { writeCheckpoint } = await import("../src/flow/checkpoint.mjs");
  writeCheckpoint(runsRoot, "hl-run", { flowName: "f", input: null, cwd: "/p", status: "running" });

  await assert.rejects(
    runtime.approve(ctx, { content: "请审阅这段内容\n第二行" }),
    (err) => { assert.equal(isAwaitingHuman(err), true); assert.equal(err.exitCode, 5); return true; },
  );
  // 待审内容完整打印到 stdout
  assert.match(out.join(""), /请审阅这段内容\n第二行/);
  // checkpoint 转 awaiting-approval + pending content
  const ck = readCheckpoint(runsRoot, "hl-run");
  assert.equal(ck.status, "awaiting-approval");
  assert.equal(ck.pending.content, "请审阅这段内容\n第二行");
  assert.equal(ck.stoppedAt.node, "approve");
  // onApprovalNeeded 事件已 emit(1D 接钩子)
  assert.equal(seen.length, 1);
  assert.equal(seen[0].runId, "hl-run");
});

test("非 headless:approve 仍走 io.question(回归守卫)", async () => {
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    headless: false,
    io: { stdout: { write() {} }, stdin: {}, question: async () => "accept" },
  });
  const ctx = runtime.createCtx({}, { cwd: "/p", runId: "tty-run" });
  const r = await runtime.approve(ctx, { content: "ok?" });
  assert.deepEqual(r, { accepted: true });
});

test("headless 但命中重放:不触发断点(已决定的 approve 直接回放)", async () => {
  const { createHash } = await import("node:crypto");
  const h8 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, headless: true,
    replay: { runId: "r", steps: [{ node: "approve", hash: h8("ok?"), output: "accept", type: "approve", entry: { accepted: true } }] },
    io: { stdout: { write() {} }, stdin: {}, question: () => { throw new Error("must not ask"); } },
  });
  const ctx = runtime.createCtx({}, { cwd: "/p", runId: "r" });
  const r = await runtime.approve(ctx, { content: "ok?" });
  assert.deepEqual(r, { accepted: true }, "重放先于 headless 判定");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.headless.test.mjs`
Expected: FAIL — `createRuntime` 不认 `headless`/`events`;approve 在 headless 下仍调 `io.question`(抛 "must not ask")或不写 checkpoint。

- [ ] **Step 3: 实现**

① `src/flow/runtime.mjs`:

- `createRuntime` 解构加 `headless`/`events`:

```js
export function createRuntime({
  fs, clock, openBackend, io, progress, config, signal, runsRoot, replay,
  headless, events,
  workflowsRoot, maxDepth, maxActiveSubRuns, runWorkspace,
} = {}) {
```

> 注:`runWorkspace` 为 Part C 预留,本 Task 一并纳入解构,Task 9/10 接线。

- `createApprove` 调用(1C-a 已传 `getSignal`/本计划 Task 3 已传 `getReplay`)补 `headless`/`events`/`runsRoot`:

```js
  const approve = createApprove({
    io: resolvedIo, logger, getSignal: signalFor, getReplay: replayStep,
    headless: Boolean(headless), events, runsRoot,
  });
```

② `src/flow/api/approve.mjs`:

- 顶部 import:`import { writeCheckpoint, awaitingHumanError } from "../checkpoint.mjs";`、`import { shortHash } from "../logger.mjs";`。
- `createApprove` 解构加 `headless`/`events`/`runsRoot`:

```js
export function createApprove({ io, logger, getSignal, getReplay, headless = false, events, runsRoot }) {
```

- 在重放短路(Task 5 已加)**之后**、signal 取值之前,插入 headless 断点:

```js
    // ── resume 重放(Task 5)先于 headless 判定:已决定的 approve 直接回放 ──
    const rep = getReplay?.(ctx.runId, { node: "approve", input: content != null ? String(content) : "" });
    if (rep?.hit) {
      if (rep.entry?.aborted) return { aborted: true };
      if (rep.entry?.accepted) return { accepted: true };
      return { accepted: false, feedback: rep.output ?? "" };
    }

    // ── headless 人在环断点(§4.13):不等 stdin,存断点退出等人 ──
    if (headless) {
      const body = content != null ? String(content) : "";
      // 完整打印待审内容到 stdout(CI 日志可见)。
      if (body) io.stdout.write(body + "\n");
      io.stdout.write("[synod] awaiting human approval — run is paused.\n");
      // 写 checkpoint(awaiting-approval + 待审内容 + 停点)。
      if (runsRoot) {
        try {
          writeCheckpoint(runsRoot, ctx.runId, {
            status: "awaiting-approval",
            stoppedAt: { node: "approve", type: "approve", inputHash: shortHash(body) },
            pending: { content: body },
          });
        } catch { /* 写失败不阻断退出 */ }
      }
      // 记一条 step:failed 风格的 approve 中断(best-effort,供尸检)。
      await logger.logStep(ctx, {
        node: "approve", type: "approve", attempt: 1, input: body, output: "(awaiting-human)",
        meta: { accepted: false, aborted: false, awaiting: true },
      }).catch(() => {});
      // onApprovalNeeded 事件挂点(1D 接命令钩子 + 终端铃;本计划只 emit)。
      try { events?.emit("approvalNeeded", { runId: ctx.runId, node: "approve", content: body }); }
      catch { /* 事件订阅者异常不影响主流程 */ }
      throw awaitingHumanError({ runId: ctx.runId, node: "approve" });
    }

    const signal = opts.signal ?? getSignal?.(ctx.runId);   // 1C-a Task 9
    // …（其余 1C-a 原文:呈现 content、io.question、分类、logStep)…
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + e2e**

Run: `node --test test/flow.headless.test.mjs test/flow.approve.test.mjs test/flow.revise.test.mjs && npm test && npm run test:e2e-flow`
Expected: 全绿。`headless` 默认 false → 既有 approve/revise 用例走 io.question 不回归;重放先于 headless 保证 resume 续答不二次断点。

- [ ] **Step 5: Commit**

```bash
git add src/flow/runtime.mjs src/flow/api/approve.mjs test/flow.headless.test.mjs
git commit -m "feat(headless): approve headless 断点 + 退出码 5 + onApprovalNeeded 事件挂点"
```

---

# Part C · RunWorkspace worktree 写隔离

> Part C 三个 Task。先建 `RunWorkspace` 组件(git worktree acquire/finalize/非git拒绝/残留扫描,可脱离 runtime 单测),再接 agent(write+workspace → worktree cwd)与收尾合并摘要,最后接崩溃残留治理与 runs 可见。

---

### Task 9: `src/run-workspace.mjs` — git worktree 隔离组件

`acquire({runId,name})` 在 `~/.synod/worktrees/<repo-hash>/<runId>-<name>/` 基于 HEAD 建 worktree + 分支 `synod/<runId>/<name>`;同名复用、非 git 拒绝。`finalize({runId})` 逐分支:脏则自动 commit → 合回起始分支;无冲突自动合 + 清 worktree/分支,有冲突 `merge --abort` 保留并入冲突清单。

**Files:**
- Create: `src/run-workspace.mjs`
- Create: `test/helpers/git-repo.mjs`(临时 git 仓库 helper)
- Test: `test/run-workspace.test.mjs`

- [ ] **Step 1: 写 git 仓库 helper**

```js
// test/helpers/git-repo.mjs — mkdtemp 一个真 git 仓库(worktree 测试共用,零三方依赖)。
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** 建一个带初始提交的 git 仓库,返回其路径。可指定初始文件。 */
export function makeGitRepo(files = { "README.md": "init\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "synod-git-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@synod"]);
  git(dir, ["config", "user.name", "synod test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  // 固定初始分支名,避免 main/master 差异
  git(dir, ["checkout", "-q", "-B", "main"]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** 非 git 的空临时目录。 */
export function makeNonGitDir() {
  return mkdtempSync(join(tmpdir(), "synod-nogit-"));
}

export { git as runGit };
```

- [ ] **Step 2: 写失败测试(新建 test/run-workspace.test.mjs)**

```js
// test/run-workspace.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunWorkspace } from "../src/run-workspace.mjs";
import { makeGitRepo, makeNonGitDir } from "./helpers/git-repo.mjs";

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
const worktreesRoot = () => mkdtempSync(join(tmpdir(), "synod-wt-"));

test("非 git 目录 acquire(write+workspace)→ 拒绝(建议 git init / 串行)", () => {
  const cwd = makeNonGitDir();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  assert.throws(() => ws.acquire({ runId: "r1", name: "feat" }), /git repo|git init|serial/i);
});

test("acquire 建 worktree + 分支 synod/<runId>/<name>;同名复用同一 worktree", () => {
  const cwd = makeGitRepo();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run1", name: "feat-x" });
  assert.ok(existsSync(a.path), "worktree 目录存在");
  assert.equal(a.branch, "synod/run1/feat-x");
  // 分支已建
  const branches = git(cwd, ["branch", "--list", "synod/run1/feat-x"]);
  assert.match(branches, /synod\/run1\/feat-x/);
  // 同名复用
  const a2 = ws.acquire({ runId: "run1", name: "feat-x" });
  assert.equal(a2.path, a.path, "同名 workspace 复用同一 worktree");
});

test("不同名 → 不同 worktree;两个并发 write 各自隔离", () => {
  const cwd = makeGitRepo();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run2", name: "a" });
  const b = ws.acquire({ runId: "run2", name: "b" });
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.branch, b.branch);
});

test("finalize:无冲突分支自动合回起始分支并清 worktree/分支", () => {
  const cwd = makeGitRepo();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run3", name: "feat" });
  // 在 worktree 改一个新文件(无冲突)
  writeFileSync(join(a.path, "new.txt"), "hello from worktree\n");
  const r = ws.finalize({ runId: "run3" });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.merged, ["feat"]);
  // 合回主仓:new.txt 出现在起始分支
  assert.ok(existsSync(join(cwd, "new.txt")));
  // worktree 与分支被清
  assert.ok(!existsSync(a.path), "worktree 已移除");
  assert.equal(git(cwd, ["branch", "--list", "synod/run3/feat"]), "");
});

test("finalize:冲突分支保留 worktree+分支,进 conflicts 清单(冲突文件可见)", () => {
  const cwd = makeGitRepo({ "README.md": "base\n" });
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run4", name: "feat" });
  // 主仓先改 README(制造冲突)
  writeFileSync(join(cwd, "README.md"), "main side\n");
  git(cwd, ["commit", "-aqm", "main change"]);
  // worktree 也改 README 同一行
  writeFileSync(join(a.path, "README.md"), "worktree side\n");
  const r = ws.finalize({ runId: "run4" });
  assert.equal(r.merged.length, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].name, "feat");
  assert.match(r.conflicts[0].files.join(","), /README\.md/);
  assert.ok(existsSync(a.path), "冲突 worktree 保留");
  assert.match(git(cwd, ["branch", "--list", "synod/run4/feat"]), /synod\/run4\/feat/);
});

test("worktree 记录持久化到 runsRoot/<runId>/workspaces.json", () => {
  const cwd = makeGitRepo();
  const runsRoot = worktreesRoot();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot });
  ws.acquire({ runId: "run5", name: "feat" });
  const rec = JSON.parse(readFileSync(join(runsRoot, "run5", "workspaces.json"), "utf8"));
  assert.equal(rec[0].name, "feat");
  assert.equal(rec[0].branch, "synod/run5/feat");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/run-workspace.test.mjs`
Expected: FAIL — `Cannot find module '../src/run-workspace.mjs'`

- [ ] **Step 4: 实现**

```js
// synod/src/run-workspace.mjs — 并发写隔离:每个 write 任务一个 git worktree(§4.11)。
//
// 设计:acquire 在 ~/.synod/worktrees/<repo-hash>/<runId>-<name>/ 基于 HEAD 建临时
// worktree + 分支 synod/<runId>/<name>,agent 会话 cwd 指向之。只读 agent 不调
// acquire(用主 cwd,零开销)。finalize 逐分支尝试合回起始分支:脏 worktree 先
// 自动 commit,能无冲突合并的自动合 + 清 worktree/分支;有冲突的 merge --abort
// 保留 worktree+分支并进 conflicts 清单留人(顺利路径零人工,出错路径不丢工作)。
//
// 零三方依赖:git 操作走 spawnSync("git", …)。spawnSync 同步,故 Promise.all 下
// 多个 agent 的 acquire 在 JS 事件循环里天然串行,无 git 并发竞态。
//
// win32:worktree 路径全用 node:path 拼接、不用 symlink;git worktree/merge 退出码
// 跨平台一致;分支名用 "/" 在 git 内部即 ref 路径,Windows git 同样支持。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error,
  };
}

function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.error?.message || `exit ${r.status}`}`);
  }
  return r.stdout;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function createRunWorkspace({ cwd, worktreesRoot, runsRoot }) {
  const _acquired = new Map();   // `${runId}/${name}` → { name, path, branch }
  let _startBranch = null;       // run 启动时主仓所在分支(finalize 合回它)

  function isGitRepo() {
    const r = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return r.status === 0 && r.stdout === "true";
  }

  function repoTop() {
    return gitOk(cwd, ["rev-parse", "--show-toplevel"]);
  }

  function currentBranch() {
    const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return r.status === 0 ? r.stdout : "HEAD";
  }

  function persist(runId) {
    try {
      const dir = path.join(runsRoot, runId);
      fs.mkdirSync(dir, { recursive: true });
      const list = [..._acquired.entries()]
        .filter(([k]) => k.startsWith(`${runId}/`))
        .map(([, v]) => v);
      fs.writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify(list, null, 2) + "\n");
    } catch { /* 记录失败不阻断主流程 */ }
  }

  /** 建/复用一个隔离 worktree。非 git 仓库 → 拒绝(write+workspace 必须有 git)。 */
  function acquire({ runId, name }) {
    if (!NAME_RE.test(name)) {
      throw new Error(`RunWorkspace: invalid workspace name "${name}" (use letters/digits/_/-)`);
    }
    if (!isGitRepo()) {
      throw new Error(
        `RunWorkspace: write+workspace isolation requires a git repo at ${cwd}. ` +
        `Run \`git init\` there, or run write agents serially (no workspace).`,
      );
    }
    const cacheKey = `${runId}/${name}`;
    if (_acquired.has(cacheKey)) return _acquired.get(cacheKey);

    if (_startBranch === null) _startBranch = currentBranch();

    const top = repoTop();
    const repoHash = createHash("sha1").update(top).digest("hex").slice(0, 12);
    const dir = path.join(worktreesRoot, repoHash, `${runId}-${name}`);
    const branch = `synod/${runId}/${name}`;

    fs.mkdirSync(path.dirname(dir), { recursive: true });
    gitOk(cwd, ["worktree", "add", "-b", branch, dir, "HEAD"]);

    const ws = { name, path: dir, branch };
    _acquired.set(cacheKey, ws);
    persist(runId);
    return ws;
  }

  /** run 结束逐分支收尾:自动 commit 脏 worktree → 合回起始分支(冲突留人)。 */
  function finalize({ runId, startBranch } = {}) {
    const start = startBranch ?? _startBranch ?? currentBranch();
    const merged = [];
    const conflicts = [];
    for (const [key, ws] of _acquired) {
      if (!key.startsWith(`${runId}/`)) continue;
      // 1) 脏 worktree 自动 commit(write agent 通常只改文件不 commit)。
      const dirty = git(ws.path, ["status", "--porcelain"]).stdout;
      if (dirty) {
        git(ws.path, ["add", "-A"]);
        git(ws.path, ["commit", "-q", "-m", `synod ${runId} ${ws.name}`]);
      }
      // 2) 在主仓(起始分支)合并该分支。
      const m = git(cwd, ["merge", "--no-ff", "-m", `synod merge ${ws.name}`, ws.branch]);
      if (m.status === 0) {
        git(cwd, ["worktree", "remove", "--force", ws.path]);
        git(cwd, ["branch", "-D", ws.branch]);
        merged.push(ws.name);
      } else {
        const files = git(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout
          .split("\n").map((s) => s.trim()).filter(Boolean);
        git(cwd, ["merge", "--abort"]);
        conflicts.push({ name: ws.name, branch: ws.branch, path: ws.path, files });
      }
    }
    return { merged, conflicts, startBranch: start };
  }

  /** run 内已 acquire 的 worktree 清单(供 checkpoint/摘要)。 */
  function list(runId) {
    return [..._acquired.entries()]
      .filter(([k]) => k.startsWith(`${runId}/`))
      .map(([, v]) => v);
  }

  return { isGitRepo, acquire, finalize, list, _acquired };
}

/**
 * 启动顺扫:git worktree prune + 列残留 synod worktree(供 CLI 提示)。
 * 纯只读列举,不删用户工作(Task 11 用)。
 */
export function scanResidualWorktrees(cwd) {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return [];
  git(cwd, ["worktree", "prune"]);   // 清掉已被删目录的登记(尽力而为)
  const out = git(cwd, ["worktree", "list", "--porcelain"]).stdout;
  const residual = [];
  let curPath = null, curBranch = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { curPath = line.slice(9).trim(); curBranch = null; }
    else if (line.startsWith("branch ")) { curBranch = line.slice(7).trim(); }
    else if (line === "") {
      if (curBranch && /\/synod\/[^/]+\//.test(curBranch)) {
        residual.push({ path: curPath, branch: curBranch });
      }
      curPath = null; curBranch = null;
    }
  }
  return residual;
}
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `node --test test/run-workspace.test.mjs && npm test`
Expected: 全绿。(需本机有 git;CI/本机均具备,见 `git --version`。)

- [ ] **Step 6: Commit**

```bash
git add src/run-workspace.mjs test/helpers/git-repo.mjs test/run-workspace.test.mjs
git commit -m "feat(workspace): RunWorkspace git worktree 写隔离(acquire/finalize/非git拒绝)"
```

---

### Task 10: agent write+workspace → worktree cwd + 收尾自动合并摘要

agent `{ write: true, workspace: "feat-x" }` 时,会话 cwd 指向 worktree;`sessionKeyOf` 纳入 workspace(避免跨 worktree 复用同一会话)。run 收尾 flow.main 调 `runtime.finalizeWorkspaces(ctx)`,打印合并/冲突摘要,冲突清单写进 checkpoint。

**Files:**
- Modify: `src/flow/runtime.mjs`(`acquireWorkspace`/`finalizeWorkspaces`;传 `acquireWorkspace` 给 createAgent;default RunWorkspace 构造)
- Modify: `src/flow/api/agent.mjs`(`createAgent` 收 `acquireWorkspace`;`agentOnce` write+workspace → worktree cwd;`sessionKeyOf` 纳入 workspace)
- Modify: `src/flow.mjs`(main 默认建 RunWorkspace 传 runtime;收尾 finalize 摘要 + checkpoint worktrees)
- Test: `test/flow.workspace.test.mjs`

- [ ] **Step 1: 写失败测试(新建 test/flow.workspace.test.mjs)**

```js
// test/flow.workspace.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/flow/runtime.mjs";
import { createRunWorkspace } from "../src/run-workspace.mjs";
import { makeGitRepo } from "./helpers/git-repo.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };
const wtRoot = () => mkdtempSync(join(tmpdir(), "synod-fwt-"));

test("agent write+workspace:会话 cwd 指向 worktree(非主 cwd)", async () => {
  const repo = makeGitRepo();
  const rw = createRunWorkspace({ cwd: repo, worktreesRoot: wtRoot(), runsRoot: wtRoot() });
  let seenCwd;
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, runWorkspace: rw,
    openBackend: async ({ cwd }) => { seenCwd = cwd; return new FakeSession({ deltas: ["ok"] }); },
  });
  const ctx = runtime.createCtx({}, { cwd: repo, runId: "run-w" });
  await runtime.agent(ctx, { agent: "omp", write: true, workspace: "feat", prompt: "edit" });
  assert.notEqual(seenCwd, repo, "cwd 应指向 worktree,不是主 cwd");
  assert.match(seenCwd, /run-w-feat/, "cwd 在 worktree 目录内");
});

test("只读 agent(无 workspace):cwd = 主 cwd,不建 worktree(零开销)", async () => {
  const repo = makeGitRepo();
  const rw = createRunWorkspace({ cwd: repo, worktreesRoot: wtRoot(), runsRoot: wtRoot() });
  let seenCwd;
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, runWorkspace: rw,
    openBackend: async ({ cwd }) => { seenCwd = cwd; return new FakeSession({ deltas: ["ok"] }); },
  });
  const ctx = runtime.createCtx({}, { cwd: repo, runId: "run-r" });
  await runtime.agent(ctx, { agent: "omp", prompt: "read only" });
  assert.equal(seenCwd, repo);
  assert.equal(rw._acquired.size, 0, "只读不建 worktree");
});

test("finalizeWorkspaces 返回 {merged,conflicts}", async () => {
  const repo = makeGitRepo();
  const rw = createRunWorkspace({ cwd: repo, worktreesRoot: wtRoot(), runsRoot: wtRoot() });
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, runWorkspace: rw, openBackend: async () => new FakeSession({}) });
  const ctx = runtime.createCtx({}, { cwd: repo, runId: "run-f" });
  rw.acquire({ runId: "run-f", name: "feat" });
  const r = await runtime.finalizeWorkspaces(ctx);
  assert.ok(Array.isArray(r.merged));
  assert.ok(Array.isArray(r.conflicts));
});

test("无 runWorkspace:finalizeWorkspaces 安全返回空(非 git/无写隔离场景)", async () => {
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, openBackend: async () => new FakeSession({}) });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.finalizeWorkspaces(ctx);
  assert.deepEqual(r, { merged: [], conflicts: [] });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/flow.workspace.test.mjs`
Expected: FAIL — `createRuntime` 不认 `runWorkspace`;agent 不接 workspace → cwd 始终 = 主 cwd;`runtime.finalizeWorkspaces` 未定义。

- [ ] **Step 3: 实现**

① `src/flow/runtime.mjs`:

- `createRuntime`(Task 8 已加 `runWorkspace` 解构)新增 `acquireWorkspace`/`finalizeWorkspaces`(放在 `replayStep` 之后):

```js
  /** write+workspace 时取隔离 worktree(供 agent);非 git 由 RunWorkspace 抛错。 */
  function acquireWorkspace(ctx, name) {
    if (!runWorkspace) {
      throw new Error(
        `agent: write+workspace requires a RunWorkspace (no git repo configured for run ${ctx.runId})`,
      );
    }
    return runWorkspace.acquire({ runId: ctx.runId, name });
  }

  /** run 收尾合并 worktree;无 runWorkspace → 空结果。 */
  async function finalizeWorkspaces(ctx) {
    if (!runWorkspace) return { merged: [], conflicts: [] };
    try { return runWorkspace.finalize({ runId: ctx.runId }); }
    catch (err) { return { merged: [], conflicts: [], error: err.message }; }
  }
```

- `createAgent` 调用补 `acquireWorkspace`:

```js
  const agent = createAgent({
    openBackend: resolvedOpenBackend, logger,
    getRunState, removeReusedSession, progress, config,
    getSignal: signalFor, getReplay: replayStep,
    acquireWorkspace,
  });
```

- runtimeObj 暴露 `finalizeWorkspaces`(放在 `disposeRun` 旁):`finalizeWorkspaces,`。

② `src/flow/api/agent.mjs`:

- `createAgent` 解构加 `acquireWorkspace`。
- `sessionKeyOf` 纳入 `workspace`(7 元组;改两处调用同步加 workspace):

```js
  function sessionKeyOf({ agent: agentName, model, effort, write, mesh, systemPrompt, workspace }) {
    return JSON.stringify([
      agentName, model ?? "", effort ?? "", !!write, !!mesh, systemPrompt ?? "", workspace ?? "",
    ]);
  }
```

- `agent`(:57)里 `const key = sessionKeyOf(opts);` 已传整个 opts(含 workspace),无需改。
- `agentOnce` 解构(Task 4 已加 `workspace`)在重放短路之后、`openBackend` 调用处计算 worktree cwd:

```js
    // ── resume 重放(Task 4)先于 worktree 取用 ──
    const rep = getReplay?.(ctx.runId, { node: agentName, input: prompt });
    if (rep?.hit) return rep.output ?? "";

    // ── write+workspace → 隔离 worktree cwd(§4.11);只读/无 workspace 用主 cwd ──
    const agentCwd = (write && workspace) ? acquireWorkspace(ctx, workspace).path : ctx.cwd;

    const sink = progress;
    const runState = getRunState(ctx.runId);
    const sessionKey = sessionKeyOf({ agent: agentName, model, effort, write, mesh, systemPrompt, workspace });
    // …（取/建会话:openBackend({ …, cwd: agentCwd }) —— 把原 cwd: ctx.cwd 改为 cwd: agentCwd)…
```

> 注:`agentOnce` 内 `openBackend({ … cwd: ctx.cwd })` 改为 `cwd: agentCwd`。其余 1C-a/基线逻辑不变。

③ `src/flow.mjs`:

- 顶部 import 补 `import { createRunWorkspace, scanResidualWorktrees } from "./run-workspace.mjs";`(scanResidual 供 Task 11)。
- `main` 里建 RunWorkspace(在 `createRuntime` 之前):

```js
  const worktreesRoot = resolve(os.homedir(), ".synod", "worktrees");
  const runWorkspace = createRunWorkspace({ cwd, worktreesRoot, runsRoot });
```

- `createRuntime` 调用加 `runWorkspace`:`runWorkspace,`。
- run 收尾(Task 6 改后的 try/catch)在 return 0 / 失败分支之前统一 finalize + 打印摘要 + 写 checkpoint worktrees。把收尾段重构为:

```js
  let result, runErr;
  try {
    result = await runFlow(runtime, flow, ctx, flowInput);
  } catch (err) {
    runErr = err;
  }

  // ── RunWorkspace 收尾:合回起始分支,冲突留人并打印清单 ──
  const wsr = await runtime.finalizeWorkspaces(ctx);
  if (wsr.merged?.length) {
    stdout.write(`\n[workspace] merged: ${wsr.merged.join(", ")}\n`);
  }
  if (wsr.conflicts?.length) {
    stderr.write(`\n[workspace] ${wsr.conflicts.length} conflict(s) left for you:\n`);
    for (const c of wsr.conflicts) {
      stderr.write(`  - branch ${c.branch}\n    worktree: ${c.path}\n    files: ${c.files.join(", ") || "(see git status)"}\n`);
    }
  }
  const wtRecords = (runWorkspace.list?.(ctx.runId) ?? []).map((w) => ({ name: w.name, branch: w.branch, path: w.path }));

  if (runErr) {
    if (isAwaitingHuman(runErr)) {
      try { writeCheckpoint(runsRoot, ctx.runId, { worktrees: wtRecords }); } catch {}
      stderr.write(`Awaiting human at run ${ctx.runId}. Resume: synod resume ${ctx.runId}\n`);
      return runErr.exitCode;
    }
    try {
      writeCheckpoint(runsRoot, ctx.runId, {
        status: "failed", error: runErr.message,
        stoppedAt: { node: runErr.node ?? null, type: null, inputHash: null },
        worktrees: wtRecords,
      });
    } catch {}
    stderr.write(`Error: flow "${args.name}" failed: ${runErr.message}\n`);
    return 1;
  }
  try { writeCheckpoint(runsRoot, ctx.runId, { status: "done", worktrees: wtRecords }); } catch {}
  if (result !== undefined) {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  return 0;
```

> 注:此段**替换** Task 6 Step 3 ① 写的收尾 try/catch(Task 6 给的是不含 worktree 的版本;本 Task 把 finalize/摘要/worktrees 并入)。两段在不同 Task 改同一区域——执行时以本 Task 的最终形态为准(Task 6 的收尾是中间态,Task 10 收口)。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/flow.workspace.test.mjs test/flow.resume.integration.test.mjs && npm test`
Expected: 全绿。无 workspace 的既有 agent 用例:`agentCwd = ctx.cwd`(write 且无 workspace,或只读)→ 行为不变;`sessionKeyOf` 加第 7 元 `workspace ?? ""`,既有不传 workspace → 追加 `""`,key 字符串变化但内部一致(reuse 测试不 hardcode key 串)。

- [ ] **Step 5: Commit**

```bash
git add src/flow/runtime.mjs src/flow/api/agent.mjs src/flow.mjs test/flow.workspace.test.mjs
git commit -m "feat(workspace): agent write+workspace 指向 worktree + 收尾自动合并/冲突留人"
```

---

### Task 11: 崩溃残留治理(git worktree prune + 启动顺扫提示)+ runs 可见

崩溃残留由 `git worktree prune` + 启动顺扫提示(§4.11)。cli 交互模式启动时(已有 reapOrphans 顺扫钩子,1C-a/阶段0)并行扫描残留 synod worktree,有则 stderr 提示路径与清理建议(只读,不替用户删)。worktree 清单已随 checkpoint 入 `synod runs`(Task 7 + Task 10),无需额外。

**Files:**
- Modify: `src/cli.mjs`(交互模式启动顺扫残留 worktree 提示)
- Test: `test/cli.worktree-scan.test.mjs`(新增,纯函数级:`scanResidualWorktrees` 已在 Task 9 测;此处测 cli 提示装配点)

> 注:`scanResidualWorktrees(cwd)` 已在 Task 9 实现并单测(`test/run-workspace.test.mjs` 覆盖其解析;此 Task 复用)。cli 只在交互模式启动调它打印提示。为避免 cli `main` 重测复杂度,本 Task 测试聚焦"提示函数"小工具 `residualWorktreeNotice(residual)`(纯函数,返回提示字符串)。

- [ ] **Step 1: 写失败测试(新建 test/cli.worktree-scan.test.mjs)**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { residualWorktreeNotice } from "../src/cli.mjs";

test("residualWorktreeNotice:无残留 → 空串", () => {
  assert.equal(residualWorktreeNotice([]), "");
});

test("residualWorktreeNotice:列出残留分支/路径 + 清理建议", () => {
  const s = residualWorktreeNotice([
    { path: "/wt/run1-feat", branch: "refs/heads/synod/run1/feat" },
  ]);
  assert.match(s, /1 residual synod worktree/i);
  assert.match(s, /run1-feat/);
  assert.match(s, /git worktree remove/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/cli.worktree-scan.test.mjs`
Expected: FAIL — `residualWorktreeNotice` 未从 cli.mjs 导出。

- [ ] **Step 3: 实现**

① `src/cli.mjs`:顶部 import 补 `import { scanResidualWorktrees } from "./run-workspace.mjs";`。新增并导出纯函数:

```js
/**
 * 残留 synod worktree 启动提示(§4.11 崩溃残留治理)。纯函数,便于单测。
 * 只读建议——绝不替用户删除可能含未保存工作的 worktree。
 */
export function residualWorktreeNotice(residual) {
  if (!residual || residual.length === 0) return "";
  const lines = [
    `synod: ${residual.length} residual synod worktree(s) from a previous run:`,
  ];
  for (const w of residual) {
    lines.push(`  - ${w.path}  (branch ${w.branch})`);
  }
  lines.push(`  inspect, then clean with: git worktree remove <path> && git branch -D <branch>`);
  return lines.join("\n") + "\n";
}
```

- 交互模式启动顺扫:在 `main` 的交互模式分支、`const defaultLabel = await sm.open(...)` 之前(或开场附近),并行扫描提示(尽力而为,绝不阻断启动):

```js
  // 启动顺扫残留 synod worktree(上次崩溃遗留),只提示不替删。
  try {
    const residual = scanResidualWorktrees(cwd);
    const notice = residualWorktreeNotice(residual);
    if (notice) stderr.write(notice);
  } catch { /* 非 git 仓库 / git 缺失 → 静默跳过 */ }
```

> win32 注:`scanResidualWorktrees` 内 `git worktree prune`/`list --porcelain` 跨平台一致;非 git 目录早返回空数组,提示不打印。

- 底部 `export { … }` 加 `residualWorktreeNotice`(与 1C-a/基线的 `export { main, parseArgs, createLineBuffer, parseOpenArgs, shutdownModeForArgv }` 并列)。

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + e2e**

Run: `node --test test/cli.worktree-scan.test.mjs && npm test && npm run test:e2e`
Expected: 全绿;A1–A8 不回归(顺扫是启动附加 stderr 提示,非 git 项目静默跳过,不影响 REPL 行为)。

- [ ] **Step 5: Commit**

```bash
git add src/cli.mjs test/cli.worktree-scan.test.mjs
git commit -m "feat(workspace): 崩溃残留 git worktree prune + 启动顺扫提示 + runs 可见"
```

---

# Part D · 文档

---

### Task 12: `docs/FLOW_AUTHORING.md` 增补「resume 与确定性」节

向 flow 作者明示 resume 的确定性要求(别用 `Date.now()`/`Math.random()` 决定控制流),并说明 headless 断点与 worktree 写隔离的用法。

**Files:**
- Modify: `docs/FLOW_AUTHORING.md`(在「7. 写完自检清单」之后追加「8. resume / headless / worktree(进阶)」)

- [ ] **Step 1: 追加文档(无测试,文档 Task)**

在 `docs/FLOW_AUTHORING.md` 末尾(「7. 写完自检清单」之后)追加:

```markdown
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
- **非 git 目录**用 `write + workspace` 会被**直接拒绝**(报错建议 `git init` 或串行单写)。
  单写者(不传 workspace)不受影响。
- 崩溃残留:`synod runs` 可见 worktree 计数;启动时 synod 会 `git worktree prune` 并提示
  残留路径(只提示不替你删)。
```

- [ ] **Step 2: 验证文档无破坏(markdown 渲染 + 字数)**

Run: `node --test 2>/dev/null | tail -1; wc -l docs/FLOW_AUTHORING.md`
Expected: `npm test` 不受文档影响(全绿);`FLOW_AUTHORING.md` 行数增加(原 149 → ~220+)。

- [ ] **Step 3: Commit**

```bash
git add docs/FLOW_AUTHORING.md
git commit -m "docs(flow): FLOW_AUTHORING 增补 resume/headless/worktree 确定性约束节"
```

---

## 完成定义(整个计划的 DoD)

1. `npm test` 全绿(1C-a 基线 + 本计划新增用例);`npm run test:e2e` A1–A8(+E1–4)不回归;`npm run test:e2e-shutdown` S1/S2 仍过;`npm run test:e2e-flow` 绿。
2. **手工验收(resume):** 写一个两步 flow(bash → agent),`node src/cli.mjs --task` 跑到 agent 时 `kill -9`(或让 agent 失败)→ `synod runs` 列出该 run 状态 `failed@<节点>`;`synod resume <runId>` 重放 bash 步(不真跑)、真跑 agent 步续完;`synod runs` 转 `done`。日志里 step 行带确定性 `key`,artifacts/checkpoint.json 在 `~/.synod/runs/<runId>/`。
3. **手工验收(headless):** 写一个含 `approve()` 的 flow,`echo "" | node src/flow.mjs <name>`(非 TTY)→ 完整打印待审内容、退出码 `5`、写 `checkpoint.json`(status awaiting-approval);`synod resume <runId>` 在 TTY 下该节点正常提问续答。
4. **手工验收(worktree):** 在一个 git 仓库里写 `Promise.all([agent(write,workspace:"a"), agent(write,workspace:"b")])` 的 flow,两 agent 各在自己 worktree 改不同文件 → 收尾自动合回起始分支、摘要打印 `merged: a, b`;人为制造冲突(主仓与 worktree 改同一行)→ 摘要打印冲突清单(分支/文件/路径)、worktree 保留;非 git 目录跑同 flow → 报错建议 `git init`。
5. **退出码 5 落地:** headless approve → flow.main / `synod`(经 flowMain)返回 5;`EXIT_AWAITING_HUMAN=5` 常量就位(阶段 3 退出码字典正式收编)。
6. **onApprovalNeeded 挂点就位:** headless approve emit `approvalNeeded` 事件(runId/node/content),1D 据此接命令钩子;本计划只 emit、不执行钩子。
7. **Windows 横切:** worktree 路径用 `node:path`、不依赖 symlink;退出码 5 经 `process.exit(5)` 透传;headless `!stdin.isTTY` 跨平台一致——三处 win32 行为写明;用户 Windows 实测一轮(§5 横切约束,用户执行)。
8. **文档与看板:** `docs/FLOW_AUTHORING.md` 增「resume/headless/worktree」节;`docs/V1.md` 看板「阶段 1C·执行 1C-b」勾掉并追加 commit 哈希;架构文档 §4.11/§4.12/§4.13 对应条从"设计"转"已落地"。

## 风险与回退

| 风险 | 缓解 |
|---|---|
| resume 在并发流(Promise.all)下时序失配 → 整段真跑 | **诚实降级**:失配不损坏(只是不省),replayStep 失配即停用、其后全真跑;FLOW_AUTHORING §8.1 明示并发是尽力而为、顺序流是强保证;Task 4 用例覆盖失配回退 |
| 确定性 step key 的 seq 在 1C-a 由 logStep 完成时分配,replayStep 用 cursor+node+hash 对账(不依赖 seq 数值) | replayStep 按**调用序游标 + node + 输入 hash** 前缀匹配,不比 seq 数值——顺序流下游标序 == 调用序;Task 3 用例断言命中/失配/停用三态 |
| 命中重放却误开 agent/跑 bash(破坏 resume 第一不变量) | 每原语在真工作**之前**短路;Task 4/5 用"openBackend 抛错 / 危险命令(rm -rf)命中重放"反证它没被调用 |
| approve 重放 input hash 与 1C-a logStep 记录不一致 → 失配 | 重放问的 input 用与 1C-a approve logStep **完全相同**的表达式(`content!=null?String(content):""`),Task 5/8 用例校验 accept/feedback 两路 |
| headless 误伤交互/测试(把注入 io.question 的测试当 headless) | `headless` 默认 false,**仅入口**(cli resume / flow.mjs run guard)按真 `stdin.isTTY` 置真;flow.main 注入式调用不传 → 既有 approve/revise 测试零回归;Task 8 回归守卫用例 |
| worktree finalize 时主仓 dirty 致 merge 拒绝 | 视作冲突保留(进 conflicts 清单、不丢工作);摘要提示;文档建议收尾前主仓干净 |
| 并发 acquire 触发 git worktree 竞态 | `spawnSync` 同步执行,Promise.all 下 acquire 体在事件循环中天然串行,无并发 git 调用;Task 9 双名隔离用例覆盖 |
| 残留 worktree 启动顺扫误删用户未保存工作 | **只提示不删**(`residualWorktreeNotice` 纯文本建议 + `git worktree prune` 仅清已删目录登记);Task 11 用例断言提示文案、不触删除 |
| checkpoint 写盘失败阻断主流程 | 所有 writeCheckpoint 包 try/catch 吞错(best-effort);硬 kill 写不进 → 启动期初始 checkpoint(running)已留 flowName/input 兜底 resume |
| 嵌套 runWorkflow 子 run resume 不联动 | **明确不含**(Scope 已声明):子 run 不同 runId、无重放计划 → 真跑;顶层 run 强保证;文档/Scope 注明 |

## Self-Review 记录

**§4.11 / §4.12 / §4.13 逐条 → Task 映射:**

| Spec 条目 | 一句话 | Task |
|---|---|---|
| §4.11 worktree 布局 + 分支命名 | `~/.synod/worktrees/<repo-hash>/<runId>-<name>/` + `synod/<runId>/<name>` | T9(acquire) |
| §4.11 只读不建 worktree | 无 workspace → 主 cwd 零开销 | T10(agentCwd 分支) |
| §4.11 收尾自动合 / 冲突留人 | finalize 无冲突自动合+清,有冲突保留+清单 | T9(finalize)+ T10(摘要) |
| §4.11 同名复用 / 默认独立 | 同 workspace 名复用同一 worktree | T9(acquire cacheKey)+ T10(sessionKeyOf 纳 workspace) |
| §4.11 非 git 拒绝 | write+workspace 非 git → 报错建议 git init/串行 | T9(acquire isGitRepo) |
| §4.11 worktree 记录进 run 目录 | `workspaces.json` + checkpoint.worktrees | T9(persist)+ T10(checkpoint) |
| §4.11 崩溃残留 prune + 启动顺扫 | `git worktree prune` + 启动提示 | T11(scanResidualWorktrees / 提示) |
| §4.12-1 确定性 step key 前缀匹配回放 | replayStep node+hash 游标对账,失配起真跑 | T2(parseRunLog)+ T3(replayStep)+ T4/T5(原语回放) |
| §4.12-2 per-run 目录是前置 | 按 runId 找 run.log/checkpoint | T2/T6(复用 1C-a per-run 目录) |
| §4.12-3 入口 synod resume / /resume / runs 状态列 | 子命令 + REPL + 状态列 | T6(resume/REPL)+ T7(runs 状态) |
| §4.12-4 checkpoint.json(停点/待审/worktree) | resume 与尸检共同入口 | T1(读写)+ T6(启动/收尾写)+ T8(approve 写)+ T10(worktrees) |
| §4.13 headless 判定 !isTTY\|\|--headless | 入口算出经 runtime 注入 | T6(--headless 解析)+ T8(approve 接 headless)+ T6(resume/cli isTTY) |
| §4.13 approve/revise 写断点+打印+退出码 5 | headless 不等 stdin,存断点退出等人 | T8(approve 断点)+ T6(flow.main → 退出码 5) |
| §4.13 onApprovalNeeded 可挂事件(1D 接线) | 本计划只 emit | T8(events.emit approvalNeeded) |

**占位符扫描:** 无 TBD / "适当处理" / "类似 Task N" / "补充测试"。每个改代码 Step 给完整可粘贴代码,每个跑命令 Step 给确切命令与预期输出。一处带条件的处置已给具体判据:T6/T10 都改 flow.main 收尾区——T6 给中间态、T10 收口,执行以 T10 最终形态为准(已在 T10 Step 3 ③ 注明"替换 Task 6 中间态")。(T6 集成测试初稿的 `require`/`realFsPromises` 占位已由审稿直接修正为 `readdirSync` + fs 缺省。)

**与 1C-a 计划的符号一致性核对表(第一审查项):**

| 符号 / 字段 / 路径 | 1C-b 用法 | 1C-a 出处 | 一致性 |
|---|---|---|---|
| `~/.synod/runs/<runId>/run.log.jsonl` + `artifacts/` | parseRunLog 读;checkpoint/workspaces.json 同目录 | T12/T13 | ✓ 路径一致 |
| `shortHash(s)` = sha1 前 8 | T3 提升为模块级导出,replayStep 用之对账 | T12 Step 3(闭包内定义) | ✓ 实现一字不改、仅作用域提升 |
| step 行 `key` = `<seq>:<node>:<hash8>` | parseRunLog 抽 `key.split(":")[2]` 取 hash | T12 Step 3 ⑤ | ✓ |
| step 行字段 `event/runId/stepId/node/type/attempt/ts/key/durationMs` + `output`\|`outputRef` | parseRunLog 配对解析 + 读 outputRef artifact | T12 Step 3 ⑤ | ✓ |
| `createLogger({ fs, clock, runsRoot })` / `pathsFor` / `ensureRunDir` / `writeJSONL(runId,obj)` | 不改其签名,仅提升 shortHash | T12 Step 3 | ✓ |
| `listRuns(runsRoot)` → `[{runId,startedAt,status}]` | T7 扩展读 checkpoint + 加 failedNode/worktrees | T13 | ✓ 回落分支保留 |
| `synod --runs` 子命令 | T7 调输出格式;T6 不动 | T13 ④ | ✓ |
| `getRunState(runId)` run-state `{reusedSessions,keyChains,disposed,lastSinkError,controller}` | T3 新增 `replay:` 一行 | T8 Step 3 ② | ✓ 叠加不改既有键 |
| `signalFor(runId)` / `abortRun(ctx)` | replayStep 与之并列;原语 getSignal 不动 | T8 Step 3 ② | ✓ |
| `raceAbort` from `abortable.mjs` | agentLoop 完整实现保留其 send 包裹 | T8 Step 3 ① | ✓ |
| 原语工厂 `getSignal` 入参 | T3 并列加 `getReplay`;T8 加 `headless/events/runsRoot`(approve);T10 加 `acquireWorkspace`(agent) | T8/T9 | ✓ 叠加 |
| `createApprove({io,logger,getSignal})` signal 缺省回落 | T5/T8 在其入口前加重放/headless,保留 signal 回落 | T9 Step 3 ③ | ✓ |
| `createBash({logger,getSignal})` `bash(ctx,cmd,{cwd,signal})` | T5 入口前加重放,保留 `sig = signal ?? getSignal?.()` | T9 Step 3 ② | ✓ |
| `reviseWithHuman(ctx,draft,opts)` opts 透传 | T5/T8 不改;经 agent/approve 间接重放/断点 | T4 Step 3 ③ | ✓ |
| flow.main 签名 `{argv,...,io,signal,runsRoot,fs}` + `--`/`discoverFlows {flows,errors}`/直接 loadFlow/`writeLatestPointer` | T6 叠加 `resume/headless`;收尾叠加 checkpoint/finalize | T11/T12/T13 | ✓ |
| `createCtx({input,cwd})`(ctx.mjs 已支持 runId) | T3 runtime.createCtx 透传 `runId` 给 ctx.mjs | ctx.mjs 现状(已读)| ✓ ctx.mjs 已接受 runId |
| cli `runFlow(flowArgv)` + `flowIo` + `_activeFlows`/`_pendingFlows` + `flowsRoot` + `config` | T6 旁加 `resumeFlow`(复用 flowIo);T11 加启动顺扫 | T11 Step 3 ② | ✓ |
| InputRouter `router.claim` 经 `flowIo.question` | T6 resumeFlow 复用 flowIo(同唯一 readline) | T10/T11 | ✓ |
| `installShutdownHandlers` / `closeAllLiveSessionsSync` / `gracefulShutdown` | 不改;退出码 5 经 flow.main return 透传,非信号路径 | T11(1C-a) | ✓ 不冲突 |

**与现状代码核实的锚点(亲读源码,行号已核):**
- `src/flow/ctx.mjs:73` `createCtx({ runId, cwd, input, parentRunId, depth })` 已接受 `runId`——T3 的 `runtime.createCtx(input,{cwd,runId})` 透传可行,无需改 ctx.mjs。
- `src/flow/api/resolve-opts.mjs:12-14` 对未知字段(如 `workspace`/`signal`)**透传**(spread 全部 entries)——T4 `agentOnce` 解构 `workspace` 能拿到值。
- `src/flow/api/agent.mjs:96-99` `agentOnce` 解构、`:122-130` `openBackend({…cwd: ctx.cwd})`、`:71-74` `sessionKeyOf` 6 元组——T4/T10 在此插入重放短路、改 `cwd: agentCwd`、`sessionKeyOf` 加第 7 元 `workspace`。
- `src/flow/api/bash.mjs:29` `bash(ctx,cmd,{cwd})`、`:36` `execAsync`——T5 入口前加重放;1C-a Task 9 已把签名扩为 `{cwd,signal}`。
- `src/flow/api/approve.mjs:67-72` 解构 + `:82` `io.question`——T5/T8 在 `:74` 呈现 content 之前插重放/headless。
- `src/flow/api/agentLoop.mjs:46` 起整函数——T4 整体替换为惰性开会话版(并入 1C-a raceAbort)。
- `src/flow/logger.mjs:35` `createLogger` 闭包(1C-a 把 `shortHash`/`nextSeq`/`pathsFor` 加于此)——T3 提升 `shortHash` 为模块级导出。
- `src/flow.mjs:209` `main` 签名、`:296-317` 找 flow + createCtx、`:318-327` 收尾 try/catch、`:43` `parseFlowArgs`、`:345` run guard——T6/T8/T10 叠加 resume/headless/checkpoint/finalize。
- `src/cli.mjs:286` `parseArgs`、`:297` reap 分支、`:379` `runFlow`、`:444` 开场 `sm.open`、`:489` 导出区——T6/T11 加 resume 子命令/resumeFlow/顺扫/导出。
- `src/runs.mjs`(1C-a 新建)`listRuns`——T7 读 checkpoint 增强。

**写作中发现的冲突(交人裁决项):无阻断冲突。** 唯一需执行者注意的协调点已在正文标注:T6 与 T10 都改 flow.main 的 run 收尾区(T6 写不含 worktree 的中间态、T10 收口并入 finalize/checkpoint.worktrees),按 Task 顺序执行、以 T10 最终形态为准——这是同一区域的渐进式改造,非矛盾。

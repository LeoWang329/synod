import { test } from "node:test";
import assert from "node:assert";
import { getEventListeners } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { createFlowTui } from "../../../src/ui/tui/flow-tui.mjs";

function mk(flowMain) {
  const store = createStore();
  const ft = createFlowTui({ store, openBackend: () => {}, workflowsRoot: "/x", cwd: "/x", config: {}, flowMain, dropDelayMs: 5 });
  return { store, ft };
}

test("runFlow:多 agent 投影到一张 ⑂<flowName> 卡,条目按发言人归属;结束 done", async () => {
  const flowMain = async ({ progress }) => {
    progress.emit({ type: "opening", agent: "planner", model: "m" });
    progress.emit({ type: "delta", agent: "planner", model: "m", text: "拆解" });
    progress.emit({ type: "start", agent: "coder", model: "m" });
    progress.emit({ type: "delta", agent: "coder", model: "m", text: "写码" });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["研发流"]);
  const labels = store.getState().order;
  const fl = labels.find((l) => l.startsWith("⑂研发流"));
  assert.ok(fl, "应有 ⑂研发流 卡");
  assert.strictEqual(labels.filter((l) => l.startsWith("⑂")).length, 1, "只有一张 flow 卡(非每 agent 一张)");
  const s = store.getState().sessions[fl];
  assert.deepStrictEqual(s.agents, ["planner", "coder"]);
  assert.deepStrictEqual(s.entries.map((e) => [e.agent, e.text]), [["planner", "拆解"], ["coder", "写码"]]);
  assert.strictEqual(s.status, "done");
});

test("io.question:置 awaiting,pendingQuestion={agent,prompt};answer() resolve 引擎", async () => {
  let resolved = null;
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "review", model: null });
    resolved = await io.question("接受?", {});
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  assert.deepStrictEqual(store.getState().sessions[fl].pendingQuestion, { agent: "review", prompt: "接受?" });
  assert.strictEqual(store.getState().sessions[fl].status, "awaiting");
  assert.strictEqual(ft.answer(fl, "y"), true);
  await p;
  assert.strictEqual(resolved, "y");
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, null);
});

test("abortAll:拒绝待答问题,引擎据 signal 收口", async () => {
  let rejected = false;
  const flowMain = async ({ progress, io, signal }) => {
    progress.emit({ type: "start", agent: "review", model: null });
    try { await io.question("接受?", { signal }); } catch { rejected = true; }
    return 1;
  };
  const { ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 10));
  ft.abortAll();
  await p;
  assert.strictEqual(rejected, true);
});

test("flowStatus:运行中计数,空闲 none", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const flowMain = async () => { await gate; return 0; };
  const { ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(ft.flowStatus(), /running/);
  release(); await p;
  assert.strictEqual(ft.flowStatus(), "none");
});

test("io.stdout.write 投影成带发言人的 output 条", async () => {
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "planner", model: "m" });
    io.stdout.write("行内输出");
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["研发流"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  assert.ok(store.getState().sessions[fl].entries.some((e) => e.type === "output" && e.agent === "planner" && e.text === "行内输出"));
});

test("answer 后移除 abort 监听器(同一 flow 顺序两问不泄漏)", async () => {
  let sig;
  const flowMain = async ({ progress, io, signal }) => {
    sig = signal;
    progress.emit({ type: "start", agent: "review", model: null });
    await io.question("q1", { signal });
    await io.question("q2", { signal });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 10));
  let fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  ft.answer(fl, "a1");
  await new Promise((r) => setTimeout(r, 10));
  fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  ft.answer(fl, "a2");
  await p;
  assert.strictEqual(getEventListeners(sig, "abort").length, 0, "answered 不应残留 abort 监听器");
});

test("handleHumanLine:有待答→作答并吞掉;非 flow→不处理", async () => {
  const flowMain = async ({ progress, io }) => { progress.emit({ type: "start", agent: "review", model: null }); await io.question("?", {}); return 0; };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["研发流"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂研发流"));
  assert.strictEqual(ft.handleHumanLine(fl, "y"), true);
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, null);
  await p;
  assert.strictEqual(ft.handleHumanLine("omp#1", "hi"), false);
});

test("handleHumanLine:flow 会话无待答 → 拒绝(系统消息)", () => {
  const { store, ft } = mk(async () => 0);
  store.attachFlow("⑂x#f9", { flowId: "f9", flowName: "x" });
  const before = store.getState().system.length;
  assert.strictEqual(ft.handleHumanLine("⑂x#f9", "hi"), true);
  assert.ok(store.getState().system.length > before);
});

test("io.stdout.write 无对应卡(/flow --list)→ 落系统消息,不静默丢", async () => {
  const flowMain = async ({ io }) => { io.stdout.write("flow-a: 描述\nflow-b: 描述\n"); return 0; };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["--list"]);
  const sys = store.getState().system;
  assert.ok(sys.some((m) => /flow-a: 描述/.test(m)), "应有 flow-a 行");
  assert.ok(sys.some((m) => /flow-b: 描述/.test(m)), "应有 flow-b 行");
});

test("flowName 从 argv 跳过前置 flag(--progress/-- 不当成名字)", async () => {
  const { store, ft } = mk(async () => 0);
  await ft.runFlow(["--progress", "myflow"]);
  await ft.runFlow(["--progress", "--", "other", "{\"x\":1}"]);
  const sys = store.getState().system;
  assert.ok(sys.some((m) => /flow myflow 结束/.test(m)), "['--progress','myflow'] → myflow");
  assert.ok(sys.some((m) => /flow other 结束/.test(m)), "['--progress','--','other',…] → other");
  assert.ok(!sys.some((m) => /--progress/.test(m)), "摘要不出现 --progress");
});

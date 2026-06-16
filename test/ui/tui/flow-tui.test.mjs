import { test } from "node:test";
import assert from "node:assert";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { createFlowTui } from "../../../src/ui/tui/flow-tui.mjs";

function mk(flowMain) {
  const store = createStore();
  const ft = createFlowTui({ store, openBackend: () => {}, workflowsRoot: "/x", cwd: "/x", config: {}, flowMain, dropDelayMs: 5 });
  return { store, ft };
}

test("runFlow:progress 事件投影成 flow 卡 + 流式;结束后 endFlow", async () => {
  let captured;
  const flowMain = async ({ progress }) => { captured = progress; progress.emit({ type: "opening", agent: "planner", model: "m" }); progress.emit({ type: "delta", agent: "planner", model: "m", text: "hi" }); return 0; };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["demo"]);
  const labels = store.getState().order;
  const fl = labels.find((l) => l.startsWith("⑂planner"));
  assert.ok(fl, "应有 ⑂planner 卡");
  assert.strictEqual(store.getState().sessions[fl].entries.find((e) => e.type === "assistant").text, "hi");
  assert.strictEqual(store.getState().sessions[fl].status, "done");
});

test("io.question:置 awaiting,answer() 即 resolve 引擎 Promise", async () => {
  let resolved = null;
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "review", model: null });
    const ans = await io.question("接受?", {});
    resolved = ans;
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["demo"]);
  await new Promise((r) => setTimeout(r, 10));   // 让 flowMain 跑到 question
  const fl = store.getState().order.find((l) => l.startsWith("⑂review"));
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, "接受?");
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
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["demo"]);
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
  const p = ft.runFlow(["demo"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(ft.flowStatus(), /running/);
  release(); await p;
  assert.strictEqual(ft.flowStatus(), "none");
});

import { test } from "node:test";
import assert from "node:assert";
import { createStore } from "../../../src/ui/tui/store.mjs";

const L = "⑂planner#f1";

test("attachFlowAgent 建只读 flow 卡,进 sessions+order,默认焦点", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: "m" });
  const s = store.getState().sessions[L];
  assert.strictEqual(s.kind, "flow");
  assert.strictEqual(s.flowId, "f1");
  assert.strictEqual(s.agent, "planner");
  assert.strictEqual(s.status, "running");
  assert.ok(store.getState().order.includes(L));
  assert.strictEqual(store.getState().focusLabel, L);
});

test("appendFlowDelta 追加到末条 assistant(打字机式),缺卡则 no-op", () => {
  const store = createStore();
  store.appendFlowDelta("无此卡", "x");   // 不抛
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.appendFlowDelta(L, "hel"); store.appendFlowDelta(L, "lo");
  const ent = store.getState().sessions[L].entries;
  assert.strictEqual(ent.length, 1);
  assert.strictEqual(ent[0].type, "assistant");
  assert.strictEqual(ent[0].text, "hello");
});

test("setFlowQuestion 置 pendingQuestion+awaiting+approve 条;firstAwaiting 选中它", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.setFlowQuestion(L, "接受 diff?");
  const s = store.getState().sessions[L];
  assert.strictEqual(s.pendingQuestion, "接受 diff?");
  assert.strictEqual(s.status, "awaiting");
  assert.ok(s.entries.some((e) => e.type === "approve" && e.text === "接受 diff?"));
  assert.strictEqual(store.firstAwaiting(), L);
});

test("resolveFlowQuestion 清 pendingQuestion 回 running", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.setFlowQuestion(L, "q");
  store.resolveFlowQuestion(L);
  const s = store.getState().sessions[L];
  assert.strictEqual(s.pendingQuestion, null);
  assert.strictEqual(s.status, "running");
});

test("endFlow 标 done/failed + 系统消息;dropFlow 撤掉该 flow 全部卡并修焦点", () => {
  const store = createStore();
  store.attachFlowAgent("⑂a#f1", { flowId: "f1", agent: "a", model: null });
  store.attachFlowAgent("⑂b#f1", { flowId: "f1", agent: "b", model: null });
  store.endFlow("f1", { ok: true, summary: "flow done" });
  assert.strictEqual(store.getState().sessions["⑂a#f1"].status, "done");
  assert.ok(store.getState().system.includes("flow done"));
  store.dropFlow("f1");
  assert.strictEqual(store.getState().sessions["⑂a#f1"], undefined);
  assert.ok(!store.getState().order.some((l) => l.endsWith("#f1")));
  assert.strictEqual(store.getState().focusLabel, null);
});

test("appendFlowOutput 追加 output 条(approve 正文/diff 可见)", () => {
  const store = createStore();
  store.attachFlowAgent(L, { flowId: "f1", agent: "planner", model: null });
  store.appendFlowOutput(L, "diff --git ...");
  assert.ok(store.getState().sessions[L].entries.some((e) => e.type === "output" && /diff/.test(e.text)));
});

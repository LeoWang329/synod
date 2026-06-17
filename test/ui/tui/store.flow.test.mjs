import { test } from "node:test";
import assert from "node:assert";
import { createStore } from "../../../src/ui/tui/store.mjs";

const L = "⑂研发流#f1";

test("attachFlow 建唯一只读 flow 卡(kind/flowName/默认聚焦)", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  const s = store.getState().sessions[L];
  assert.strictEqual(s.kind, "flow");
  assert.strictEqual(s.flowId, "f1");
  assert.strictEqual(s.flowName, "研发流");
  assert.strictEqual(s.status, "running");
  assert.deepStrictEqual(s.agents, []);
  assert.ok(store.getState().order.includes(L));
  assert.strictEqual(store.getState().focusLabel, L);
});

test("appendFlowDelta:同发言人累加一段,切换另起一段;登记花名册;缺卡 no-op", () => {
  const store = createStore();
  store.appendFlowDelta("无此卡", "x", "y");   // 不抛
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.appendFlowDelta(L, "planner", "拆"); store.appendFlowDelta(L, "planner", "解");
  store.appendFlowDelta(L, "coder", "写码");
  const ent = store.getState().sessions[L].entries;
  assert.strictEqual(ent.length, 2);
  assert.deepStrictEqual([ent[0].type, ent[0].agent, ent[0].text], ["assistant", "planner", "拆解"]);
  assert.deepStrictEqual([ent[1].type, ent[1].agent, ent[1].text], ["assistant", "coder", "写码"]);
  assert.deepStrictEqual(store.getState().sessions[L].agents, ["planner", "coder"]);
  assert.strictEqual(store.getState().sessions[L].lastLine, "拆解写码");
});

test("noteFlowAgent 幂等登记参与者", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.noteFlowAgent(L, "planner"); store.noteFlowAgent(L, "planner"); store.noteFlowAgent(L, "review");
  assert.deepStrictEqual(store.getState().sessions[L].agents, ["planner", "review"]);
});

test("setFlowQuestion:pendingQuestion 为 {agent,prompt}+awaiting+approve 条;firstAwaiting 命中", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.setFlowQuestion(L, "review", "接受 diff?");
  const s = store.getState().sessions[L];
  assert.deepStrictEqual(s.pendingQuestion, { agent: "review", prompt: "接受 diff?" });
  assert.strictEqual(s.status, "awaiting");
  assert.ok(s.entries.some((e) => e.type === "approve" && e.agent === "review" && e.text === "接受 diff?"));
  assert.ok(s.agents.includes("review"));
  assert.strictEqual(store.firstAwaiting(), L);
});

test("resolveFlowQuestion 清 pendingQuestion 回 running", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.setFlowQuestion(L, "review", "q");
  store.resolveFlowQuestion(L);
  const s = store.getState().sessions[L];
  assert.strictEqual(s.pendingQuestion, null);
  assert.strictEqual(s.status, "running");
});

test("appendFlowOutput 追加带发言人的 output 条", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.appendFlowOutput(L, "coder", "diff --git ...");
  const e = store.getState().sessions[L].entries.find((x) => x.type === "output");
  assert.ok(e && e.agent === "coder" && /diff/.test(e.text));
  assert.ok(store.getState().sessions[L].agents.includes("coder"));
});

test("endFlow 标 done + 系统消息;dropFlow 撤该 flow 卡并修焦点", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.endFlow("f1", { ok: true, summary: "flow done" });
  assert.strictEqual(store.getState().sessions[L].status, "done");
  assert.ok(store.getState().system.includes("flow done"));
  store.dropFlow("f1");
  assert.strictEqual(store.getState().sessions[L], undefined);
  assert.ok(!store.getState().order.includes(L));
  assert.strictEqual(store.getState().focusLabel, null);
});

test("endFlow ok:false → failed + summary 进系统消息", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });
  store.endFlow("f1", { ok: false, summary: "boom" });
  assert.strictEqual(store.getState().sessions[L].status, "failed");
  assert.ok(store.getState().system.includes("boom"));
});

test("setFlowQuestion:非焦点 flow 卡 → 焦点会话流冒确认 nudge(^G 去看)", () => {
  const store = createStore();
  store.attachSession("real#1", { on() {} }, "omp", {});
  store.attachFlow(L, { flowId: "f1", flowName: "研发流" });   // 非焦点
  store.setFlowQuestion(L, "review", "接受?");
  const fe = store.getState().sessions["real#1"].entries;
  assert.ok(fe.some((e) => e.type === "nudge" && /要你确认/.test(e.text)));
});

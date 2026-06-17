import { test } from "node:test";
import assert from "node:assert";
import { createStore } from "../../../src/ui/tui/store.mjs";

const L = "⑂qa#f1";

test("attachFlow 建唯一只读 flow 卡(kind/flowName/默认聚焦)", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  const s = store.getState().sessions[L];
  assert.strictEqual(s.kind, "flow");
  assert.strictEqual(s.flowId, "f1");
  assert.strictEqual(s.flowName, "qa");
  assert.strictEqual(s.status, "running");
  assert.deepStrictEqual(s.agents, []);
  assert.ok(store.getState().order.includes(L));
  assert.strictEqual(store.getState().focusLabel, L);
});

test("appendFlowDelta:同 turn 累加,turn 变另起段(含同 speaker 不同 turn);登记花名册;缺卡 no-op", () => {
  const store = createStore();
  store.appendFlowDelta("无此卡", 1, "x", "y");   // 不抛
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  // 真引擎里发言人靠 model 短名区分;store 只认 turn+speaker。
  store.appendFlowDelta(L, 1, "mimo", "出"); store.appendFlowDelta(L, 1, "mimo", "题");
  store.appendFlowDelta(L, 2, "minimax", "回答");
  store.appendFlowDelta(L, 3, "mimo", "评审");   // 同 speaker(mimo)但新 turn → 必须另起一段
  const ent = store.getState().sessions[L].entries;
  assert.strictEqual(ent.length, 3, "同 turn 合并、不同 turn 分段 → 3 段");
  assert.deepStrictEqual(ent.map((e) => [e.turn, e.agent, e.text]), [[1, "mimo", "出题"], [2, "minimax", "回答"], [3, "mimo", "评审"]]);
  assert.deepStrictEqual(store.getState().sessions[L].agents, ["mimo", "minimax"], "花名册去重");
  assert.strictEqual(store.getState().sessions[L].lastLine, "评审", "lastLine 取当前 turn,不粘上一段");
});

test("noteFlowAgent 幂等登记参与者(发言人标签)", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  store.noteFlowAgent(L, "mimo"); store.noteFlowAgent(L, "mimo"); store.noteFlowAgent(L, "minimax");
  assert.deepStrictEqual(store.getState().sessions[L].agents, ["mimo", "minimax"]);
});

test("noteFlowTurn 记花名册(speaker)+ 最后真后端身份(lastAgent/lastModel,供续聊)", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  store.noteFlowTurn(L, { speaker: "mimo-v2.5-pro", agent: "omp", model: "xiaomi/mimo-v2.5-pro" });
  store.noteFlowTurn(L, { speaker: "MiniMax-M3", agent: "omp", model: "minimax/MiniMax-M3" });
  const s = store.getState().sessions[L];
  assert.deepStrictEqual(s.agents, ["mimo-v2.5-pro", "MiniMax-M3"]);
  assert.strictEqual(s.lastAgent, "omp");
  assert.strictEqual(s.lastModel, "minimax/MiniMax-M3");   // 取最后一个 turn
});

test("noteFlowTurn:最后 turn 无 model → lastModel 置 null(不串上一 turn 的旧 model)", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  store.noteFlowTurn(L, { speaker: "mimo-v2.5-pro", agent: "omp", model: "xiaomi/mimo-v2.5-pro" });
  store.noteFlowTurn(L, { speaker: "codex", agent: "codex", model: undefined });   // review 无 model
  const s = store.getState().sessions[L];
  assert.strictEqual(s.lastAgent, "codex");
  assert.strictEqual(s.lastModel, null, "不能保留上一个 turn 的 model(否则 agent/model 错配)");
});

test("setFlowQuestion:pendingQuestion={agent,prompt}+awaiting+approve 条(带 turn);firstAwaiting 命中", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  store.setFlowQuestion(L, 2, "mimo", "接受?");
  const s = store.getState().sessions[L];
  assert.deepStrictEqual(s.pendingQuestion, { agent: "mimo", prompt: "接受?" });
  assert.strictEqual(s.status, "awaiting");
  assert.ok(s.entries.some((e) => e.type === "approve" && e.turn === 2 && e.agent === "mimo" && e.text === "接受?"));
  assert.ok(s.agents.includes("mimo"));
  assert.strictEqual(store.firstAwaiting(), L);
});

test("resolveFlowQuestion 清 pendingQuestion 回 running", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  store.setFlowQuestion(L, 1, "mimo", "q");
  store.resolveFlowQuestion(L);
  const s = store.getState().sessions[L];
  assert.strictEqual(s.pendingQuestion, null);
  assert.strictEqual(s.status, "running");
});

test("appendFlowOutput 追加 flow 级 output 条(不归属发言人、不进花名册、无 turn)", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  store.appendFlowOutput(L, "diff --git ...");
  const e = store.getState().sessions[L].entries.find((x) => x.type === "output");
  assert.ok(e && /diff/.test(e.text));
  assert.strictEqual(e.agent, undefined, "flow 程序输出不挂在发言人名下");
  assert.strictEqual(e.turn, undefined, "无 turn → 渲染时不被归到某发言段");
  assert.deepStrictEqual(store.getState().sessions[L].agents, [], "output 不进花名册");
});

test("endFlow 标 done + 系统消息;dropFlow 撤该 flow 卡并修焦点", () => {
  const store = createStore();
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
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
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });
  store.endFlow("f1", { ok: false, summary: "boom" });
  assert.strictEqual(store.getState().sessions[L].status, "failed");
  assert.ok(store.getState().system.includes("boom"));
});

test("setFlowQuestion:非焦点 flow 卡 → 焦点会话流冒确认 nudge(^G 去看)", () => {
  const store = createStore();
  store.attachSession("real#1", { on() {} }, "omp", {});
  store.attachFlow(L, { flowId: "f1", flowName: "qa" });   // 非焦点
  store.setFlowQuestion(L, 1, "mimo", "接受?");
  const fe = store.getState().sessions["real#1"].entries;
  assert.ok(fe.some((e) => e.type === "nudge" && /要你确认/.test(e.text)));
});

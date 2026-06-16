// test/ui/tui/store.awaiting.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";

function turn(emitter) { // 模拟一个 turn:running → idle
  emitter.emit("status", { status: "running", isStreaming: true });
  emitter.emit("status", { status: "idle", isStreaming: false });
}

test("后台 session turn 结束 → awaiting + 焦点流出现 nudge 条目", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});   // 首个 attach → 自动成焦点
  store.attachSession("omp#2", b, "omp", {});
  turn(b);                                       // omp#2 是后台
  assert.strictEqual(store.getState().sessions["omp#2"].status, "awaiting");
  const nudges = store.getState().sessions["omp#1"].entries.filter((e) => e.type === "nudge");
  assert.strictEqual(nudges.length, 1);
  assert.strictEqual(nudges[0].target, "omp#2");
});
test("焦点 session 自己 turn 结束 → 不 awaiting、无 nudge", () => {
  const store = createStore();
  const a = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  turn(a);
  assert.strictEqual(store.getState().sessions["omp#1"].status, "idle");
  assert.strictEqual(store.getState().sessions["omp#1"].entries.filter((e) => e.type === "nudge").length, 0);
});
test("setFocus 到 awaiting 的 session → 清回 idle", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  turn(b);
  store.setFocus("omp#2");
  assert.strictEqual(store.getState().sessions["omp#2"].status, "idle");
});
test("focusNext 跨到 awaiting → 清回 idle", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  turn(b);
  store.focusNext();   // omp#1 → omp#2
  assert.strictEqual(store.getState().focusLabel, "omp#2");
  assert.strictEqual(store.getState().sessions["omp#2"].status, "idle");
});
test("firstAwaiting 返回首个 awaiting label,无则 null", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  assert.strictEqual(store.firstAwaiting(), null);
  turn(b);
  assert.strictEqual(store.firstAwaiting(), "omp#2");
});
test("后台 session error → awaiting + nudge", () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});
  store.attachSession("omp#2", b, "omp", {});
  b.emit("error", new Error("boom"));
  assert.strictEqual(store.getState().sessions["omp#2"].status, "awaiting");
  assert.ok(store.getState().sessions["omp#1"].entries.some((e) => e.type === "nudge" && e.target === "omp#2"));
});

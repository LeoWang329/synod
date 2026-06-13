import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
const fakeSession = () => new EventEmitter();

test("attachSession 注册会话,默认焦点为第一个", () => {
  const store = createStore();
  store.attachSession("omp#1", fakeSession(), "omp", { model: "m" });
  assert.strictEqual(store.getState().focusLabel, "omp#1");
  assert.strictEqual(store.getState().sessions["omp#1"].agent, "omp");
});
test("delta 累积当前 turn 文本 + 记 lastLine", () => {
  const store = createStore(); const s = fakeSession();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "hello "); s.emit("delta", "world\nsecond");
  const sess = store.getState().sessions["omp#1"];
  assert.match(sess.assistantText, /hello world\nsecond/);
  assert.strictEqual(sess.lastLine, "second");
  assert.strictEqual(sess.status, "running");
});
test("status idle 收尾 turn,turn 计数 +1", () => {
  const store = createStore(); const s = fakeSession();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "answer");
  s.emit("status", { status: "idle", isStreaming: false });
  const sess = store.getState().sessions["omp#1"];
  assert.strictEqual(sess.status, "idle"); assert.strictEqual(sess.turn, 1);
});
test("setFocus / focusNext 切换焦点;subscribe 收到通知", () => {
  const store = createStore();
  store.attachSession("omp#1", fakeSession(), "omp", {});
  store.attachSession("codex#1", fakeSession(), "codex", {});
  let hits = 0; store.subscribe(() => { hits += 1; });
  store.setFocus("codex#1");
  assert.strictEqual(store.getState().focusLabel, "codex#1");
  store.setFocus("omp#1"); store.focusNext();
  assert.strictEqual(store.getState().focusLabel, "codex#1");
  assert.ok(hits >= 1);
});
test("pushSystem 记系统消息;error 事件进系统消息", () => {
  const store = createStore(); const s = fakeSession();
  store.attachSession("omp#1", s, "omp", {});
  store.pushSystem("Relay added: a->b");
  s.emit("error", new Error("boom"));
  const sys = store.getState().system;
  assert.ok(sys.includes("Relay added: a->b"));
  assert.match(sys.at(-1), /omp#1.*boom/);
});
test("dropSession 移除并重选焦点", () => {
  const store = createStore();
  store.attachSession("omp#1", fakeSession(), "omp", {});
  store.attachSession("codex#1", fakeSession(), "codex", {});
  store.setFocus("omp#1"); store.dropSession("omp#1");
  assert.strictEqual(store.getState().sessions["omp#1"], undefined);
  assert.strictEqual(store.getState().focusLabel, "codex#1");
});

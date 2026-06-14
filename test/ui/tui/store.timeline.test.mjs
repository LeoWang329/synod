import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { registerEventAdapter } from "../../../src/ui/tui/events.mjs";
import { ompAdapter } from "../../../src/ui/tui/adapters.omp.mjs";

registerEventAdapter("omp", ompAdapter);   // 用真 omp 适配器驱动 toolevent

const sess = () => new EventEmitter();

test("assistant 增量进 entries;遇 tool 后文本另起 assistant 条", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "前段");
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: { path: "a" } });
  s.emit("delta", "后段");
  const e = store.getState().sessions["omp#1"].entries;
  assert.deepStrictEqual(e.map((x) => x.type), ["assistant", "tool", "assistant"]);
  assert.strictEqual(e[0].text, "前段");
  assert.strictEqual(e[1].name, "read_file");
  assert.strictEqual(e[1].status, "running");
  assert.strictEqual(e[2].text, "后段");
});

test("tool.end 按 id upsert 同一张卡为 done + output", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  s.emit("toolevent", { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "done-out" }] } });
  const tools = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "tool");
  assert.strictEqual(tools.length, 1);            // upsert 不新增
  assert.strictEqual(tools[0].status, "done");
  assert.match(tools[0].output, /done-out/);
});

test("只见 tool.end(codex 一次性)也成一张 done 卡", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});   // 用 ompAdapter,但直接灌 end 验证 upsert 新建
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_end", toolCallId: "z9", result: { content: [{ text: "x" }] } });
  const tools = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "tool");
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].status, "done");
});

test("tool.end 无 id(undefined/null)→ 不 upsert,各自追加一张卡(codex 无 id 回退的回归保护)", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  // 无 toolCallId → ompAdapter 产出 id:undefined → store `ev.id != null` 为 false → 不合并,各追加一张
  s.emit("toolevent", { type: "tool_execution_end", result: { content: [{ text: "out1" }] } });
  s.emit("toolevent", { type: "tool_execution_end", result: { content: [{ text: "out2" }] } });
  const tools = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "tool");
  assert.strictEqual(tools.length, 2);
});

test("pushUser 在时间线追加 user 条;P1 assistantText 仍随 delta 维护", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  store.pushUser("omp#1", "给它加测试");
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "好的");
  const sObj = store.getState().sessions["omp#1"];
  assert.strictEqual(sObj.entries[0].type, "user");
  assert.strictEqual(sObj.entries[0].text, "给它加测试");
  assert.match(sObj.assistantText, /好的/);     // P1 字段不破坏(AgentRail 依赖)
  assert.strictEqual(sObj.lastLine, "好的");
});

test("toggleEntry 翻转某条 expanded;subscribe 收到通知", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  let hits = 0; store.subscribe(() => hits++);
  const idx = store.getState().sessions["omp#1"].entries.findIndex((x) => x.type === "tool");
  store.toggleEntry("omp#1", idx);
  assert.strictEqual(store.getState().sessions["omp#1"].entries[idx].expanded, true);
  assert.ok(hits >= 1);
});

test("新 turn(running)不清空既有 entries(完整 timeline)", () => {
  const store = createStore(); const s = sess();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "turn1");
  s.emit("status", { status: "idle", isStreaming: false });
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("delta", "turn2");
  const e = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "assistant");
  assert.strictEqual(e.length, 2);                // 两个 turn 两条 assistant,旧的不清
  assert.strictEqual(e[0].text, "turn1");
  assert.strictEqual(e[1].text, "turn2");
});

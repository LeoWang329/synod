// test/backend.toolevent.test.mjs — TDD: toolevent channel (P2 task1)
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";

// 用最小桩验证「派发逻辑」:把待测的纯函数从 backend.mjs 导出后直接调。
import { emitToolEventFromOmp, emitToolEventFromCodexItem } from "../src/backend.mjs";

test("omp tool_execution_start → toolevent 原样(不截断)", () => {
  const em = new EventEmitter(); const seen = [];
  em.on("toolevent", (e) => seen.push(e));
  const longArgs = { path: "x".repeat(500) };  // >300,验证不被截断
  const msg = { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: longArgs, intent: "读文件" };
  const handled = emitToolEventFromOmp(em, msg);
  assert.strictEqual(handled, true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0], msg);                  // 同一引用 = 未拷贝未截断
  assert.strictEqual(seen[0].args.path.length, 500); // 未截断
});

test("omp tool_execution_end → toolevent 原样", () => {
  const em = new EventEmitter(); const seen = [];
  em.on("toolevent", (e) => seen.push(e));
  const msg = { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "ok".repeat(400) }] } };
  assert.strictEqual(emitToolEventFromOmp(em, msg), true);
  assert.strictEqual(seen[0].result.content[0].text.length, 800);
});

test("omp 非工具消息 → 不发 toolevent,返回 false", () => {
  const em = new EventEmitter(); let n = 0;
  em.on("toolevent", () => n++);
  assert.strictEqual(emitToolEventFromOmp(em, { type: "message_update" }), false);
  assert.strictEqual(n, 0);
});

test("codex 工具 item → toolevent 带完整 item;agentMessage/未知类型 → 不发(allowlist)", () => {
  const em = new EventEmitter(); const seen = [];
  em.on("toolevent", (e) => seen.push(e));
  const toolItem = { type: "commandExecution", id: "c1", command: "ls", aggregatedOutput: "a".repeat(500) };
  assert.strictEqual(emitToolEventFromCodexItem(em, toolItem), true);
  assert.strictEqual(seen[0].item, toolItem);
  assert.strictEqual(emitToolEventFromCodexItem(em, { type: "agentMessage", text: "hi" }), false);
  assert.strictEqual(emitToolEventFromCodexItem(em, { type: "reasoning", text: "思考" }), false); // 非工具 item 不冒伪卡
  assert.strictEqual(seen.length, 1);
});

test("codex allowlist 对齐真实 v2 schema:dynamic/collab 工具型→发;patchApply(非法 type)→不发", () => {
  const em = new EventEmitter(); const seen = [];
  em.on("toolevent", (e) => seen.push(e));
  assert.strictEqual(emitToolEventFromCodexItem(em, { type: "dynamicToolCall", id: "d1" }), true);
  assert.strictEqual(emitToolEventFromCodexItem(em, { type: "collabAgentToolCall", id: "k1" }), true);
  assert.strictEqual(emitToolEventFromCodexItem(em, { type: "patchApply", id: "p1" }), false); // 非合法 ThreadItem.type
  assert.strictEqual(seen.length, 2);
});

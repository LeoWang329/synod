import { test } from "node:test";
import assert from "node:assert";
import { codexAdapter } from "../../../src/ui/tui/adapters.codex.mjs";

test("delta/status 同默认", () => {
  assert.deepStrictEqual(codexAdapter({ channel: "delta", payload: "hi" }), { kind: "message.delta", text: "hi" });
});
test("toolevent tool.item(commandExecution)→ tool.end 一次性完成", () => {
  const item = { type: "commandExecution", id: "c1", command: "ls -la", aggregatedOutput: "total 0", status: "completed" };
  const ev = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item } });
  assert.strictEqual(ev.kind, "tool.end");
  assert.strictEqual(ev.id, "c1");
  assert.strictEqual(ev.name, "commandExecution");
  assert.match(ev.output, /total 0/);
  assert.strictEqual(ev.ok, true);
});
test("toolevent fileChange → 带 diff", () => {
  const item = { type: "fileChange", id: "f1", changes: [{ path: "a.js", diff: "@@ -1 +1 @@" }] };
  const ev = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item } });
  assert.strictEqual(ev.kind, "tool.end");
  assert.match(ev.diff, /@@ -1 \+1 @@/);
});
test("mcpToolCall 输出取 result.content[].text", () => {
  const item = { type: "mcpToolCall", id: "m1", arguments: { q: 1 }, result: { content: [{ text: "mcp-out-a" }, { text: "mcp-out-b" }] }, status: "completed" };
  const ev = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item } });
  assert.match(ev.output, /mcp-out-a[\s\S]*mcp-out-b/);
  assert.deepStrictEqual(ev.args, { q: 1 });
});
test("dynamicToolCall 输出取 contentItems[].text", () => {
  const item = { type: "dynamicToolCall", id: "d1", arguments: { x: 1 }, contentItems: [{ text: "dyn-out" }], status: "completed" };
  const ev = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item } });
  assert.match(ev.output, /dyn-out/);
});
test("webSearch args 取 query;collabAgentToolCall args 取 prompt", () => {
  const ws = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item: { type: "webSearch", id: "w1", query: "synod docs", status: "completed" } } });
  assert.strictEqual(ws.args, "synod docs");
  const ca = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item: { type: "collabAgentToolCall", id: "k1", prompt: "review this", status: "completed" } } });
  assert.strictEqual(ca.args, "review this");
});
test("status failed → ok:false", () => {
  const ev = codexAdapter({ channel: "toolevent", payload: { type: "tool.item", item: { type: "commandExecution", id: "c2", command: "x", aggregatedOutput: "", status: "failed" } } });
  assert.strictEqual(ev.ok, false);
});

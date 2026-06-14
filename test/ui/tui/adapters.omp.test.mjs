import { test } from "node:test";
import assert from "node:assert";
import { ompAdapter } from "../../../src/ui/tui/adapters.omp.mjs";

test("delta/status 与默认一致", () => {
  assert.deepStrictEqual(ompAdapter({ channel: "delta", payload: "hi" }), { kind: "message.delta", text: "hi" });
  assert.deepStrictEqual(ompAdapter({ channel: "status", payload: { status: "running", isStreaming: true } }),
    { kind: "status", status: "running", isStreaming: true });
});
test("toolevent tool_execution_start → tool.start", () => {
  const ev = ompAdapter({ channel: "toolevent", payload: { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: { path: "a" }, intent: "读" } });
  assert.deepStrictEqual(ev, { kind: "tool.start", id: "t1", name: "read_file", args: { path: "a" }, intent: "读" });
});
test("toolevent tool_execution_end → tool.end(取 result.content[].text 拼接)", () => {
  const ev = ompAdapter({ channel: "toolevent", payload: { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "line1" }, { text: "line2" }] } } });
  assert.strictEqual(ev.kind, "tool.end");
  assert.strictEqual(ev.id, "t1");
  assert.match(ev.output, /line1[\s\S]*line2/);
  assert.strictEqual(ev.ok, true);
});
test("event 通道(压缩流)P2 仍不消费 → null(工具走 toolevent)", () => {
  assert.strictEqual(ompAdapter({ channel: "event", payload: { type: "tool_execution_start" } }), null);
});

import { test } from "node:test";
import assert from "node:assert";
import { registerEventAdapter, getEventAdapter, defaultAdapter } from "../../../src/ui/tui/events.mjs";

test("默认适配器:delta → message.delta", () => {
  assert.deepStrictEqual(defaultAdapter({ channel: "delta", payload: "hi" }), { kind: "message.delta", text: "hi" });
});
test("默认适配器:status → status", () => {
  assert.deepStrictEqual(
    defaultAdapter({ channel: "status", payload: { status: "running", isStreaming: true } }),
    { kind: "status", status: "running", isStreaming: true });
});
test("默认适配器:event 通道 P1 不消费 → null", () => {
  assert.strictEqual(defaultAdapter({ channel: "event", payload: { type: "toolCall" } }), null);
});
test("注册制:注册后按 agent 取回,未注册回退默认", () => {
  const custom = () => ({ kind: "status", status: "x", isStreaming: false });
  registerEventAdapter("fake-agent", custom);
  assert.strictEqual(getEventAdapter("fake-agent"), custom);
  assert.strictEqual(getEventAdapter("never-registered"), defaultAdapter);
});

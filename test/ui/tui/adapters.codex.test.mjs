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

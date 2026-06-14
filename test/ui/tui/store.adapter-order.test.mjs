import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { registerEventAdapter } from "../../../src/ui/tui/events.mjs";
import { ompAdapter } from "../../../src/ui/tui/adapters.omp.mjs";

// 回归:store 必须在「先 attach、后 register 适配器」的真实 cli 顺序下仍能解析 toolevent。
// (cli 先 smTui.open()→attachSession,再在 startTui 里注册 omp/codex 适配器。)
// 单独文件 = 独立进程 = 模块级适配器表初始为空,真实模拟「注册前 attach」。
test("attachSession 先于 registerEventAdapter:tool 事件仍进 entries(适配器懒解析)", () => {
  const store = createStore();
  const s = new EventEmitter();
  store.attachSession("omp#1", s, "omp", {});   // 此刻 omp 适配器尚未注册 → 只有 defaultAdapter
  registerEventAdapter("omp", ompAdapter);       // 模拟 startTui 之后才注册
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  const tools = store.getState().sessions["omp#1"].entries.filter((x) => x.type === "tool");
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, "bash");
});

import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { App } from "../../../src/ui/tui/app.mjs";
import { EventEmitter } from "node:events";
import { registerEventAdapter } from "../../../src/ui/tui/events.mjs";
import { ompAdapter } from "../../../src/ui/tui/adapters.omp.mjs";
registerEventAdapter("omp", ompAdapter);

const ctx = { labels: () => ["omp#1"], flows: [], backends: () => ["omp"], profiles: () => [] };
function base(store) {
  return { store, dispatch: () => ({}), hintsCtx: ctx, mesh: true, onSelect: () => {}, onCycle: () => {}, onInterrupt: () => {} };
}

test("App 渲染焦点 label 与系统消息", () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", { model: "m" });
  store.pushSystem("Relay added: a->b");
  const { lastFrame } = render(html`<${App} ...${base(store)} />`);
  assert.match(lastFrame(), /omp#1/);
  assert.match(lastFrame(), /Relay added/);
});
test("回车把输入行交给 dispatch(source:human),并在之后同步焦点", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  const calls = [];
  const props = { ...base(store), dispatch: (line, opts) => { calls.push([line, opts]); return { redraw: true }; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("hello"); stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls.at(-1), ["hello", { source: "human" }]);
});
test("Tab 调 onCycle;Ctrl-C 调 onInterrupt", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  let cycled = 0, interrupted = 0;
  const props = { ...base(store), onCycle: () => { cycled++; }, onInterrupt: () => { interrupted++; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("\t");           // Tab
  stdin.write("\x03");         // Ctrl-C
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cycled >= 1); assert.ok(interrupted >= 1);
});
test("输入 /exit(dispatch 返回 {exit:true})→ 调 onInterrupt", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  let interrupted = 0;
  const props = { ...base(store), dispatch: () => ({ exit: true }), onInterrupt: () => { interrupted++; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("/exit"); stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(interrupted >= 1);
});
test("Ctrl-E 切换当前选中 tool 卡的 expanded(经 store.toggleEntry)", async () => {
  const store = createStore();
  const s = new EventEmitter();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  const { stdin } = render(html`<${App} ...${base(store)} />`);
  stdin.write("\x05");  // Ctrl-E
  await new Promise((r) => setTimeout(r, 20));
  const tool = store.getState().sessions["omp#1"].entries.find((x) => x.type === "tool");
  assert.strictEqual(tool.expanded, true);
});
test("↑/↓ 改为滚动焦点区(不再选卡);Ctrl-E 仍展开最近的 tool 卡", async () => {
  const store = createStore();
  const s = new EventEmitter();
  store.attachSession("omp#1", s, "omp", {});
  s.emit("status", { status: "running", isStreaming: true });
  s.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  s.emit("toolevent", { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "x" }] } });
  const { stdin } = render(html`<${App} ...${base(store)} />`);
  stdin.write("\x1b[A");  // ↑ 现在是滚动,不再选卡(不应抛错)
  stdin.write("\x1b[5~"); // PgUp
  stdin.write("\x1b");    // Esc 回最新
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\x05");    // Ctrl-E → 回退到「最近的 tool 卡」展开
  await new Promise((r) => setTimeout(r, 20));
  const tool = store.getState().sessions["omp#1"].entries.find((x) => x.type === "tool");
  assert.strictEqual(tool.expanded, true);
});

test("斜杠菜单打开:Tab 把高亮项补全进输入框(不轮换)", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  let cycled = 0;
  const props = { ...base(store), onCycle: () => { cycled++; } };
  const { stdin, lastFrame } = render(html`<${App} ...${props} />`);
  stdin.write("/op");          // 弹出 slash 菜单(唯一候选 /open)
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\t");           // Tab → 补全为 "/open "
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(cycled, 0, "菜单打开时 Tab 不应轮换");
  assert.match(lastFrame(), /\/open/);
});
test("斜杠菜单打开:↓ 移动高亮,Tab 补全的是被选中的那条", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  const { stdin, lastFrame } = render(html`<${App} ...${base(store)} />`);
  stdin.write("/");            // 全部 slash 命令,首项 /open 高亮
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\x1b[B");       // ↓ → 第二项 /use 高亮
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\t");           // Tab → 补全 /use
  await new Promise((r) => setTimeout(r, 20));
  assert.match(lastFrame(), /\/use /);
});
test("输入为空(无菜单)时 Tab 仍轮换", async () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  let cycled = 0;
  const props = { ...base(store), onCycle: () => { cycled++; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("\t");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cycled >= 1);
});

test("Ctrl-G 跳到 awaiting 的后台 agent(经 onSelect)", async () => {
  const store = createStore();
  const a = new EventEmitter(), b = new EventEmitter();
  store.attachSession("omp#1", a, "omp", {});   // 焦点
  store.attachSession("omp#2", b, "omp", {});
  b.emit("status", { status: "running", isStreaming: true });
  b.emit("status", { status: "idle", isStreaming: false });   // omp#2 → awaiting
  let picked = null;
  const props = { ...base(store), onSelect: (l) => { picked = l; } };
  const { stdin } = render(html`<${App} ...${props} />`);
  stdin.write("\x07");   // Ctrl-G
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(picked, "omp#2");
});

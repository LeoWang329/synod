import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { App } from "../../../src/ui/tui/app.mjs";
import { EventEmitter } from "node:events";

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

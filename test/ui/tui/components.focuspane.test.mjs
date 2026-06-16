// test/ui/tui/components.focuspane.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";

const sess = {
  agent: "omp", model: "m", effort: null, status: "running", isStreaming: true, turn: 1, ms: null,
  assistantText: "尾", lastLine: "尾",
  entries: [
    { type: "user", text: "做点事" },
    { type: "assistant", text: "好的我先读文件" },
    { type: "tool", id: "t1", name: "read_file", args: { path: "a" }, status: "done", ok: true, output: "x", diff: null, expanded: false },
    { type: "breadcrumb", text: "开了 codex#1" },
    { type: "nudge", text: "codex#1 跑完了", target: "codex#1" },
  ],
};
test("混排渲染 user/assistant/tool/breadcrumb/nudge", () => {
  const f = render(html`<${FocusPane} label="omp#1" sess=${sess} selectedIndex=${-1} />`).lastFrame();
  assert.match(f, /做点事/);
  assert.match(f, /我先读文件/);
  assert.match(f, /read_file/);
  assert.match(f, /开了 codex#1/);     // 面包屑
  assert.match(f, /codex#1 跑完了/);    // 冒泡
  assert.match(f, /去看/);              // 冒泡带 ^G 去看
});
test("不再渲染 C 编排意图 / D relay 折叠条", () => {
  const f = render(html`<${FocusPane} label="omp#1" sess=${sess} selectedIndex=${-1} />`).lastFrame();
  assert.ok(!f.includes("编排意图"));
  assert.ok(!f.includes("D relay"));
});
test("无会话给提示", () => {
  assert.match(render(html`<${FocusPane} label=${null} sess=${undefined} />`).lastFrame(), /无会话|\^O/);
});

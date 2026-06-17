import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";

test("FocusPane:flow 会话头部带 ⑂,output/approve 条目可渲染", () => {
  const sess = {
    kind: "flow", agent: "planner", model: "m", status: "awaiting", turn: 0,
    pendingQuestion: "接受 diff?",
    entries: [{ type: "assistant", text: "分析中" }, { type: "output", text: "diff xyz" }, { type: "approve", text: "接受 diff?" }],
  };
  const { lastFrame } = render(html`<${FocusPane} label="⑂planner:m#f1" sess=${sess} selectedIndex=${-1} />`);
  const f = lastFrame();
  assert.match(f, /⑂planner/);     // 头部显示名而非裸 label
  assert.match(f, /diff xyz/);      // output 条
  assert.match(f, /接受 diff/);     // approve 条
});

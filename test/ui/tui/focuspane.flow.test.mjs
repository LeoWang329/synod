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
  // label 故意不含 ⑂:这样 /⑂planner/ 只能由 display 修复(⑂agent)命中,而非裸 label 的子串
  const { lastFrame } = render(html`<${FocusPane} label="flow-session-1" sess=${sess} selectedIndex=${-1} />`);
  const f = lastFrame();
  assert.match(f, /⑂planner/);                    // 头部显示 ⑂agent 而非裸 label
  assert.doesNotMatch(f, /flow-session-1/);        // 裸 label 不泄漏到头部
  assert.match(f, /diff xyz/);                     // output 条
  assert.match(f, /↳ 接受 diff\? · 在下面作答/);   // approve 分支专属包裹(default 分支只渲染裸文本)
});

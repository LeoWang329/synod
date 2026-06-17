import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";

test("FocusPane flow 群聊:头部 ⑂flowName + 花名册;裸 label 不泄漏;output/approve 渲染", () => {
  const sess = {
    kind: "flow", flowName: "研发流", agent: "研发流", model: null, status: "awaiting", turn: 0,
    agents: ["planner", "coder", "review"],
    pendingQuestion: { agent: "review", prompt: "接受 diff?" },
    entries: [
      { type: "assistant", agent: "planner", text: "分析中" },
      { type: "output", agent: "coder", text: "diff xyz" },
      { type: "approve", agent: "review", text: "接受 diff?" },
    ],
  };
  const { lastFrame } = render(html`<${FocusPane} label="flow-session-1" sess=${sess} selectedIndex=${-1} />`);
  const f = lastFrame();
  assert.match(f, /⑂研发流/);                       // 头部 flowName
  assert.doesNotMatch(f, /flow-session-1/);         // 裸 label 不泄漏到头部
  assert.match(f, /planner · coder · review/);      // 参与者花名册
  assert.match(f, /diff xyz/);                       // output 条
  assert.match(f, /↳ 接受 diff\? · 在下面作答/);    // approve 分支专属包裹
});

test("FocusPane flow 群聊:发言人分段,连续同发言人不重复头", () => {
  const sess = {
    kind: "flow", flowName: "研发流", agent: "研发流", status: "running", turn: 0,
    agents: ["planner", "coder"], pendingQuestion: null,
    entries: [
      { type: "assistant", agent: "planner", text: "AAA" },
      { type: "assistant", agent: "planner", text: "BBB" },
      { type: "assistant", agent: "coder", text: "CCC" },
    ],
  };
  const { lastFrame } = render(html`<${FocusPane} label="x" sess=${sess} />`);
  const f = lastFrame();
  // 花名册(1)+ 分段头(1)= 2;若每条都插头,planner 会出现 3 次
  assert.strictEqual((f.match(/planner/g) || []).length, 2);
  assert.strictEqual((f.match(/coder/g) || []).length, 2);
  assert.match(f, /AAA/); assert.match(f, /BBB/); assert.match(f, /CCC/);
});

test("FocusPane 非 flow 会话:头部用裸 label,不插发言人头", () => {
  const sess = {
    kind: undefined, agent: "omp", model: "m", effort: null, status: "running", turn: 1, isStreaming: false,
    entries: [{ type: "assistant", text: "你好" }],
  };
  const { lastFrame } = render(html`<${FocusPane} label="omp#1" sess=${sess} />`);
  const f = lastFrame();
  assert.match(f, /omp#1/);
  assert.match(f, /你好/);
});

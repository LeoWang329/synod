import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";

test("FocusPane flow 群聊:头部 ⑂flowName + 花名册;裸 label 不泄漏;output/approve 渲染", () => {
  const sess = {
    kind: "flow", flowName: "qa", agent: "qa", model: null, status: "awaiting", turn: 0,
    agents: ["mimo-v2.5-pro", "MiniMax-M3"],
    pendingQuestion: { agent: "mimo-v2.5-pro", prompt: "PASS?" },
    entries: [
      { type: "assistant", agent: "mimo-v2.5-pro", turn: 1, text: "出题" },
      { type: "output", text: "diff xyz" },
      { type: "approve", agent: "mimo-v2.5-pro", turn: 3, text: "PASS?" },
    ],
  };
  const { lastFrame } = render(html`<${FocusPane} label="flow-session-1" sess=${sess} selectedIndex=${-1} />`);
  const f = lastFrame();
  assert.match(f, /⑂qa/);                              // 头部 flowName
  assert.doesNotMatch(f, /flow-session-1/);            // 裸 label 不泄漏
  assert.match(f, /mimo-v2\.5-pro · MiniMax-M3/);      // 参与者花名册
  assert.match(f, /flow 输出/);                         // flow 程序级输出有独立标签(不挂发言人名下)
  assert.match(f, /diff xyz/);                          // output 条
  assert.match(f, /↳ PASS\? · 在下面作答/);            // approve 分支专属包裹
});

test("FocusPane flow 群聊:按 turn 分段——同 speaker 连续两 turn 也各插头(关键回归)", () => {
  // 真引擎里同一 model(同 speaker)的两次连续 agent() 调用必须分两段;若按发言人名分段会错合并。
  const sess = {
    kind: "flow", flowName: "qa", agent: "qa", status: "running", turn: 0,
    agents: ["mimo-v2.5-pro", "MiniMax-M3"], pendingQuestion: null,
    entries: [
      { type: "assistant", agent: "mimo-v2.5-pro", turn: 1, text: "AAA" },
      { type: "assistant", agent: "mimo-v2.5-pro", turn: 2, text: "BBB" },   // 同 speaker(mimo)、新 turn → 仍插头
      { type: "assistant", agent: "MiniMax-M3", turn: 3, text: "CCC" },
    ],
  };
  const { lastFrame } = render(html`<${FocusPane} label="x" sess=${sess} />`);
  const f = lastFrame();
  // mimo 出现:花名册(1)+ turn1 头(1)+ turn2 头(1)= 3;若按发言人名分段,turn2 不插头 → 只 2 次
  assert.strictEqual((f.match(/mimo-v2\.5-pro/g) || []).length, 3, "同 speaker 连续两 turn 必各插头");
  assert.strictEqual((f.match(/MiniMax-M3/g) || []).length, 2, "花名册(1)+ turn3 头(1)");
  assert.match(f, /AAA/); assert.match(f, /BBB/); assert.match(f, /CCC/);
});

test("FocusPane flow 已结束:末尾显示续聊提示(继续与最后发言人对话)", () => {
  const sess = {
    kind: "flow", flowName: "qa", agent: "qa", status: "done", turn: 0,
    agents: ["mimo-v2.5-pro", "MiniMax-M3"], pendingQuestion: null,
    entries: [
      { type: "assistant", agent: "mimo-v2.5-pro", turn: 1, text: "出题" },
      { type: "assistant", agent: "MiniMax-M3", turn: 2, text: "回答" },
    ],
  };
  const { lastFrame } = render(html`<${FocusPane} label="x" sess=${sess} />`);
  const f = lastFrame();
  assert.match(f, /flow 已结束/);
  assert.match(f, /继续与 MiniMax-M3 对话/);   // 最后发言人
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

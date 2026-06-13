import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { AgentRail } from "../../../src/ui/tui/components/AgentRail.mjs";
import { FocusPane } from "../../../src/ui/tui/components/FocusPane.mjs";
import { CollapsibleStrip } from "../../../src/ui/tui/components/CollapsibleStrip.mjs";
import { InputBar } from "../../../src/ui/tui/components/InputBar.mjs";
import { SystemStrip } from "../../../src/ui/tui/components/SystemStrip.mjs";
import { StatusBar } from "../../../src/ui/tui/components/StatusBar.mjs";

const sessions = {
  "omp#1": { agent: "omp", model: "deepseek-v4-pro", effort: "high", status: "running", isStreaming: true, turn: 4, assistantText: "分析中...", lastLine: "分析中...", ms: null },
  "codex#1": { agent: "codex", model: null, effort: null, status: "idle", isStreaming: false, turn: 3, assistantText: "评审完成", lastLine: "评审完成", ms: 1200 },
};

test("AgentRail 列出所有 label", () => {
  const { lastFrame } = render(html`<${AgentRail} sessions=${sessions} order=${["omp#1","codex#1"]} focusLabel="omp#1" relays=${[]} />`);
  assert.match(lastFrame(), /omp#1/); assert.match(lastFrame(), /codex#1/);
});
test("FocusPane 头部含 model/turn,正文含 assistantText", () => {
  const { lastFrame } = render(html`<${FocusPane} label="omp#1" sess=${sessions["omp#1"]} fence=${null} relays=${[]} />`);
  assert.match(lastFrame(), /omp#1/); assert.match(lastFrame(), /deepseek-v4-pro/); assert.match(lastFrame(), /分析中/);
});
test("FocusPane 无会话时给提示", () => {
  const { lastFrame } = render(html`<${FocusPane} label=${null} sess=${undefined} fence=${null} relays=${[]} />`);
  assert.match(lastFrame(), /无会话|\^O/);
});
test("CollapsibleStrip 折叠只显摘要,展开显明细", () => {
  assert.match(render(html`<${CollapsibleStrip} label="编排意图" summary="3 cmds" expanded=${false} detail="x" />`).lastFrame(), /3 cmds/);
  assert.match(render(html`<${CollapsibleStrip} label="编排意图" summary="3 cmds" expanded=${true} detail="DETAIL-LINE" />`).lastFrame(), /DETAIL-LINE/);
});
test("InputBar 显示前缀 + 文本;有提示时渲染候选", () => {
  assert.match(render(html`<${InputBar} focusLabel="omp#1" value="给它加测试" hints=${{kind:"none",items:[]}} />`).lastFrame(), /omp#1/);
  assert.match(render(html`<${InputBar} focusLabel="omp#1" value="/op" hints=${{kind:"slash",items:[{value:"/open",desc:"新开"}]}} />`).lastFrame(), /\/open/);
});
test("SystemStrip 渲染最近系统消息", () => {
  assert.match(render(html`<${SystemStrip} messages=${["Relay added: a->b", "No session x"]} />`).lastFrame(), /No session x/);
});
test("SystemStrip 空时不报错", () => {
  assert.doesNotThrow(() => render(html`<${SystemStrip} messages=${[]} />`));
});
test("StatusBar 显示运行数", () => {
  assert.match(render(html`<${StatusBar} running=${1} mesh=${true} />`).lastFrame(), /1 running/);
});

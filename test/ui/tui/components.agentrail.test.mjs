// test/ui/tui/components.agentrail.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { AgentRail } from "../../../src/ui/tui/components/AgentRail.mjs";

const sessions = {
  "omp#1": { agent: "omp", status: "running", turn: 4, ms: 17000, lastLine: "分析中" },
  "codex#1": { agent: "codex", status: "awaiting", turn: 3, ms: 1200, lastLine: "评审完成" },
  "omp#2": { agent: "omp", status: "idle", turn: 1, ms: null, lastLine: "" },
};
test("列出所有 label + 各状态文案", () => {
  const f = render(html`<${AgentRail} sessions=${sessions} order=${["omp#1","codex#1","omp#2"]} focusLabel="omp#1" />`).lastFrame();
  assert.match(f, /omp#1/); assert.match(f, /codex#1/); assert.match(f, /omp#2/);
  assert.match(f, /running/);
  assert.match(f, /待你/);     // awaiting 显示"待你"
  assert.match(f, /idle/);
});
test("不再渲染 relay 箭头 ▶/◀", () => {
  const f = render(html`<${AgentRail} sessions=${sessions} order=${["omp#1","codex#1","omp#2"]} focusLabel="omp#1" />`).lastFrame();
  assert.ok(!f.includes("▶")); assert.ok(!f.includes("◀"));
});
test("AgentRail:flow 卡显示 ⑂flowName + 'running · N agents'", () => {
  const sessions = { "⑂研发流#f1": { kind: "flow", flowName: "研发流", status: "running", agents: ["a", "b", "c"], turn: 0, lastLine: "在干活" } };
  const { lastFrame } = render(html`<${AgentRail} sessions=${sessions} order=${["⑂研发流#f1"]} focusLabel=${null} />`);
  const f = lastFrame();
  assert.match(f, /⑂研发流/);
  assert.match(f, /running · 3 agents/);
});

test("AgentRail:flow 卡 awaiting → 待你", () => {
  const sessions = { "⑂x#f1": { kind: "flow", flowName: "x", status: "awaiting", agents: ["a"], turn: 0, lastLine: "" } };
  const { lastFrame } = render(html`<${AgentRail} sessions=${sessions} order=${["⑂x#f1"]} focusLabel=${"⑂x#f1"} />`);
  assert.match(lastFrame(), /待你/);
});

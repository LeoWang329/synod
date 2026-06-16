import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { StatusBar } from "../../../src/ui/tui/components/StatusBar.mjs";

test("显示 agents 总数 + 待你计数 + mesh", () => {
  const f = render(html`<${StatusBar} agents=${3} awaiting=${1} mesh=${true} />`).lastFrame();
  assert.match(f, /3 agents/);
  assert.match(f, /1 待你/);
  assert.match(f, /mesh on/);
});
test("含 ?帮助 提示", () => {
  assert.match(render(html`<${StatusBar} agents=${0} awaiting=${0} mesh=${false} />`).lastFrame(), /\? 帮助/);
});

// test/ui/tui/components.inputbar.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { InputBar } from "../../../src/ui/tui/components/InputBar.mjs";

test("显示前缀 + 文本", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="加测试" hints=${{kind:"none",items:[]}} />`).lastFrame();
  assert.match(f, /omp#1/); assert.match(f, /加测试/);
});
test("有提示时渲染候选", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="/op" hints=${{kind:"slash",items:[{value:"/open",desc:"新开"}]}} />`).lastFrame();
  assert.match(f, /\/open/);
});
test("只有上下通栏线(无左右竖边框字符 │)", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="x" hints=${{kind:"none",items:[]}} />`).lastFrame();
  assert.ok(!f.includes("│"), "不应有竖边框");
  assert.ok(f.includes("─"), "应有横线");
});

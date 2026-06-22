// test/ui/tui/components.inputbar.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { InputBar } from "../../../src/ui/tui/components/InputBar.mjs";

test("显示前缀 + 文本 + 光标(初始可见)", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="加测试" hints=${{kind:"none",items:[]}} />`).lastFrame();
  assert.match(f, /omp#1/); assert.match(f, /加测试/); assert.match(f, /▌/);
});
test("有提示时渲染候选", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="/op" hints=${{kind:"slash",items:[{value:"/open",desc:"新开"}]}} />`).lastFrame();
  assert.match(f, /\/open/);
});
test("selected 高亮项带 ❯ 标记 + 操作提示", () => {
  const hints = { kind: "slash", items: [{ value: "/open", desc: "" }, { value: "/use", desc: "" }] };
  const f = render(html`<${InputBar} focusLabel="omp#1" value="/" hints=${hints} selected=${1} />`).lastFrame();
  assert.match(f, /❯ \/use/);          // 选中第二项
  assert.ok(!/❯ \/open/.test(f), "未选中项不应带 ❯");
  assert.match(f, /Tab 补全/);
});
test("候选超 6 条:窗口下滚保证选中项可见 + 计数", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ value: "/c" + i, desc: "" }));
  const f = render(html`<${InputBar} focusLabel="omp#1" value="/c" hints=${{kind:"slash",items}} selected=${9} />`).lastFrame();
  assert.match(f, /❯ \/c9/);            // 末项可见且高亮
  assert.ok(!f.includes("/c0"), "顶部项应滚出窗口");
  assert.match(f, /10\/10/);            // 计数
});
test("只有上下通栏线(无左右竖边框字符 │)", () => {
  const f = render(html`<${InputBar} focusLabel="omp#1" value="x" hints=${{kind:"none",items:[]}} />`).lastFrame();
  assert.ok(!f.includes("│"), "不应有竖边框");
  assert.ok(f.includes("─"), "应有横线");
});

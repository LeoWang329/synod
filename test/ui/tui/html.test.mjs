import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { Text } from "ink";

test("html 标签模板可渲染 ink 组件(无 JSX 构建)", () => {
  const { lastFrame } = render(html`<${Text}>hello-tui<//>`);
  assert.match(lastFrame(), /hello-tui/);
});

import { test } from "node:test";
import assert from "node:assert";
import { render } from "ink-testing-library";
import { html } from "../../../src/ui/tui/html.mjs";
import { ToolCard } from "../../../src/ui/tui/components/ToolCard.mjs";

const running = { type: "tool", id: "t1", name: "read_file", args: { path: "src/a.js" }, status: "running", output: "", diff: null, expanded: false };
const done = { type: "tool", id: "t2", name: "bash", args: { cmd: "ls" }, status: "done", ok: true, output: "file1\nfile2\nfile3", diff: null, expanded: false };

test("收起:显名称 + 状态符,不显 output", () => {
  const f = render(html`<${ToolCard} entry=${running} selected=${false} />`).lastFrame();
  assert.match(f, /read_file/);
  assert.match(f, /▸/);
});
test("展开:显 output 明细", () => {
  const f = render(html`<${ToolCard} entry=${{ ...done, expanded: true }} selected=${false} />`).lastFrame();
  assert.match(f, /▾/);
  assert.match(f, /file1/);
  assert.match(f, /file2/);
});
test("收起态不含 output 文本", () => {
  const f = render(html`<${ToolCard} entry=${done} selected=${false} />`).lastFrame();
  assert.ok(!f.includes("file2"));
});
test("selected 高亮不报错", () => {
  assert.doesNotThrow(() => render(html`<${ToolCard} entry=${done} selected=${true} />`));
});
test("args 为字符串(codex command)也能渲染", () => {
  const f = render(html`<${ToolCard} entry=${{ type:"tool", id:"c1", name:"commandExecution", args:"ls -la", status:"done", ok:true, output:"", diff:null, expanded:true }} selected=${false} />`).lastFrame();
  assert.match(f, /ls -la/);
});

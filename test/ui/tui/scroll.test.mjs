import { test } from "node:test";
import assert from "node:assert";
import { maxScrollOf, scrollReducer, effectiveScroll, scrollbar, strWidth, estimateLines } from "../../../src/ui/tui/scroll.mjs";

test("maxScrollOf:内容不超视口 → 0", () => {
  assert.strictEqual(maxScrollOf(5, 10), 0);
  assert.strictEqual(maxScrollOf(30, 10), 20);
});

test("scrollReducer:内容放得下时恒 stick", () => {
  const s = scrollReducer({ scroll: 0, stick: true }, "lineUp", { contentH: 8, viewportH: 10 });
  assert.deepStrictEqual(s, { scroll: 0, stick: true });
});
test("scrollReducer:从 stick 起 lineUp → 离开底部一行(scroll=max-1)", () => {
  const s = scrollReducer({ scroll: 0, stick: true }, "lineUp", { contentH: 30, viewportH: 10 });   // max=20
  assert.deepStrictEqual(s, { scroll: 19, stick: false });
});
test("scrollReducer:lineDown 触底自动恢复 stick", () => {
  const s = scrollReducer({ scroll: 19, stick: false }, "lineDown", { contentH: 30, viewportH: 10 });
  assert.deepStrictEqual(s, { scroll: 0, stick: true });   // 20>=max=20 → stick(scroll 归 0 无意义)
});
test("scrollReducer:pageUp 退 viewportH-1 行", () => {
  const s = scrollReducer({ scroll: 20, stick: false }, "pageUp", { contentH: 100, viewportH: 10 });
  assert.deepStrictEqual(s, { scroll: 11, stick: false });   // 20-9
});
test("scrollReducer:pageDown 触底 stick", () => {
  const s = scrollReducer({ scroll: 85, stick: false }, "pageDown", { contentH: 100, viewportH: 10 });   // max=90,85+9=94→clamp90≥max→stick 归一化
  assert.deepStrictEqual(s, { scroll: 0, stick: true });
});
test("scrollReducer:top 到顶 / bottom 回最新", () => {
  assert.deepStrictEqual(scrollReducer({ scroll: 50, stick: false }, "top", { contentH: 100, viewportH: 10 }), { scroll: 0, stick: false });
  assert.deepStrictEqual(scrollReducer({ scroll: 5, stick: false }, "bottom", { contentH: 100, viewportH: 10 }), { scroll: 0, stick: true });
});
test("scrollReducer:顶部再 lineUp 不越界", () => {
  assert.deepStrictEqual(scrollReducer({ scroll: 0, stick: false }, "lineUp", { contentH: 100, viewportH: 10 }), { scroll: 0, stick: false });
});

test("effectiveScroll:stick → 贴底(=max);非 stick → 钳位", () => {
  assert.strictEqual(effectiveScroll({ scroll: 0, stick: true }, { contentH: 30, viewportH: 10 }), 20);
  assert.strictEqual(effectiveScroll({ scroll: 999, stick: false }, { contentH: 30, viewportH: 10 }), 20);
  assert.strictEqual(effectiveScroll({ scroll: 7, stick: false }, { contentH: 30, viewportH: 10 }), 7);
});

test("scrollbar:内容放得下 → null(不画)", () => {
  assert.strictEqual(scrollbar(10, 8, { scroll: 0, stick: true }), null);
});
test("scrollbar:滑块高 ∝ 视口/内容,stick 时贴底", () => {
  const b = scrollbar(10, 20, { scroll: 0, stick: true });   // size=round(10*10/20)=5;eff=max=10;start=round(1*(10-5))=5
  assert.deepStrictEqual(b, { size: 5, start: 5, viewportH: 10 });
});
test("scrollbar:置顶时滑块在顶", () => {
  const b = scrollbar(10, 20, { scroll: 0, stick: false });   // eff=0 → start=0
  assert.strictEqual(b.start, 0);
});

test("strWidth:CJK 计 2,ASCII 计 1,组合记号计 0", () => {
  assert.strictEqual(strWidth("ab"), 2);
  assert.strictEqual(strWidth("中文"), 4);
  assert.strictEqual(strWidth("a中"), 3);
});

test("estimateLines:文本按宽度换行累加", () => {
  // 宽 10,一条 25 宽的 ASCII → ceil(25/10)=3 行
  assert.strictEqual(estimateLines([{ type: "assistant", text: "x".repeat(25) }], 10), 3);
});
test("estimateLines:多条 + flow 发言名头各 +1", () => {
  const es = [
    { type: "assistant", text: "hi", turn: 1, agent: "mimo" },
    { type: "assistant", text: "yo", turn: 2, agent: "minimax" },
  ];
  // 非 flow:2 行;flow:每个新 turn +1 头 → 2 + 2 = 4
  assert.strictEqual(estimateLines(es, 80, { isFlow: false }), 2);
  assert.strictEqual(estimateLines(es, 80, { isFlow: true }), 4);
});
test("estimateLines:output 恒 3 行,折叠 tool 1 行,展开 tool 含边框", () => {
  assert.strictEqual(estimateLines([{ type: "output", text: "随便多长都截断一行" }], 80), 3);
  assert.strictEqual(estimateLines([{ type: "tool", name: "bash" }], 80), 1);
  // 展开:border2 + head1 + args1 + (output: 标签1 + 2 行) = 7
  assert.strictEqual(estimateLines([{ type: "tool", name: "bash", expanded: true, args: { a: 1 }, output: "l1\nl2" }], 80), 7);
});
test("estimateLines:flowEnded 提示 +2", () => {
  assert.strictEqual(estimateLines([], 80, { isFlow: true, flowEnded: true }), 2);
});

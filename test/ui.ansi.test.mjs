// test/ui.ansi.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { enabled, color, labelColor, stripAnsi, PALETTE_CODES } from "../src/ui/ansi.mjs";

test("color:SGR 包裹 + reset", () => {
  assert.equal(color(36, "hi"), "\x1b[36mhi\x1b[0m");
});

test("enabled:isTTY && !NO_COLOR(§8.1)", () => {
  assert.equal(enabled({ isTTY: true }, {}), true);
  assert.equal(enabled({ isTTY: false }, {}), false);
  assert.equal(enabled(undefined, {}), false);
  assert.equal(enabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(enabled({ isTTY: true }, { NO_COLOR: "" }), true, "空串视为未设置(§8.1 的 !NO_COLOR)");
});

test("labelColor:同 label 恒定且落在 8 色调色板内", () => {
  const c = labelColor("omp#1");
  assert.ok(PALETTE_CODES.includes(c));
  assert.equal(labelColor("omp#1"), c, "同一 label 永远同色");
  assert.equal(PALETTE_CODES.length, 8, "8 色循环(§2.1)");
});

test("stripAnsi:还原纯文本(§8.5 strip 等价基座)", () => {
  assert.equal(stripAnsi(color(labelColor("omp#1"), "[omp#1]")), "[omp#1]");
  assert.equal(stripAnsi("no codes"), "no codes");
});

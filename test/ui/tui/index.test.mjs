import { test } from "node:test";
import assert from "node:assert";
import { buildTeardown, ENTER_ALT, EXIT_ALT, computeRailRegions } from "../../../src/ui/tui/index.mjs";
import { MOUSE_OFF } from "../../../src/ui/tui/mouse.mjs";

test("teardown 写出退出 alt-screen + 关鼠标 + 显光标", () => {
  const out = []; const stdout = { write: (s) => { out.push(s); return true; } };
  buildTeardown(stdout)();
  const j = out.join("");
  assert.ok(j.includes(EXIT_ALT) && j.includes(MOUSE_OFF) && j.includes("\x1b[?25h"));
});
test("ENTER/EXIT_ALT 是 alt-screen 转义", () => {
  assert.ok(ENTER_ALT.includes("?1049h")); assert.ok(EXIT_ALT.includes("?1049l"));
});
test("computeRailRegions:右栏宽 30 贴右,首卡 railTop+2,每卡高 5(1-based)", () => {
  const regs = computeRailRegions(["omp#1", "codex#1"], 100);
  assert.deepStrictEqual(regs["agent:omp#1"], { x: 71, y: 3, w: 30, h: 5 });
  assert.deepStrictEqual(regs["agent:codex#1"], { x: 71, y: 8, w: 30, h: 5 });
});

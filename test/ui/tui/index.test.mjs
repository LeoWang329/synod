import { test } from "node:test";
import assert from "node:assert";
import { buildTeardown, ENTER_ALT, EXIT_ALT, MOUSE_OFF } from "../../../src/ui/tui/index.mjs";

test("teardown 写出退出 alt-screen + 关鼠标 + 显光标", () => {
  const out = []; const stdout = { write: (s) => { out.push(s); return true; } };
  buildTeardown(stdout)();
  const j = out.join("");
  assert.ok(j.includes(EXIT_ALT) && j.includes(MOUSE_OFF) && j.includes("\x1b[?25h"));
});
test("ENTER/EXIT_ALT 是 alt-screen 转义", () => {
  assert.ok(ENTER_ALT.includes("?1049h")); assert.ok(EXIT_ALT.includes("?1049l"));
});

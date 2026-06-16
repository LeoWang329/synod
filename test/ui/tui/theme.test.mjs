// test/ui/tui/theme.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { theme } from "../../../src/ui/tui/theme.mjs";

test("theme 含全部语义角色且为 #hex", () => {
  for (const k of ["bg","bg2","border","borderBright","text","dim","accent","you","tool","ok","warn","breadcrumb","nudge"]) {
    assert.match(theme[k], /^#[0-9a-f]{6}$/i, `${k} 应为 #hex`);
  }
});
test("关键色值锁定(Catppuccin Mocha)", () => {
  assert.strictEqual(theme.accent, "#89b4fa");
  assert.strictEqual(theme.warn, "#fab387");
  assert.strictEqual(theme.nudge, "#cba6f7");
});

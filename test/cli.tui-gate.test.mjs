import { test } from "node:test";
import assert from "node:assert";
import { shouldUseTui } from "../src/cli.mjs";
const tty = (v) => ({ isTTY: v });
test("shouldUseTui:stdin+stdout 都 TTY、交互、未禁用 → true", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [], noTui: false }, {}), true));
test("shouldUseTui:stdin 非 TTY(管道喂入)→ false", () =>
  assert.strictEqual(shouldUseTui(tty(false), tty(true), { tasks: [], noTui: false }, {}), false));
test("shouldUseTui:stdout 非 TTY → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(false), { tasks: [], noTui: false }, {}), false));
test("shouldUseTui:--task → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [{}], noTui: false }, {}), false));
test("shouldUseTui:--no-tui → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [], noTui: true }, {}), false));
test("shouldUseTui:SYNOD_NO_TUI=1 → false", () =>
  assert.strictEqual(shouldUseTui(tty(true), tty(true), { tasks: [], noTui: false }, { SYNOD_NO_TUI: "1" }), false));
test("parseArgs 识别 --no-tui", async () => {
  const { parseArgs } = await import("../src/cli.mjs");
  assert.strictEqual(parseArgs(["--no-tui"]).noTui, true);
  assert.strictEqual(parseArgs([]).noTui, false);
});

// test/ui/tui/breadcrumbs.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { fenceBreadcrumb } from "../../../src/ui/tui/breadcrumbs.mjs";

test("/open 成功 → 开了 <label>", () => {
  assert.strictEqual(fenceBreadcrumb("/open --agent codex", "ok · session codex#1"), "开了 codex#1");
});
test("/open 无 session 字样但 ok → 开了新会话", () => {
  assert.strictEqual(fenceBreadcrumb("/open --agent codex", "ok"), "开了新会话");
});
test("/relay → 连了 relay <args>", () => {
  assert.strictEqual(fenceBreadcrumb("/relay omp#1->codex#1", "ok"), "连了 relay omp#1->codex#1");
});
test("@target → 给 <target> 派了活", () => {
  assert.strictEqual(fenceBreadcrumb("@codex#1 核对 diff", "ok"), "给 codex#1 派了活");
});
test("未识别命令 → 回退 cmd → result", () => {
  assert.strictEqual(fenceBreadcrumb("/weird x", "boom"), "/weird x → boom");
});

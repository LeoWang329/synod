import test from "node:test";
import assert from "node:assert/strict";
import { residualWorktreeNotice } from "../src/cli.mjs";

test("residualWorktreeNotice:无残留 → 空串", () => {
  assert.equal(residualWorktreeNotice([]), "");
});

test("residualWorktreeNotice:列出残留分支/路径 + 清理建议", () => {
  const s = residualWorktreeNotice([
    { path: "/wt/run1-feat", branch: "refs/heads/synod/run1/feat" },
  ]);
  assert.match(s, /1 residual synod worktree/i);
  assert.match(s, /run1-feat/);
  assert.match(s, /git worktree remove/);
});

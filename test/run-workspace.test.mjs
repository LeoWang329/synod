import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunWorkspace } from "../src/run-workspace.mjs";
import { makeGitRepo, makeNonGitDir } from "./helpers/git-repo.mjs";

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
const worktreesRoot = () => mkdtempSync(join(tmpdir(), "synod-wt-"));

test("非 git 目录 acquire(write+workspace)→ 拒绝(建议 git init / 串行)", () => {
  const cwd = makeNonGitDir();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  assert.throws(() => ws.acquire({ runId: "r1", name: "feat" }), /git repo|git init|serial/i);
});

test("acquire 建 worktree + 分支 synod/<runId>/<name>;同名复用同一 worktree", () => {
  const cwd = makeGitRepo();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run1", name: "feat-x" });
  assert.ok(existsSync(a.path), "worktree 目录存在");
  assert.equal(a.branch, "synod/run1/feat-x");
  const branches = git(cwd, ["branch", "--list", "synod/run1/feat-x"]);
  assert.match(branches, /synod\/run1\/feat-x/);
  const a2 = ws.acquire({ runId: "run1", name: "feat-x" });
  assert.equal(a2.path, a.path, "同名 workspace 复用同一 worktree");
});

test("不同名 → 不同 worktree;两个并发 write 各自隔离", () => {
  const cwd = makeGitRepo();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run2", name: "a" });
  const b = ws.acquire({ runId: "run2", name: "b" });
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.branch, b.branch);
});

test("finalize:无冲突分支自动合回起始分支并清 worktree/分支", () => {
  const cwd = makeGitRepo();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run3", name: "feat" });
  writeFileSync(join(a.path, "new.txt"), "hello from worktree\n");
  const r = ws.finalize({ runId: "run3" });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.merged, ["feat"]);
  assert.ok(existsSync(join(cwd, "new.txt")));
  assert.ok(!existsSync(a.path), "worktree 已移除");
  assert.equal(git(cwd, ["branch", "--list", "synod/run3/feat"]), "");
});

test("finalize:冲突分支保留 worktree+分支,进 conflicts 清单(冲突文件可见)", () => {
  const cwd = makeGitRepo({ "README.md": "base\n" });
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot: worktreesRoot() });
  const a = ws.acquire({ runId: "run4", name: "feat" });
  writeFileSync(join(cwd, "README.md"), "main side\n");
  git(cwd, ["commit", "-aqm", "main change"]);
  writeFileSync(join(a.path, "README.md"), "worktree side\n");
  const r = ws.finalize({ runId: "run4" });
  assert.equal(r.merged.length, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].name, "feat");
  assert.match(r.conflicts[0].files.join(","), /README\.md/);
  assert.ok(existsSync(a.path), "冲突 worktree 保留");
  assert.match(git(cwd, ["branch", "--list", "synod/run4/feat"]), /synod\/run4\/feat/);
});

test("worktree 记录持久化到 runsRoot/<runId>/workspaces.json", () => {
  const cwd = makeGitRepo();
  const runsRoot = worktreesRoot();
  const ws = createRunWorkspace({ cwd, worktreesRoot: worktreesRoot(), runsRoot });
  ws.acquire({ runId: "run5", name: "feat" });
  const rec = JSON.parse(readFileSync(join(runsRoot, "run5", "workspaces.json"), "utf8"));
  assert.equal(rec[0].name, "feat");
  assert.equal(rec[0].branch, "synod/run5/feat");
});

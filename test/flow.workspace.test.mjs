import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/flow/runtime.mjs";
import { createRunWorkspace } from "../src/run-workspace.mjs";
import { makeGitRepo } from "./helpers/git-repo.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };
const wtRoot = () => mkdtempSync(join(tmpdir(), "synod-fwt-"));

test("agent write+workspace:会话 cwd 指向 worktree(非主 cwd)", async () => {
  const repo = makeGitRepo();
  const rw = createRunWorkspace({ cwd: repo, worktreesRoot: wtRoot(), runsRoot: wtRoot() });
  let seenCwd;
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, runWorkspace: rw,
    openBackend: async ({ cwd }) => { seenCwd = cwd; return new FakeSession({ deltas: ["ok"] }); },
  });
  const ctx = runtime.createCtx({}, { cwd: repo, runId: "run-w" });
  await runtime.agent(ctx, { agent: "omp", write: true, workspace: "feat", prompt: "edit" });
  assert.notEqual(seenCwd, repo, "cwd 应指向 worktree,不是主 cwd");
  assert.match(seenCwd, /run-w-feat/, "cwd 在 worktree 目录内");
});

test("只读 agent(无 workspace):cwd = 主 cwd,不建 worktree(零开销)", async () => {
  const repo = makeGitRepo();
  const rw = createRunWorkspace({ cwd: repo, worktreesRoot: wtRoot(), runsRoot: wtRoot() });
  let seenCwd;
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, runWorkspace: rw,
    openBackend: async ({ cwd }) => { seenCwd = cwd; return new FakeSession({ deltas: ["ok"] }); },
  });
  const ctx = runtime.createCtx({}, { cwd: repo, runId: "run-r" });
  await runtime.agent(ctx, { agent: "omp", prompt: "read only" });
  assert.equal(seenCwd, repo);
  assert.equal(rw._acquired.size, 0, "只读不建 worktree");
});

test("finalizeWorkspaces 返回 {merged,conflicts}", async () => {
  const repo = makeGitRepo();
  const rw = createRunWorkspace({ cwd: repo, worktreesRoot: wtRoot(), runsRoot: wtRoot() });
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, runWorkspace: rw, openBackend: async () => new FakeSession({}) });
  const ctx = runtime.createCtx({}, { cwd: repo, runId: "run-f" });
  rw.acquire({ runId: "run-f", name: "feat" });
  const r = await runtime.finalizeWorkspaces(ctx);
  assert.ok(Array.isArray(r.merged));
  assert.ok(Array.isArray(r.conflicts));
});

test("无 runWorkspace:finalizeWorkspaces 安全返回空(非 git/无写隔离场景)", async () => {
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, openBackend: async () => new FakeSession({}) });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.finalizeWorkspaces(ctx);
  assert.deepEqual(r, { merged: [], conflicts: [] });
});

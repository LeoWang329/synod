// synod/src/run-workspace.mjs — 并发写隔离:每个 write 任务一个 git worktree(§4.11)。
//
// 设计:acquire 在 ~/.synod/worktrees/<repo-hash>/<runId>-<name>/ 基于 HEAD 建临时
// worktree + 分支 synod/<runId>/<name>,agent 会话 cwd 指向之。只读 agent 不调
// acquire(用主 cwd,零开销)。finalize 逐分支收尾:脏 worktree 先自动 commit,
// 能无冲突合并的自动合 + 清 worktree/分支;有冲突的 merge --abort 保留 worktree+
// 分支并进 conflicts 清单留人(顺利路径零人工,出错路径不丢工作)。
//
// 零三方依赖:git 操作走 spawnSync("git", …)。spawnSync 同步,故 Promise.all 下
// 多个 agent 的 acquire 在 JS 事件循环里天然串行,无 git 并发竞态。
//
// win32:路径全用 node:path 拼接、不用 symlink;git worktree/merge 退出码跨平台
// 一致;分支名用 "/" 在 git 内部即 ref 路径,Windows git 同样支持。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error,
  };
}

function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.error?.message || `exit ${r.status}`}`);
  }
  return r.stdout;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function createRunWorkspace({ cwd, worktreesRoot, runsRoot }) {
  const _acquired = new Map();   // `${runId}/${name}` → { name, path, branch }
  let _startBranch = null;       // run 启动时主仓所在分支(finalize 合回它)

  function isGitRepo() {
    const r = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return r.status === 0 && r.stdout === "true";
  }

  function repoTop() {
    return gitOk(cwd, ["rev-parse", "--show-toplevel"]);
  }

  function currentBranch() {
    const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return r.status === 0 ? r.stdout : "HEAD";
  }

  function persist(runId) {
    try {
      const dir = path.join(runsRoot, runId);
      fs.mkdirSync(dir, { recursive: true });
      const list = [..._acquired.entries()]
        .filter(([k]) => k.startsWith(`${runId}/`))
        .map(([, v]) => v);
      fs.writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify(list, null, 2) + "\n");
    } catch { /* 记录失败不阻断主流程 */ }
  }

  /** 建/复用一个隔离 worktree。非 git 仓库 → 拒绝(write+workspace 必须有 git)。 */
  function acquire({ runId, name }) {
    if (!NAME_RE.test(name)) {
      throw new Error(`RunWorkspace: invalid workspace name "${name}" (use letters/digits/_/-)`);
    }
    if (!isGitRepo()) {
      throw new Error(
        `RunWorkspace: write+workspace isolation requires a git repo at ${cwd}. ` +
        `Run \`git init\` there, or run write agents serially (no workspace).`,
      );
    }
    const cacheKey = `${runId}/${name}`;
    if (_acquired.has(cacheKey)) return _acquired.get(cacheKey);

    if (_startBranch === null) _startBranch = currentBranch();

    const top = repoTop();
    const repoHash = createHash("sha1").update(top).digest("hex").slice(0, 12);
    const dir = path.join(worktreesRoot, repoHash, `${runId}-${name}`);
    const branch = `synod/${runId}/${name}`;

    fs.mkdirSync(path.dirname(dir), { recursive: true });
    gitOk(cwd, ["worktree", "add", "-b", branch, dir, "HEAD"]);

    const ws = { name, path: dir, branch };
    _acquired.set(cacheKey, ws);
    persist(runId);
    return ws;
  }

  /** run 结束逐分支收尾:自动 commit 脏 worktree → 合回起始分支(冲突留人)。 */
  function finalize({ runId, startBranch } = {}) {
    const start = startBranch ?? _startBranch ?? currentBranch();
    const merged = [];
    const conflicts = [];
    for (const [key, ws] of _acquired) {
      if (!key.startsWith(`${runId}/`)) continue;
      // 1) 脏 worktree 自动 commit(write agent 通常只改文件不 commit)。
      const dirty = git(ws.path, ["status", "--porcelain"]).stdout;
      if (dirty) {
        git(ws.path, ["add", "-A"]);
        git(ws.path, ["commit", "-q", "-m", `synod ${runId} ${ws.name}`]);
      }
      // 2) 在主仓(起始分支)合并该分支。
      const m = git(cwd, ["merge", "--no-ff", "-m", `synod merge ${ws.name}`, ws.branch]);
      if (m.status === 0) {
        git(cwd, ["worktree", "remove", "--force", ws.path]);
        git(cwd, ["branch", "-D", ws.branch]);
        merged.push(ws.name);
      } else {
        const files = git(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout
          .split("\n").map((s) => s.trim()).filter(Boolean);
        git(cwd, ["merge", "--abort"]);
        conflicts.push({ name: ws.name, branch: ws.branch, path: ws.path, files });
      }
    }
    return { merged, conflicts, startBranch: start };
  }

  /** run 内已 acquire 的 worktree 清单(供 checkpoint/摘要)。 */
  function list(runId) {
    return [..._acquired.entries()]
      .filter(([k]) => k.startsWith(`${runId}/`))
      .map(([, v]) => v);
  }

  return { isGitRepo, acquire, finalize, list, _acquired };
}

/**
 * 启动顺扫:git worktree prune + 列残留 synod worktree(供 CLI 提示)。
 * 纯只读列举,不删用户工作(Task 11 用)。
 */
export function scanResidualWorktrees(cwd) {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return [];
  git(cwd, ["worktree", "prune"]);   // 清掉已被删目录的登记(尽力而为)
  const out = git(cwd, ["worktree", "list", "--porcelain"]).stdout;
  const residual = [];
  let curPath = null, curBranch = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { curPath = line.slice(9).trim(); curBranch = null; }
    else if (line.startsWith("branch ")) { curBranch = line.slice(7).trim(); }
    else if (line === "") {
      if (curBranch && /\/synod\/[^/]+\//.test(curBranch)) {
        residual.push({ path: curPath, branch: curBranch });
      }
      curPath = null; curBranch = null;
    }
  }
  return residual;
}

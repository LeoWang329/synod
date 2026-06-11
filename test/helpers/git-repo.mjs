// test/helpers/git-repo.mjs — mkdtemp 一个真 git 仓库(worktree 测试共用,零三方依赖)。
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** 建一个带初始提交的 git 仓库,返回其路径。可指定初始文件。 */
export function makeGitRepo(files = { "README.md": "init\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "synod-git-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@synod"]);
  git(dir, ["config", "user.name", "synod test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["checkout", "-q", "-B", "main"]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** 非 git 的空临时目录。 */
export function makeNonGitDir() {
  return mkdtempSync(join(tmpdir(), "synod-nogit-"));
}

export { git as runGit };

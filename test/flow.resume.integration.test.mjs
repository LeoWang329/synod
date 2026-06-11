// test/flow.resume.integration.test.mjs — kill 一半 → resume 续完。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as flowMain } from "../src/flow.mjs";
import { readCheckpoint } from "../src/flow/checkpoint.mjs";
import { prepareResume } from "../src/flow/replay.mjs";

// PKG_ROOT: test/ の親 = synod パッケージルート。flow ファイルが `import "synod/flow"` を
// 解決できるよう tmp プロジェクトの node_modules に symlink する(cli.inputrouter 用例と同じ手法)。
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function collector() { const c = []; return { write: (s) => { c.push(s); return true; }, text: () => c.join("") }; }

function setupFlow(body) {
  const proj = mkdtempSync(join(tmpdir(), "synod-resume-proj-"));
  mkdirSync(join(proj, "workflows"));
  writeFileSync(join(proj, "workflows", "two.mjs"), body);
  // `import "synod/flow"` を tmp プロジェクトから解決可能にする
  mkdirSync(join(proj, "node_modules"), { recursive: true });
  symlinkSync(PKG_ROOT, join(proj, "node_modules", "synod"), "dir");
  const runsRoot = mkdtempSync(join(tmpdir(), "synod-resume-runs-"));
  return { proj, runsRoot };
}

const FLOW = `
import { bash, agent } from "synod/flow";
export const meta = { description: "two-step" };
export async function run(ctx) {
  const a = await bash(ctx, "echo A");
  const b = await agent(ctx, { agent: "omp", prompt: "make B" });
  return { a: a.stdout, b };
}
`;

test("首跑 agent 失败写 failed checkpoint;resume 重放 bash + 真跑 agent 成功", async () => {
  const { proj, runsRoot } = setupFlow(FLOW);
  const stdout1 = collector(); const stderr1 = collector();
  const failBackend = async () => { throw new Error("backend down"); };
  const code1 = await flowMain({
    argv: ["two"], stdout: stdout1, stderr: stderr1,
    openBackend: failBackend, workflowsRoot: join(proj, "workflows"),
    cwd: proj, runsRoot,
  });
  assert.equal(code1, 1, "首跑失败");
  const { runId } = findOnlyRun(runsRoot);
  const ck = readCheckpoint(runsRoot, runId);
  assert.equal(ck.status, "failed");
  assert.equal(ck.flowName, "two");

  const r = await prepareResume(runsRoot, runId);
  assert.equal(r.steps.length >= 1, true, "bash 步已完成可重放");
  let opened = 0;
  const okBackend = async () => {
    opened += 1;
    const { FakeSession } = await import("./helpers/fake-backend.mjs");
    return new FakeSession({ deltas: ["B-DONE"] });
  };
  const stdout2 = collector(); const stderr2 = collector();
  const code2 = await flowMain({
    argv: ["two"], stdout: stdout2, stderr: stderr2,
    openBackend: okBackend, workflowsRoot: join(proj, "workflows"),
    cwd: proj, runsRoot,
    resume: { runId, input: r.input, steps: r.steps },
  });
  assert.equal(code2, 0, "resume 续完");
  assert.equal(opened, 1, "只为真跑的 agent 步开一次 backend(bash 步重放未开)");
  assert.match(stdout2.text(), /B-DONE/);
  assert.equal(readCheckpoint(runsRoot, runId).status, "done");
});

function findOnlyRun(runsRoot) {
  const ents = readdirSync(runsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  return { runId: ents[0].name };
}

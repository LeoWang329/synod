// test/backend.process-group.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openBackend, terminateProcessTree } from "../src/backend.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";

const POSIX = process.platform !== "win32";

async function pollDead(pids, timeoutMs) {
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    alive = pids.filter(isAlive);
  }
  return alive;
}

test("POSIX 上 spawn 带 detached:true(自成进程组)", async () => {
  let spawnOpts;
  const session = await openBackend({
    agent: "omp", cwd: process.cwd(),
    spawnImpl: (cmd, args, opts) => { spawnOpts = opts; return makeFakeOmpProc(); },
  });
  session.close();
  assert.equal(Boolean(spawnOpts.detached), POSIX);
});

// 组杀连孙进程一起收(消灭 pgrep 枚举的 TOCTOU)。注意 {group:true}
// 仅对真实 detached 进程使用;fake 的随机 pid 绝不走组杀路径。
test("terminateProcessTree({group:true}) 杀死整个进程组(含孙进程)",
  { skip: !POSIX }, async () => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    console.log(g.pid);
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const gpid = await new Promise((resolve) => {
    child.stdout.once("data", (d) => resolve(Number(d.toString().trim())));
  });
  assert.ok(Number.isInteger(gpid) && gpid > 1);
  terminateProcessTree(child.pid, "SIGTERM", { group: true });
  const alive = await pollDead([child.pid, gpid], 2000);
  assert.deepEqual(alive, []);
});

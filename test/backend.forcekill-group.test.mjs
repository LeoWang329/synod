// test/backend.forcekill-group.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { scheduleForceKill } from "../src/backend.mjs";

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

// 非退出 close 路径的 SIGKILL 兜底必须按组击杀:SIGTERM 免疫且
// 有孙进程的 detached 子进程,在宽限后整组被 SIGKILL(含孙)。
test("scheduleForceKill({group:true}) 组杀 SIGTERM 免疫的进程组(含孙)",
  { skip: !POSIX, timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});          // 免疫 SIGTERM
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"]);
    console.log(g.pid);
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const gpid = await new Promise((resolve) => {
    child.stdout.once("data", (d) => resolve(Number(d.toString().trim())));
  });
  assert.ok(Number.isInteger(gpid) && gpid > 1);
  scheduleForceKill(child, 200, { group: true });   // 200ms 宽限
  const alive = await pollDead([child.pid, gpid], 3000);
  assert.deepEqual(alive, [], "组兜底必须连孙进程一起 SIGKILL");
});

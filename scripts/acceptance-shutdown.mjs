#!/usr/bin/env node
// scripts/acceptance-shutdown.mjs — 进程治理 e2e:
//   S1  SIGTERM 杀 REPL → agent 子进程无残留
//   S2  SIGINT  杀 REPL → agent 子进程无残留
// 需要本机 omp;缺失自动跳过(不算失败)。win32 跳过(组杀语义不同,
// close 路径已是 taskkill 同步强杀)。
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { doctor } from "../src/backend.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function directChildren(pid) {
  const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1);
}

// 递归收集整棵后代树(直接子 + 孙 + ...),用于"无残留"的强断言:
// Task 7 的目标就是孙进程不逃逸,只查直接子会让孙存活时仍误判通过。
function descendantsOf(pid, seen = new Set()) {
  for (const c of directChildren(pid)) {
    if (seen.has(c)) continue;
    seen.add(c);
    descendantsOf(c, seen);
  }
  return [...seen];
}

async function scenario(name, signal) {
  const cli = spawn(process.execPath, ["src/cli.mjs"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  cli.stdout.on("data", (d) => { out += d.toString(); });
  cli.stderr.on("data", () => {});

  // 等默认会话开好(REPL 画出 "> " 提示符);冷启动可能慢,90s 上限
  const ready = Date.now() + 90_000;
  while (!out.includes("> ") && Date.now() < ready) await sleep(200);
  if (!out.includes("> ")) {
    results.push([name, false, "REPL 未就绪(90s)"]);
    try { cli.kill("SIGKILL"); } catch {}
    return;
  }

  const agents = descendantsOf(cli.pid);
  if (agents.length === 0) {
    results.push([name, false, "未找到 agent 子进程"]);
    try { cli.kill("SIGKILL"); } catch {}
    return;
  }

  cli.kill(signal);
  const exitDeadline = Date.now() + 15_000;
  while (cli.exitCode === null && cli.signalCode === null && Date.now() < exitDeadline) {
    await sleep(200);
  }
  await sleep(1500); // 留出宽限轮询 + 组 SIGKILL 兜底时间

  const survivors = agents.filter(isAlive);
  for (const pid of survivors) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
  results.push([name, survivors.length === 0,
    survivors.length ? `残留: ${survivors.join(",")}` : "ok"]);
}

if (process.platform === "win32") {
  console.log("win32: skipped");
  process.exit(0);
}
const report = doctor();
if (!report.omp.available) {
  console.log("omp not available: skipped");
  process.exit(0);
}

await scenario("S1 SIGTERM → 无残留", "SIGTERM");
await scenario("S2 SIGINT → 无残留", "SIGINT");

let failed = 0;
for (const [name, ok, info] of results) {
  console.log(`${ok ? "✔" : "✘"} ${name} — ${info}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);

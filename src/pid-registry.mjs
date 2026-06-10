// synod/src/pid-registry.mjs — PID 注册表 + 崩溃后收尸。
//
// 事前防护(shutdown.mjs)覆盖不了 SIGKILL / 断电 / Node 硬崩——
// 那些路径只能事后收尸:每个子进程落一条 JSON 记录,下次启动或
// `--reap` 时扫描:owner 已死 && 进程还活 && 身份验证通过 → 击杀。
//
// 身份验证(防 PID 复用误杀,缺一不可):
//   1. comm 一致:写入时抓取 `ps -o comm=`,收尸时比对。fake 进程 /
//      已死进程抓不到 comm(null)→ 永远不会被收割(保守安全)。
//   2. 存活时长一致:进程 etime ≈ 记录年龄(±60s)。PID 被复用的
//      新进程一定比记录年轻。
// win32:收尸暂不支持(close 路径已是同步强杀,崩溃残留留待后续)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const STATE_ROOT =
  process.env.AGENT_BRIDGE_STATE_DIR || path.join(os.homedir(), ".agent-bridge");
const PID_DIR = path.join(STATE_ROOT, "pids");

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** `ps -o comm=` 取进程名;失败/win32 返回 null。 */
function psComm(pid) {
  if (process.platform === "win32") return null;
  const r = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const s = r.stdout.trim();
  return s || null;
}

/** `ps -o etime=` 解析为秒;形如 "05" / "1:23" / "1:02:03" / "2-03:04:05"。 */
function etimeSeconds(pid) {
  const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const s = r.stdout.trim();
  if (!s) return null;
  let days = 0, rest = s;
  if (s.includes("-")) {
    const [d, r2] = s.split("-");
    days = Number(d); rest = r2;
  }
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function writePidRecord({ sessionId, pid, bin }) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  fs.mkdirSync(PID_DIR, { recursive: true });
  const file = path.join(PID_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    sessionId,
    pid,
    bin: bin ?? null,
    ownerPid: process.pid,
    startedAt: Date.now(),
    comm: psComm(pid),
  }));
  return file;
}

export function removePidRecord(sessionId) {
  try { fs.unlinkSync(path.join(PID_DIR, `${sessionId}.json`)); } catch {}
}

/**
 * 扫描 PID 记录,收割孤儿。返回 { scanned, reaped, skipped, unsupported? }。
 */
export function reapOrphans({ stderr = process.stderr } = {}) {
  if (process.platform === "win32") {
    return { scanned: 0, reaped: [], skipped: [], unsupported: true };
  }
  let names = [];
  try {
    names = fs.readdirSync(PID_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return { scanned: 0, reaped: [], skipped: [] };
  }
  const reaped = [];
  const skipped = [];
  for (const name of names) {
    const file = path.join(PID_DIR, name);
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    if (rec.ownerPid === process.pid) { skipped.push({ rec, reason: "own" }); continue; }
    if (isAlive(rec.ownerPid)) { skipped.push({ rec, reason: "owner-alive" }); continue; }
    if (!isAlive(rec.pid)) {                       // 已死:只清记录
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    // 身份验证(两道,缺一不杀)
    const comm = psComm(rec.pid);
    if (!rec.comm || !comm || comm !== rec.comm) {
      skipped.push({ rec, reason: "comm-mismatch" });
      continue;
    }
    const ageSec = Math.floor((Date.now() - rec.startedAt) / 1000);
    const et = etimeSeconds(rec.pid);
    if (et === null || Math.abs(et - ageSec) > 60) {
      skipped.push({ rec, reason: "age-mismatch" });
      continue;
    }
    // 击杀:组优先(detached 子进程是组长),退化单体;短宽限后 SIGKILL。
    try { process.kill(-rec.pid, "SIGTERM"); } catch {}
    try { process.kill(rec.pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 500;
    while (isAlive(rec.pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (isAlive(rec.pid)) {
      try { process.kill(-rec.pid, "SIGKILL"); } catch {}
      try { process.kill(rec.pid, "SIGKILL"); } catch {}
    }
    try { fs.unlinkSync(file); } catch {}
    reaped.push(rec);
    stderr.write(`synod: reaped orphan ${rec.bin ?? "?"} pid=${rec.pid} (owner ${rec.ownerPid} dead)\n`);
  }
  return { scanned: names.length, reaped, skipped };
}

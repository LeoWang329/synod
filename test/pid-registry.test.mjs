// test/pid-registry.test.mjs
// 注意:必须在 import 模块之前重定向 STATE_ROOT(模块加载时读 env),
// 故本文件对被测模块只用动态 import。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

process.env.AGENT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), "synod-pids-"));
const PID_DIR = join(process.env.AGENT_BRIDGE_STATE_DIR, "pids");
const { writePidRecord, removePidRecord, reapOrphans } =
  await import("../src/pid-registry.mjs");

const POSIX = process.platform !== "win32";

test("writePidRecord 写出完整记录,removePidRecord 删除", () => {
  const file = writePidRecord({ sessionId: "s1", pid: process.pid, bin: "omp" });
  assert.ok(existsSync(file));
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(rec.sessionId, "s1");
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.ownerPid, process.pid);
  assert.equal(rec.bin, "omp");
  assert.equal(typeof rec.startedAt, "number");
  if (POSIX) assert.equal(typeof rec.comm, "string"); // 写入时抓取,收尸时比对
  removePidRecord("s1");
  assert.equal(existsSync(file), false);
});

test("无效 pid 不写记录", () => {
  assert.equal(writePidRecord({ sessionId: "bad", pid: undefined, bin: "omp" }), null);
  assert.equal(writePidRecord({ sessionId: "bad", pid: 0, bin: "omp" }), null);
});

test("reapOrphans:owner 已死 + comm 匹配 → 击杀并清记录",
  { skip: !POSIX }, async () => {
  // 真孤儿:detached 的 node 子进程(响应 SIGTERM)
  const child = spawn(process.execPath,
    ["-e", 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'],
    { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  // 确定已死的 ownerPid:跑一个瞬时进程取其 pid
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const file = writePidRecord({ sessionId: "orphan1", pid: child.pid, bin: "omp" });
  // 篡改 ownerPid 为已死 pid(writePidRecord 默认写本进程)
  const rec = JSON.parse(readFileSync(file, "utf8"));
  rec.ownerPid = dead.pid;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify(rec));

  const r = reapOrphans({ stderr: { write() {} } });
  assert.equal(r.reaped.length, 1);
  assert.equal(existsSync(file), false, "记录应被清除");
  // 进程应消亡
  await new Promise((r2) => setTimeout(r2, 300));
  assert.throws(() => process.kill(child.pid, 0), "孤儿应已被收割");
});

test("reapOrphans:owner 还活着 → 跳过", { skip: !POSIX }, () => {
  writePidRecord({ sessionId: "alive1", pid: process.pid, bin: "omp" }); // owner=本测试进程,活着
  const r = reapOrphans({ stderr: { write() {} } });
  assert.equal(r.reaped.length, 0);
  assert.ok(r.skipped.some((s) => s.reason === "owner-alive" || s.reason === "own"));
  removePidRecord("alive1");
});

test("reapOrphans:comm 缺失(fake/不可验证)→ 保守跳过", { skip: !POSIX }, async () => {
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const file = writePidRecord({ sessionId: "ghost1", pid: 99999, bin: "omp" });
  if (file) {
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.ownerPid = dead.pid;
    rec.comm = null;          // 写入时抓不到 comm(进程已死/假 pid)
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify(rec));
    const r = reapOrphans({ stderr: { write() {} } });
    assert.equal(r.reaped.length, 0, "身份不可验证绝不杀");
  }
  removePidRecord("ghost1");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotifier } from "../src/notify.mjs";
import { loadConfig } from "../src/config.mjs";
import { createApprove } from "../src/flow/api/approve.mjs";

function cap() { return { buf: "", write(s) { this.buf += s; } }; }

test("fire:执行命令并以环境变量传 EVENT/RUN_ID/EXIT_CODE", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "synod-notify-")), "out.txt");
  const cmd = `node -e "require('fs').writeFileSync(process.env.OUT,[process.env.SYNOD_EVENT,process.env.SYNOD_RUN_ID,process.env.SYNOD_EXIT_CODE].join(','))"`;
  const n = createNotifier({ config: { hooks: { onDone: cmd } }, stdout: cap(), stderr: cap(), env: { ...process.env, OUT: out } });
  await n.fire("onDone", { runId: "r1", exitCode: 0 });
  assert.equal(readFileSync(out, "utf8"), "onDone,r1,0");
});

test("fire:未配置事件 → no-op 不报错", async () => {
  const n = createNotifier({ config: { hooks: {} }, stdout: cap(), stderr: cap(), env: {} });
  await n.fire("onError", { runId: "r" });
});

test("fire:命令非零退出 → 仅警告不抛", async () => {
  const stderr = cap();
  const n = createNotifier({ config: { hooks: { onError: 'node -e "process.exit(3)"' } }, stdout: cap(), stderr, env: { ...process.env } });
  await n.fire("onError", { runId: "r" });
  assert.match(stderr.buf, /hook onError exited 3/);
});

test("bell/title:TTY 写 BEL/OSC0;非 TTY 静默(headless 不噪)", () => {
  const tty = cap(); tty.isTTY = true;
  createNotifier({ config: {}, stdout: tty, stderr: cap(), env: {} }).bell();
  createNotifier({ config: {}, stdout: tty, stderr: cap(), env: {} }).title("synod: done");
  assert.ok(tty.buf.includes("\x07"));
  assert.ok(tty.buf.includes("\x1b]0;synod: done\x07"));

  const plain = cap();
  const np = createNotifier({ config: {}, stdout: plain, stderr: cap(), env: {} });
  np.bell(); np.title("x");
  assert.equal(plain.buf, "", "非 TTY 零控制字符");
});

// Fresh cwd per case — `import()` caches by file URL, so reusing one path
// would return the first (valid) module for later writes. Mirrors the
// fresh-dir convention in test/config.test.mjs.
function freshDirs() {
  const home = mkdtempSync(join(tmpdir(), "synod-h-"));
  mkdirSync(join(home, ".synod"), { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "synod-p-"));
  return { home, cwd };
}

test("config:hooks 段校验(合法合并 / 未知键拒 / 非字符串拒)", async () => {
  const ok = freshDirs();
  writeFileSync(join(ok.cwd, "synod.config.mjs"), `export default { hooks: { onDone: "sh notify.sh" } };`);
  assert.equal((await loadConfig({ cwd: ok.cwd, home: ok.home })).hooks.onDone, "sh notify.sh");

  const bogus = freshDirs();
  writeFileSync(join(bogus.cwd, "synod.config.mjs"), `export default { hooks: { onBogus: "x" } };`);
  await assert.rejects(loadConfig({ cwd: bogus.cwd, home: bogus.home }), /onBogus.*known hook/s);

  const bad = freshDirs();
  writeFileSync(join(bad.cwd, "synod.config.mjs"), `export default { hooks: { onDone: 123 } };`);
  await assert.rejects(loadConfig({ cwd: bad.cwd, home: bad.home }), /hooks\.onDone.*non-empty/s);
});

test("approve:onApprovalNeeded 在等待输入前触发一次", async () => {
  let fired = 0;
  const io = { stdout: { write() {} }, question: async () => "accept" };
  const approve = createApprove({ io, logger: { logStep: async () => {} }, onApprovalNeeded: () => { fired += 1; } });
  const r = await approve({ runId: "r1" }, { content: "review me" });
  assert.equal(r.accepted, true);
  assert.equal(fired, 1);
});

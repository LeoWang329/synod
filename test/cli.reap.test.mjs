// test/cli.reap.test.mjs
// 同 pid-registry 测试:env 必须先于模块加载设置 → 全部动态 import。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), "synod-reap-"));
const { main, parseArgs } = await import("../src/cli.mjs");

function collector() {
  const chunks = [];
  return { write(s) { chunks.push(s); }, text: () => chunks.join("") };
}

test("parseArgs 识别 --reap", () => {
  assert.equal(parseArgs(["--reap"]).reap, true);
  assert.equal(parseArgs([]).reap, false);
});

test("--reap:扫描空目录,打印摘要,exit 0,不开任何会话", async () => {
  const stdout = collector(); const stderr = collector();
  let opened = 0;
  const code = await main({
    argv: ["node", "cli.mjs", "--reap"],
    stdin: { isTTY: false, on() {}, resume() {} },
    stdout, stderr,
    openBackend: async () => { opened++; throw new Error("unreachable"); },
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /reap: scanned \d+, reaped \d+, skipped \d+/);
  assert.equal(opened, 0);
});

// test/cli-ui.integration.test.mjs
// 端到端钉死:(1) 非 TTY REPL 零 ANSI 且提示符仍为 "> ";(2) headless(非 TTY)flow onDone 钩子触发。零真 agent。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { _unregisterForTests } from "../src/backends/registry.mjs";

const FIX = resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures", "backends");
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function collector() { const c = []; return { write(s) { c.push(s); return true; }, text: () => c.join("") }; }

function makeProj(extra = "") {
  const home = mkdtempSync(join(tmpdir(), "synod-uihome-"));
  const proj = mkdtempSync(join(tmpdir(), "synod-uiproj-"));
  mkdirSync(join(home, ".synod"), { recursive: true });
  writeFileSync(join(proj, "synod.config.mjs"), `export default {
    backends: { echo: { type: "cli", bin: ${JSON.stringify(process.execPath)},
      args: [${JSON.stringify(join(FIX, "echo-cli.mjs"))}], promptVia: "arg" } },
    agents: { echoer: { backend: "echo" } },
    ${extra}
  };`);
  return { home, proj };
}

test("非 TTY REPL:零 ANSI 噪音 + 提示符仍为 '> '", async () => {
  _unregisterForTests("echo");
  const { home, proj } = makeProj();
  const _cwd = process.cwd();
  process.chdir(proj);
  try {
    const { main } = await import("../src/cli.mjs");
    const stdin = new PassThrough(); stdin.isTTY = false;
    const stdout = collector(); const stderr = collector();
    const done = main({ argv: ["node", "cli.mjs", "--agent", "echo"], stdin, stdout, stderr, env: { SYNOD_HOME: home } });
    stdin.write("hello world\n");
    const deadline = Date.now() + 15_000;
    while (!stdout.text().includes("echo: hello world") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    stdin.write("/exit\n");
    const code = await done;
    assert.equal(code, 0);
    const out = stdout.text();
    assert.match(out, /\[echo#1\] echo: hello world/);
    assert.ok(!/\x1b\[/.test(out), "非 TTY stdout 必须零 ANSI 序列");
    assert.ok(out.includes("> "), "提示符保持 '> '");
  } finally {
    process.chdir(_cwd);
    _unregisterForTests("echo");
  }
});

test("headless 钩子:onDone 在非 TTY flow 运行后照常触发", async () => {
  _unregisterForTests("echo");
  const sentinel = join(mkdtempSync(join(tmpdir(), "synod-sent-")), "done.txt");
  // 路径经 env var 传递,避免 shell 双引号嵌套引发的解析错误。
  const hookCmd = `node -e "require('fs').writeFileSync(process.env.SYNOD_TEST_SENTINEL, process.env.SYNOD_EVENT)"`;
  const { home, proj } = makeProj(`hooks: { onDone: ${JSON.stringify(hookCmd)} },`);
  mkdirSync(join(proj, "workflows"));
  mkdirSync(join(proj, "node_modules"), { recursive: true });
  symlinkSync(PKG_ROOT, join(proj, "node_modules", "synod"), "dir");
  writeFileSync(join(proj, "workflows", "echo-flow.mjs"), `
import { agent } from "synod/flow";
export const meta = { description: "echo via profile" };
export async function run(ctx, input) {
  const out = await agent(ctx, { profile: "echoer", prompt: String(input ?? "ping") });
  return { out: out.trim() };
}
`);
  const _prevHome = process.env.SYNOD_HOME;
  const _prevSentinel = process.env.SYNOD_TEST_SENTINEL;
  process.env.SYNOD_HOME = home;
  process.env.SYNOD_TEST_SENTINEL = sentinel;
  try {
    const { main: flowMain } = await import("../src/flow.mjs");
    const stdout = collector(); const stderr = collector();
    const code = await flowMain({ argv: ["echo-flow", "ping"], stdout, stderr, workflowsRoot: join(proj, "workflows"), cwd: proj });
    assert.equal(code, 0, stderr.text());
    assert.ok(existsSync(sentinel), "onDone 钩子应已执行");
    assert.equal(readFileSync(sentinel, "utf8"), "onDone");
  } finally {
    if (_prevHome === undefined) delete process.env.SYNOD_HOME;
    else process.env.SYNOD_HOME = _prevHome;
    if (_prevSentinel === undefined) delete process.env.SYNOD_TEST_SENTINEL;
    else process.env.SYNOD_TEST_SENTINEL = _prevSentinel;
    _unregisterForTests("echo");
  }
});

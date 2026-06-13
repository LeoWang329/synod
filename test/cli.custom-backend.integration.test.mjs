// test/cli.custom-backend.integration.test.mjs
// 端到端验证"灵活接入其他 CLI":config 声明一个 node 脚本当外部 CLI,
// REPL 主持人模式直接对话 + flow 经 profile 调用,全程零真 agent。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { _unregisterForTests } from "../src/backends/registry.mjs";

const FIX = resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures", "backends");
// synod 包根:flow 文件只许 import "synod/flow",tmp 工程外解析不到,
// 故在工程里建 node_modules/synod 软链(真实用户工程就这样装依赖)。
// Node 默认按 realpath 去重,软链与包内文件解析到同一规范路径,
// runner 的 setCurrentRuntime 与 flow 的 getCurrentRuntime 共享同一模块态。
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), "synod-e2e-home-"));
  const proj = mkdtempSync(join(tmpdir(), "synod-e2e-proj-"));
  mkdirSync(join(home, ".synod"), { recursive: true });
  writeFileSync(join(proj, "synod.config.mjs"), `export default {
    backends: {
      echo: { type: "cli", bin: ${JSON.stringify(process.execPath)},
              args: [${JSON.stringify(join(FIX, "echo-cli.mjs"))}], promptVia: "arg" },
    },
    agents: { echoer: { backend: "echo" } },
  };`);
  return { home, proj };
}

function collector() {
  const chunks = [];
  return { write(s) { chunks.push(s); return true; }, text: () => chunks.join("") };
}

test("REPL:--agent echo 默认会话,消息经假 CLI 回显", async () => {
  _unregisterForTests("echo");                          // registry 隔离
  const { home, proj } = makeEnv();
  process.chdir(proj);                                   // config 发现按 cwd
  const { main } = await import("../src/cli.mjs");
  const stdin = new PassThrough();
  const stdout = collector(); const stderr = collector();
  stdin.isTTY = false;
  const done = main({
    argv: ["node", "cli.mjs", "--agent", "echo"],
    stdin, stdout, stderr,
    env: { SYNOD_HOME: home },
  });
  stdin.write("hello world\n");
  // 轮询等待回显(echo CLI 一个 turn 几百 ms)
  const deadline = Date.now() + 15_000;
  while (!stdout.text().includes("echo: hello world") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  stdin.write("/exit\n");
  const code = await done;
  assert.equal(code, 0, stderr.text());
  // label-once 单会话:[echo#1] 头打一次 + 正文随后(不再每行带前缀)
  assert.match(stdout.text(), /\[echo#1\]/, "应出现 echo#1 标签头");
  assert.match(stdout.text(), /echo: hello world/, "假 CLI 回显正文应出现");
  _unregisterForTests("echo");                          // 收尾
});

test("flow:经 profile 调用假 CLI", async () => {
  _unregisterForTests("echo");                          // registry 隔离
  const { home, proj } = makeEnv();
  process.chdir(proj);
  mkdirSync(join(proj, "workflows"));
  // 让 flow 文件的 import "synod/flow" 在 tmp 工程里可解析。
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
  process.env.SYNOD_HOME = home;
  const { main: flowMain } = await import("../src/flow.mjs");
  const stdout = collector(); const stderr = collector();
  const code = await flowMain({
    argv: ["echo-flow", "ping"],
    stdout, stderr,
    workflowsRoot: join(proj, "workflows"),
    cwd: proj,
  });
  assert.equal(code, 0, stderr.text());
  assert.match(stdout.text(), /"out": "echo: ping"/);
  _unregisterForTests("echo");                          // 收尾
});

test("flowMain 传入已注册 config 时不重复注册(REPL /flow 场景不再 already-registered)", async () => {
  _unregisterForTests("echo");
  const { home, proj } = makeEnv();              // makeEnv 写 config:backend "echo" + agent "echoer"
  process.chdir(proj);
  mkdirSync(join(proj, "workflows"));
  // 让 flow 文件的 import "synod/flow" 在 tmp 工程里可解析(同上一用例)。
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
  const { loadConfig, registerConfigBackends } = await import("../src/config.mjs");
  const config = await loadConfig({ cwd: proj, home });
  await registerConfigBackends(config);          // 模拟 cli main 已注册
  const { main: flowMain } = await import("../src/flow.mjs");
  const stdout = collector(); const stderr = collector();
  const code = await flowMain({
    argv: ["echo-flow", "ping"], stdout, stderr,
    workflowsRoot: join(proj, "workflows"), cwd: proj,
    config,                                       // 传入已加载+已注册的 config → flow 跳过重复注册
  });
  assert.equal(code, 0, stderr.text());           // 不因 "already registered" 失败
  assert.match(stdout.text(), /"out": "echo: ping"/);
  _unregisterForTests("echo");
});

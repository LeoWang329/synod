// test/backends.generic-cli.deadpipe.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  makeGenericCliAdapter, guardWindowsArgInjection,
} from "../src/backends/generic-cli.mjs";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "backends");
const NODE = process.execPath;
const cwd = process.cwd();

test("P0-27 promptVia:stdin 的 CLI 提前退出 → send 以失败收口,不崩宿主", async () => {
  const adapter = makeGenericCliAdapter("epipe", {
    type: "cli", bin: NODE, args: [path.join(FIX, "epipe-cli.mjs")], promptVia: "stdin",
  });
  const session = await adapter.open({ cwd });
  // 1MB prompt:大概率写不完就 EPIPE。无 stdin error 监听则此处 uncaughtException 崩测试进程。
  const big = "x".repeat(1024 * 1024);
  await assert.rejects(session.send(big, { wait: true }));  // 拒绝即可,关键是不崩
  assert.equal(session.status, "idle", "失败后会话可复用");
  session.close();
});

test("P1-31 win32 cmd shim 下 promptVia:arg 被拒(纯函数,跨平台可测)", () => {
  // 包装命令落到 cmd.exe → arg 注入风险 → 必须拒绝
  assert.throws(
    () => guardWindowsArgInjection({ command: "C:\\Windows\\System32\\cmd.exe" }, "arg", "x"),
    /promptVia.*stdin|cmd\.exe/i,
  );
  // 非 cmd.exe(原生 exe)→ 不拒绝
  assert.doesNotThrow(() => guardWindowsArgInjection({ command: "/usr/bin/node" }, "arg", "x"));
  // stdin 模式永远安全
  assert.doesNotThrow(() => guardWindowsArgInjection({ command: "C:\\cmd.exe" }, "stdin", "x"));
});

test("P1-31 model 过 sanitizeAgentArg(非法字符拒绝)", async () => {
  // open 是 async,构造函数里的同步 throw 转成 rejected promise → 用 assert.rejects
  // (与本文件 P2-38 用例同款);assert.throws 抓不到异步拒绝。
  await assert.rejects(
    makeGenericCliAdapter("m", { type: "cli", bin: NODE, modelFlag: "--model" })
      .open({ cwd, model: "evil&calc" }),
    /Invalid model/,
  );
});

test("P2-38 open 收到 systemPrompt/mesh → 显式报错(role 不得在 cli backend 上无声失效)", async () => {
  const adapter = makeGenericCliAdapter("s", { type: "cli", bin: NODE, args: ["-e", "0"] });
  await assert.rejects(adapter.open({ cwd, systemPrompt: "你是 x" }), /systemPrompt.*not supported|type:cli/i);
  await assert.rejects(adapter.open({ cwd, mesh: true }), /mesh.*not supported|type:cli/i);
});

test("P0-27 大 prompt 经 stdin 全量写入慢消费 CLI → send 成功(背压不丢字节)", async () => {
  // 与 epipe 用例互补:消费端读完整个 stdin(不提前退出),验证大 payload 在背压下
  // 正确 drain、无字节丢失、不误触 stdin 'error'。slow-stdin-cli 回显 "ok:<字节数>"。
  const adapter = makeGenericCliAdapter("slow", {
    type: "cli", bin: NODE, args: [path.join(FIX, "slow-stdin-cli.mjs")], promptVia: "stdin",
  });
  const session = await adapter.open({ cwd });
  const n = 512 * 1024;
  await session.send("y".repeat(n), { wait: true });
  assert.equal(session.lastAssistantText, `ok:${n}`, "全部字节应抵达消费端(背压无丢字节)");
  assert.equal(session.status, "idle");
  session.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRuntime } from "../src/flow/runtime.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };
const h8 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 8);

test("bash 命中重放:回放 logged {stdout,stderr,code},绝不 exec 子进程", async () => {
  const steps = [{
    node: "bash", hash: h8("rm -rf /"), output: "fake-out", type: "bash",
    entry: { code: 0, stderr: "warn" },
  }];
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, replay: { runId: "r", steps } });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.bash(ctx, "rm -rf /");   // 危险命令:命中重放绝不真跑
  assert.equal(r.stdout, "fake-out");
  assert.equal(r.stderr, "warn");
  assert.equal(r.code, 0);
});

test("bash 失配真跑:第一个不匹配处起真 exec", async () => {
  const steps = [{ node: "bash", hash: h8("echo first"), output: "first", type: "bash", entry: { code: 0 } }];
  const runtime = createRuntime({ fs: nullFs, clock: () => 0, replay: { runId: "r", steps } });
  const ctx = runtime.createCtx({}, { cwd: process.cwd(), runId: "r" });
  assert.equal((await runtime.bash(ctx, "echo first")).stdout, "first");   // 重放
  const live = await runtime.bash(ctx, "echo second");                      // 真跑
  assert.match(live.stdout, /second/);
  assert.equal(live.code, 0);
});

test("approve 命中重放:按 logged 决定重建结果,不重新问(io.question 永挂也不卡)", async () => {
  const stepsAccept = [{ node: "approve", hash: h8("ready?"), output: "accept", type: "approve", entry: { accepted: true, aborted: false } }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, replay: { runId: "r", steps: stepsAccept },
    io: { stdout: { write() {} }, stdin: {}, question: () => new Promise(() => {}) }, // 永不应答
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.approve(ctx, { content: "ready?" });
  assert.deepEqual(r, { accepted: true });
});

test("approve 重放 feedback:回放 {accepted:false, feedback}", async () => {
  const steps = [{ node: "approve", hash: h8("doc"), output: "改第一段", type: "approve", entry: { accepted: false, aborted: false } }];
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, replay: { runId: "r", steps },
    io: { stdout: { write() {} }, stdin: {}, question: () => new Promise(() => {}) },
  });
  const ctx = runtime.createCtx({}, { cwd: "/tmp", runId: "r" });
  const r = await runtime.approve(ctx, { content: "doc" });
  assert.deepEqual(r, { accepted: false, feedback: "改第一段" });
});

import { test } from "node:test";
import assert from "node:assert";
import { createSessionManager } from "../src/session-manager.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

const REPORT = { omp: { available: true } };
const cap = () => ({ buf: "", write(s) { this.buf += s; return true; } });

function mk(extra = {}) {
  const stdout = cap(), stderr = cap();
  const sm = createSessionManager({
    openBackend: (opts) => fakeOpenBackend(opts),   // ← 正确用法(helper 是 async opener)
    stdout, stderr, report: REPORT, cwd: process.cwd(),
    defaults: {}, onIdle: () => {}, ...extra,
  });
  return { sm, stdout, stderr };
}

test("onSessionOpen 在每个 session 建好后以 (label, session) 调用", async () => {
  const seen = [];
  const { sm } = mk({ onSessionOpen: (label, session) => seen.push([label, typeof session.on]) });
  const label = await sm.open({ agent: "omp" });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0][0], label);
  assert.strictEqual(seen[0][1], "function"); // EventEmitter
});

test("renderOutput:false 时,模型 delta 不写 stdout", async () => {
  const { sm, stdout } = mk({ renderOutput: false });
  const label = await sm.open({ agent: "omp" });
  const session = sm._sessions.get(label).session;
  session.emit("status", { status: "running", isStreaming: true });
  session.emit("delta", "模型输出不该落到 stdout");
  session.emit("status", { status: "idle", isStreaming: false });
  assert.ok(!stdout.buf.includes("模型输出不该落到 stdout"));
});

test("renderOutput 默认 true:模型 delta 仍写 stdout(不回归)", async () => {
  const { sm, stdout } = mk();
  const label = await sm.open({ agent: "omp" });
  const session = sm._sessions.get(label).session;
  session.emit("status", { status: "running", isStreaming: true });
  session.emit("delta", "正常渲染");
  assert.ok(stdout.buf.includes("正常渲染"));
});

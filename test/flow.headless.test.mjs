// test/flow.headless.test.mjs — §4.13 headless approve 断点 + 退出码 5。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/flow/runtime.mjs";
import { readCheckpoint, isAwaitingHuman } from "../src/flow/checkpoint.mjs";

const nullFs = { writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {} };

test("headless approve:不问 stdin,写 checkpoint(awaiting-approval)+ 打印待审 + emit + 抛 AwaitingHuman", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "synod-hl-"));
  const out = [];
  const events = new EventEmitter();
  const seen = [];
  events.on("approvalNeeded", (info) => seen.push(info));
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, runsRoot,
    headless: true, events,
    io: { stdout: { write: (s) => out.push(s) }, stdin: {}, question: () => { throw new Error("must not ask"); } },
  });
  const ctx = runtime.createCtx({}, { cwd: "/p", runId: "hl-run" });
  const { writeCheckpoint } = await import("../src/flow/checkpoint.mjs");
  writeCheckpoint(runsRoot, "hl-run", { flowName: "f", input: null, cwd: "/p", status: "running" });

  await assert.rejects(
    runtime.approve(ctx, { content: "请审阅这段内容\n第二行" }),
    (err) => { assert.equal(isAwaitingHuman(err), true); assert.equal(err.exitCode, 5); return true; },
  );
  assert.match(out.join(""), /请审阅这段内容\n第二行/);
  const ck = readCheckpoint(runsRoot, "hl-run");
  assert.equal(ck.status, "awaiting-approval");
  assert.equal(ck.pending.content, "请审阅这段内容\n第二行");
  assert.equal(ck.stoppedAt.node, "approve");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].runId, "hl-run");
});

test("非 headless:approve 仍走 io.question(回归守卫)", async () => {
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0,
    headless: false,
    io: { stdout: { write() {} }, stdin: {}, question: async () => "accept" },
  });
  const ctx = runtime.createCtx({}, { cwd: "/p", runId: "tty-run" });
  const r = await runtime.approve(ctx, { content: "ok?" });
  assert.deepEqual(r, { accepted: true });
});

test("headless 但命中重放:不触发断点(已决定的 approve 直接回放)", async () => {
  const { createHash } = await import("node:crypto");
  const h8 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
  const runtime = createRuntime({
    fs: nullFs, clock: () => 0, headless: true,
    replay: { runId: "r", steps: [{ node: "approve", hash: h8("ok?"), output: "accept", type: "approve", entry: { accepted: true } }] },
    io: { stdout: { write() {} }, stdin: {}, question: () => { throw new Error("must not ask"); } },
  });
  const ctx = runtime.createCtx({}, { cwd: "/p", runId: "r" });
  const r = await runtime.approve(ctx, { content: "ok?" });
  assert.deepEqual(r, { accepted: true }, "重放先于 headless 判定");
});

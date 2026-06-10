// test/backend.waitidle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { openBackend } from "../src/backend.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";

// 现状 bug(V1 文档 P0-5):waitIdle 内 `await this.state()` 无超时,
// omp 进程活着但 RPC 不应答时,send(wait:true) 永久挂死,
// DEFAULT_WAIT_TIMEOUT_MS 形同虚设。本测试用 per-test timeout 把
// "挂死"显形为测试失败;修复后应在 ~2s 内以 Timed out 拒绝。
test("get_state 无应答时 waitIdle 在总超时内拒绝(不挂死)",
  { timeout: 10_000 }, async () => {
  const session = await openBackend({
    agent: "omp", cwd: process.cwd(),
    spawnImpl: () => makeFakeOmpProc({ stallTurn: true, dropGetState: true }),
  });
  try {
    await session.send("hi");          // no-wait:turn 卡在 streaming
    await assert.rejects(
      session.waitIdle(1500, { probeTimeoutMs: 100 }),
      /Timed out waiting/,
    );
  } finally {
    session.close();
  }
});

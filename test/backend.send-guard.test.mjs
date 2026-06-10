// test/backend.send-guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { openBackend } from "../src/backend.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";

// CodexSession 早有 `already has a running turn` 守卫;OmpSession 没有——
// 并发第二次 send 会重置 turnText/turnStarted,毁掉第一个 turn 的累积
// 文本(V1 文档 P1-6a)。对齐两后端语义。
test("OMP 运行中再次 send 抛错(并发 turn 守卫)", async () => {
  const session = await openBackend({
    agent: "omp", cwd: process.cwd(),
    spawnImpl: () => makeFakeOmpProc({ stallTurn: true }),
  });
  try {
    await session.send("first");                 // no-wait,卡在 running
    await assert.rejects(
      session.send("second"),
      /already has a running turn/,
    );
  } finally {
    session.close();
  }
});

test("turn 正常结束后可再次 send", async () => {
  const session = await openBackend({
    agent: "omp", cwd: process.cwd(),
    spawnImpl: () => makeFakeOmpProc(),
  });
  try {
    const r1 = await session.send("one", { wait: true });
    assert.ok(r1.text);
    const r2 = await session.send("two", { wait: true });
    assert.ok(r2.text);
  } finally {
    session.close();
  }
});

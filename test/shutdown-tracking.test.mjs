// test/shutdown-tracking.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { openBackend } from "../src/backend.mjs";
import { liveSessions, _clearForTests } from "../src/shutdown.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";

test("openBackend 成功 → 会话进注册表;close → 注销", async () => {
  _clearForTests();
  const session = await openBackend({
    agent: "omp", cwd: process.cwd(),
    spawnImpl: () => makeFakeOmpProc(),
  });
  assert.equal(liveSessions().includes(session), true, "open 后必须在注册表");
  session.close();
  assert.equal(liveSessions().length, 0, "close 后必须注销");
});

test("openBackend 启动失败 → 注册表不残留", async () => {
  _clearForTests();
  await assert.rejects(openBackend({
    agent: "omp", cwd: process.cwd(),
    spawnImpl: () => makeFakeOmpProc({ closeCodeOnStart: 3 }),
  }));
  assert.equal(liveSessions().length, 0);
});

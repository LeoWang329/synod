// test/backends.registry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  registerBackend, getBackend, backendNames, _unregisterForTests,
} from "../src/backends/registry.mjs";

const stub = (name) => ({ name, doctor: () => ({ available: true, version: "1" }), open: async () => ({}) });

test("register/get/backendNames 基本语义", () => {
  registerBackend(stub("t1-a"));
  registerBackend(stub("t1-b"));
  assert.equal(getBackend("t1-a").name, "t1-a");
  assert.ok(backendNames().includes("t1-a") && backendNames().includes("t1-b"));
  assert.equal(getBackend("nope"), null);
  _unregisterForTests("t1-a"); _unregisterForTests("t1-b");
});

test("重复注册同名 → 抛错", () => {
  registerBackend(stub("t1-dup"));
  assert.throws(() => registerBackend(stub("t1-dup")), /already registered/);
  _unregisterForTests("t1-dup");
});

test("adapter 形状校验:缺 name/open/doctor、非法 name 都拒绝", () => {
  assert.throws(() => registerBackend({ open: async () => {}, doctor: () => {} }), /name/);
  assert.throws(() => registerBackend({ name: "x y", open: async () => {}, doctor: () => {} }), /invalid name/);
  assert.throws(() => registerBackend({ name: "t1-noopen", doctor: () => {} }), /open\(\)/);
  assert.throws(() => registerBackend({ name: "t1-nodoc", open: async () => {} }), /doctor\(\)/);
});

import { openBackend, doctor } from "../src/backend.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";
import { liveSessions, _clearForTests } from "../src/shutdown.mjs";

test("内置 omp/codex 已在注册表", () => {
  assert.ok(backendNames().includes("omp"));
  assert.ok(backendNames().includes("codex"));
});

test("openBackend 走注册表:自定义 adapter 的会话同样被 track,close 被包装为必注销", async () => {
  _clearForTests();
  const fake = new FakeSession({ deltas: ["hi"] });
  registerBackend({
    name: "t2-custom",
    doctor: () => ({ available: true, version: "0" }),
    open: async () => fake,
  });
  const session = await openBackend({ agent: "t2-custom", cwd: process.cwd() });
  assert.equal(session, fake);
  assert.ok(liveSessions().includes(session), "第三方 adapter 的会话也必须被 track");
  session.close();                       // FakeSession.close 自己不会 untrack——
  assert.equal(liveSessions().length, 0, "openBackend 的 close 包装必须兜底注销");
  _unregisterForTests("t2-custom");
});

test("未注册名 → 抛错并列出已注册名", async () => {
  await assert.rejects(
    openBackend({ agent: "ghost", cwd: process.cwd() }),
    /Unsupported agent "ghost".*omp.*codex/s,
  );
});

test("doctor() 聚合全部已注册 adapter", async () => {
  registerBackend({ name: "t2-doc", doctor: () => ({ available: true, version: "9.9" }), open: async () => ({}) });
  const r = await doctor();
  assert.equal(r["t2-doc"].version, "9.9");
  assert.ok("omp" in r && "codex" in r);
  _unregisterForTests("t2-doc");
});

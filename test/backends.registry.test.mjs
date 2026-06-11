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

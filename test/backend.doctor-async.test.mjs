import test from "node:test";
import assert from "node:assert/strict";
import { doctor } from "../src/backend.mjs";
import { registerBackend, _unregisterForTests } from "../src/backends/registry.mjs";

test("P2-35 doctor 等待 async adapter 的 doctor(不把 Promise 当 available)", async () => {
  registerBackend({
    name: "t3-async",
    doctor: async () => ({ available: true, version: "9" }),
    open: async () => ({}),
  });
  const r = await doctor();
  assert.equal(r["t3-async"].available, true, "async doctor 必须被 await");
  assert.equal(r["t3-async"].version, "9");
  _unregisterForTests("t3-async");
});

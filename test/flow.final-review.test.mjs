import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as fr from "../workflows/superpowers/final-review.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs() {
  const f = new Map();
  return { async writeFile(p, c) { f.set(p, c); }, async appendFile(p, c) { f.set(p, (f.get(p) ?? "") + c); }, get(p) { return f.get(p); } };
}
function fakeWorkspace(cwd) {
  return { acquire: () => ({ path: cwd }), finalize: () => ({ merged: [], conflicts: [] }) };
}

describe("final-review", () => {
  it("直接 APPROVE → approved:true", async () => {
    const backend = async ({ agent }) => new FakeSession({ agent, deltas: ["APPROVE"] });
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, openBackend: backend, runWorkspace: fakeWorkspace(process.cwd()) });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, fr, ctx, {});
    assert.equal(out.approved, true);
    assert.match(out.report, /APPROVE/);
  });

  it("先 REJECT → deepseek 修 → 复审 APPROVE", async () => {
    const verdicts = ["REJECT 缺测试", "APPROVE"];
    const backend = async ({ agent, write }) =>
      new FakeSession({ agent, deltas: [write ? "fixed" : verdicts.shift()] });
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, openBackend: backend, runWorkspace: fakeWorkspace(process.cwd()) });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, fr, ctx, {});
    assert.equal(out.approved, true);
  });

  it("两轮都 REJECT → approved:false", async () => {
    const backend = async ({ agent, write }) =>
      new FakeSession({ agent, deltas: [write ? "tried" : "REJECT 还不行"] });
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, openBackend: backend, runWorkspace: fakeWorkspace(process.cwd()) });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, fr, ctx, {});
    assert.equal(out.approved, false);
  });
});

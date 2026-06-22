import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as exec from "../workflows/superpowers/execute-plan.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs() {
  const f = new Map();
  return { async writeFile(p, c) { f.set(p, c); }, async appendFile(p, c) { f.set(p, (f.get(p) ?? "") + c); }, get(p) { return f.get(p); } };
}

// fake runWorkspace:writer 的 write+workspace 需要它(否则 acquireWorkspace 抛错)。
function fakeWorkspace(cwd) {
  return { acquire: () => ({ path: cwd }), finalize: () => ({ merged: [], conflicts: [] }) };
}

// fake openBackend:按 agent 名派发文本。FakeSession 返回文本靠 deltas(非 text)。
function backendBy({ codex, writer }) {
  return async ({ agent }) => {
    const text = agent === "codex" ? codex() : writer();
    return new FakeSession({ agent, deltas: [text] });
  };
}

describe("execute-plan", () => {
  it("单 task 一次过 → done", async () => {
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0,
      openBackend: backendBy({ codex: () => "APPROVE", writer: () => "written" }),
      runWorkspace: fakeWorkspace(process.cwd()),
    });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, exec, ctx, {
      planText: "### Task 1: 加 foo\n实现 foo",
      testCmd: "true",          // shell true → code 0
      gates: "none",
    });
    assert.equal(out.done, true);
    assert.deepEqual(out.completed, ["1"]);
  });

  it("task 测试持续失败 → 自动刹车 {done:false, failedTask}", async () => {
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0,
      openBackend: backendBy({ codex: () => "REJECT 还不行", writer: () => "written" }),
      runWorkspace: fakeWorkspace(process.cwd()),
    });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, exec, ctx, {
      planText: "### Task 1: 加 foo\n实现 foo",
      testCmd: "false",         // shell false → code 1
      gates: "none",
    });
    assert.equal(out.done, false);
    assert.equal(out.failedTask, "1");
    assert.deepEqual(out.completed, []);
  });

  it("两个 task 顺序完成 → completed [1,2]", async () => {
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0,
      openBackend: backendBy({ codex: () => "APPROVE", writer: () => "written" }),
      runWorkspace: fakeWorkspace(process.cwd()),
    });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, exec, ctx, {
      planText: "### Task 1: a\nbody a\n### Task 2: b\nbody b",
      testCmd: "true", gates: "none",
    });
    assert.equal(out.done, true);
    assert.deepEqual(out.completed, ["1", "2"]);
  });
});

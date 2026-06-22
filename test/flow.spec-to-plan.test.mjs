import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as s2p from "../workflows/superpowers/spec-to-plan.mjs";
import { parsePlan } from "../workflows/superpowers/execute-plan.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs() {
  const f = new Map();
  return { async writeFile(p, c) { f.set(p, c); }, async appendFile(p, c) { f.set(p, (f.get(p) ?? "") + c); }, get(p) { return f.get(p); } };
}
function scriptedIo(answers) {
  const out = []; let i = 0;
  return { stdout: { write(s) { out.push(s); } }, stdin: {}, question() { return Promise.resolve(answers[i++] ?? "accept"); } };
}

describe("spec-to-plan", () => {
  it("产出的计划能被 parsePlan 解析(契约对齐)", async () => {
    const io = scriptedIo(["accept"]);   // reviseWithHuman 第一次就 accept
    const backend = async ({ agent }) => new FakeSession({ agent, deltas: ["### Task 1: 加 foo\n实现 foo"] });
    const rt = createRuntime({ fs: memoryFs(), clock: () => 0, io, openBackend: backend });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, s2p, ctx, { specText: "# 设计\n做 foo" });
    const tasks = parsePlan(out.planText);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "加 foo");
  });
});

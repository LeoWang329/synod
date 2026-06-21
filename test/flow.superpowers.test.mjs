import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as superpowers from "../workflows/superpowers.mjs";
import { gate } from "../workflows/superpowers.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

const WORKFLOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workflows");

function memoryFs() {
  const f = new Map();
  return { async writeFile(p, c) { f.set(p, c); }, async appendFile(p, c) { f.set(p, (f.get(p) ?? "") + c); }, get(p) { return f.get(p); } };
}
function scriptedIo(answers) {
  const out = []; let i = 0;
  return { stdout: { write(s) { out.push(s); } }, stdin: {}, question() { return Promise.resolve(answers[i++] ?? "accept"); } };
}
function fakeWorkspace(cwd) {
  return { acquire: () => ({ path: cwd }), finalize: () => ({ merged: [], conflicts: [] }) };
}

describe("superpowers gate()", () => {
  it("none → 全 false", () => {
    for (const s of ["spec", "plan", "dev", "final"]) assert.equal(gate(s, "none"), false);
  });
  it("final → 仅 final true", () => {
    assert.equal(gate("final", "final"), true);
    for (const s of ["spec", "plan", "dev"]) assert.equal(gate(s, "final"), false);
  });
  it("all → 全 true", () => {
    for (const s of ["spec", "plan", "dev", "final"]) assert.equal(gate(s, "all"), true);
  });
});

describe("superpowers chain (gates:none)", () => {
  it("brainstorm→plan→execute→review 全链跑通 → status:done", async () => {
    // codex 按链路调用顺序供文本:brainstorm记号草稿 → 计划 → 开发审APPROVE → 终审APPROVE
    const codexTexts = [
      "<<<SPEC>>>\n# 设计稿\n做 foo",          // brainstorm(reuse,1 send)
      "### Task 1: 做 foo\n实现 foo 返回 42",   // spec-to-plan
      "APPROVE",                                // execute-plan codex 审
      "APPROVE",                                // final-review codex 审
    ];
    const backend = async ({ agent }) => {
      const text = agent === "codex" ? (codexTexts.shift() ?? "APPROVE") : "written";
      return new FakeSession({ agent, deltas: [text] });
    };
    // io:brainstorm approve、spec-to-plan reviseWithHuman approve(gates:none 无其它人审)
    const io = scriptedIo(["accept", "accept"]);
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0, io, openBackend: backend,
      runWorkspace: fakeWorkspace(process.cwd()),
      workflowsRoot: WORKFLOWS_ROOT,
    });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, superpowers, ctx, {
      topic: "做 foo", gates: "none", testCmd: "true", maxTurns: 5,
    });
    assert.equal(out.status, "done");
    assert.deepEqual(out.completed, ["1"]);
    assert.match(out.specText, /设计稿/);
    assert.equal(out.review.approved, true);
  });

  it("开发 task 写不过 → status:halted(自动刹车,不进 review)", async () => {
    const codexTexts = [
      "<<<SPEC>>>\n# 设计稿",                   // brainstorm
      "### Task 1: 做 foo\n实现 foo",           // plan
      "REJECT 不行", "REJECT 不行", "REJECT 不行", // execute 审:3 轮全拒
    ];
    const backend = async ({ agent }) => {
      const text = agent === "codex" ? (codexTexts.shift() ?? "REJECT") : "written";
      return new FakeSession({ agent, deltas: [text] });
    };
    const io = scriptedIo(["accept", "accept"]);
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0, io, openBackend: backend,
      runWorkspace: fakeWorkspace(process.cwd()),
      workflowsRoot: WORKFLOWS_ROOT,
    });
    const ctx = rt.createCtx({ input: {} });
    const out = await runFlow(rt, superpowers, ctx, {
      topic: "做 foo", gates: "none", testCmd: "false", maxTurns: 5,
    });
    assert.equal(out.status, "halted");
    assert.equal(out.at, "1");
  });
});

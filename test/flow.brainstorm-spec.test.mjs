import { describe, it } from "node:test";
import assert from "node:assert";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import * as brainstorm from "../workflows/superpowers/brainstorm-spec.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

function memoryFs() {
  const f = new Map();
  return { async writeFile(p, c) { f.set(p, c); }, async appendFile(p, c) { f.set(p, (f.get(p) ?? "") + c); }, get(p) { return f.get(p); } };
}

// scriptedIo:question 按序返回预设答复(ask 与 approve 都走 question)。
function scriptedIo(answers) {
  const out = [];
  let i = 0;
  return { stdout: { write(s) { out.push(s); }, get lines() { return out; } }, stdin: {}, question() { return Promise.resolve(answers[i++] ?? ""); } };
}

// brainstorm 用 reuse:true → openBackend 只调一次 → 一个 session 配 texts(按轮返回)。
function reuseBackend(texts) {
  let made = 0;
  return async ({ agent }) => { made++; return new FakeSession({ agent, texts }); };
}

describe("brainstorm-spec", () => {
  it("一轮提问→人答→agent 吐记号→人 accept→定稿", async () => {
    const io = scriptedIo(["我要做一个 X", "accept"]);   // ask 答 / approve accept
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0, io,
      openBackend: reuseBackend([
        "请问 X 的目标用户是谁?",                          // turn1 agent:提问
        "<<<SPEC>>>\n# X 设计\n目标用户:开发者。",          // turn2 agent:记号+草稿
      ]),
    });
    const ctx = rt.createCtx({ input: { topic: "X", maxTurns: 5 } });
    const out = await runFlow(rt, brainstorm, ctx, ctx.input);
    assert.match(out.specText, /X 设计/);
    assert.ok(!out.aborted);
  });

  it("人打 /spec 强制收尾", async () => {
    const io = scriptedIo(["/spec", "accept"]);
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0, io,
      openBackend: reuseBackend([
        "第一个问题?",                                     // turn1 提问
        "<<<SPEC>>>\n# 强制收尾的草稿",                     // turn2 被 /spec 触发产出草稿
      ]),
    });
    const ctx = rt.createCtx({ input: { topic: "Y", maxTurns: 5 } });
    const out = await runFlow(rt, brainstorm, ctx, ctx.input);
    assert.match(out.specText, /强制收尾/);
  });

  it("人对草稿给反馈→再改→accept", async () => {
    const io = scriptedIo(["请加上错误处理一节", "accept"]); // approve#1 反馈 / approve#2 accept
    const rt = createRuntime({
      fs: memoryFs(), clock: () => 0, io,
      openBackend: reuseBackend([
        "<<<SPEC>>>\n# 初稿",                              // turn1 直接出记号
        "<<<SPEC>>>\n# 二稿(含错误处理)",                  // turn2 改稿
      ]),
    });
    const ctx = rt.createCtx({ input: { topic: "Z", maxTurns: 5 } });
    const out = await runFlow(rt, brainstorm, ctx, ctx.input);
    assert.match(out.specText, /二稿/);
  });
});

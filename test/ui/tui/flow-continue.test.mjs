import { test } from "node:test";
import assert from "node:assert";
import { buildContinuation } from "../../../src/ui/tui/flow-continue.mjs";

const card = {
  flowName: "qa", lastAgent: "omp", lastModel: "minimax/MiniMax-M3",
  entries: [
    { type: "assistant", agent: "mimo-v2.5-pro", turn: 1, text: "出一道题" },
    { type: "assistant", agent: "MiniMax-M3", turn: 2, text: "我的回答" },
    { type: "approve", agent: "mimo-v2.5-pro", turn: 3, text: "PASS?" },
    { type: "output", text: "diff..." },
  ],
};

test("buildContinuation:agent/model 取卡的 lastAgent/lastModel;seed 含 flowName/transcript/追问", () => {
  const { agent, model, seed } = buildContinuation(card, "再难一点", { defaultAgent: "codex" });
  assert.strictEqual(agent, "omp");                    // 续聊对最后发言的真后端
  assert.strictEqual(model, "minimax/MiniMax-M3");
  assert.match(seed, /flow「qa」/);
  assert.match(seed, /mimo-v2\.5-pro: 出一道题/);
  assert.match(seed, /MiniMax-M3: 我的回答/);
  assert.match(seed, /\[确认\] PASS\?/);
  assert.match(seed, /\[输出\] diff/);
  assert.match(seed, /用户追问:\n再难一点/);
});

test("buildContinuation:lastAgent 缺失 → 回退 defaultAgent;model 为 null", () => {
  const c = { flowName: "x", entries: [{ type: "assistant", agent: "a", turn: 1, text: "hi" }] };
  const { agent, model } = buildContinuation(c, "q", { defaultAgent: "omp" });
  assert.strictEqual(agent, "omp");
  assert.strictEqual(model, null);
});

test("buildContinuation:maxEntries 截断取末段", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ type: "assistant", agent: "a", turn: i, text: `T${i}` }));
  const { seed } = buildContinuation({ flowName: "x", lastAgent: "omp", entries: many }, "q", { defaultAgent: "omp", maxEntries: 3 });
  assert.match(seed, /T99/); assert.match(seed, /T97/);
  assert.doesNotMatch(seed, /T96/);   // 只保留末 3 条
});

import test from "node:test";
import assert from "node:assert/strict";
import { makeCompleter } from "../src/ui/completer.mjs";

function smWith(labels) {
  return { _sessions: new Map(labels.map((l) => [l, {}])), currentLabel: labels[0] ?? null };
}

test("行首 / → 命令名候选", () => {
  const c = makeCompleter({ sm: smWith([]), config: {}, flows: [], backendNames: () => [] });
  const [hits, word] = c("/op");
  assert.ok(hits.includes("/open"));
  assert.equal(word, "/op");
});

test("/use <空> → 活跃会话 label;word 为空", () => {
  const c = makeCompleter({ sm: smWith(["omp#1", "codex#1"]), config: {}, flows: [], backendNames: () => [] });
  const [hits, word] = c("/use ");
  assert.deepEqual(hits.sort(), ["codex#1", "omp#1"]);
  assert.equal(word, "");
});

test("@ → @all + @label", () => {
  const c = makeCompleter({ sm: smWith(["omp#1"]), config: {}, flows: [], backendNames: () => [] });
  const [hits] = c("@");
  assert.ok(hits.includes("@all"));
  assert.ok(hits.includes("@omp#1"));
});

test("/open → +profile 与选项;--agent 后接 backend 名", () => {
  const c = makeCompleter({
    sm: smWith([]), config: { agents: { coder: {} } }, flows: [], backendNames: () => ["omp", "codex"],
  });
  const [h1] = c("/open ");
  assert.ok(h1.includes("+coder"));
  assert.ok(h1.includes("--agent"));
  const [h2, w2] = c("/open --agent co");
  assert.deepEqual(h2, ["codex"]);
  assert.equal(w2, "co");
});

test("/flow <部分> → flow 名", () => {
  const c = makeCompleter({ sm: smWith([]), config: {}, flows: [{ name: "qa-loop" }, { name: "hello" }], backendNames: () => [] });
  const [hits] = c("/flow h");
  assert.deepEqual(hits, ["hello"]);
});

test("/relay → from-> 候选;含 -> 后补 to", () => {
  const c = makeCompleter({ sm: smWith(["omp#1", "codex#1"]), config: {}, flows: [], backendNames: () => [] });
  const [h1] = c("/relay om");
  assert.ok(h1.includes("omp#1->"));
  const [h2] = c("/relay omp#1->co");
  assert.ok(h2.includes("omp#1->codex#1"));
});

test("/open --agent <尾空格> → 列全部 backend 名", () => {
  const c = makeCompleter({ sm: smWith([]), config: {}, flows: [], backendNames: () => ["omp", "codex"] });
  const [h, w] = c("/open --agent ");
  assert.deepEqual(h.sort(), ["codex", "omp"]);
  assert.equal(w, "");
});

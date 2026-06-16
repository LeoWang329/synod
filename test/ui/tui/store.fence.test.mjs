import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";

test("appendFence 向发起会话 entries 推 breadcrumb 条目(每命令一条)", () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  store.appendFence("omp#1", { commands: [
    { cmd: "/open --agent codex", result: "ok · session codex#1" },
    { cmd: "@codex#1 核对", result: "ok" },
  ], feedbackSent: true });
  const ent = store.getState().sessions["omp#1"].entries.filter((e) => e.type === "breadcrumb");
  assert.strictEqual(ent.length, 2);
  assert.strictEqual(ent[0].text, "开了 codex#1");
  assert.strictEqual(ent[1].text, "给 codex#1 派了活");
});

test("appendFence 对未 attach 的 label 不抛(无 entries 可推)", () => {
  const store = createStore();
  assert.doesNotThrow(() => store.appendFence("ghost", { commands: [{ cmd: "/open", result: "ok" }], feedbackSent: false }));
});

test("dropSession 移除会话与 order(不悬挂)", () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  assert.ok(store.getState().sessions["omp#1"]);
  store.dropSession("omp#1");
  assert.strictEqual(store.getState().sessions["omp#1"], undefined);
  assert.ok(!store.getState().order.includes("omp#1"));
});

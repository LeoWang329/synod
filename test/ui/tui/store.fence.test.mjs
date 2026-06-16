import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";

test("appendFence 累积 commands 跨两 turn + seen=false + feedbackSent", () => {
  const store = createStore();
  store.appendFence("omp#1", { commands: [{ cmd: "/open --agent codex", result: "ok · session codex#1" }], feedbackSent: true });
  store.appendFence("omp#1", { commands: [{ cmd: "@codex#1 hi", result: "ok" }], feedbackSent: true });
  const f = store.getState().fences["omp#1"];
  assert.strictEqual(f.commands.length, 2);
  assert.strictEqual(f.commands[0].cmd, "/open --agent codex");
  assert.strictEqual(f.commands[1].cmd, "@codex#1 hi");
  assert.strictEqual(f.seen, false);
  assert.strictEqual(f.feedbackSent, true);
});

test("appendFence trim 到 MAX_FENCE_CMDS=200(留最新)", () => {
  const store = createStore();
  for (let i = 0; i < 250; i++) store.appendFence("omp#1", { commands: [{ cmd: `c${i}`, result: "ok" }], feedbackSent: true });
  const f = store.getState().fences["omp#1"];
  assert.strictEqual(f.commands.length, 200);
  assert.strictEqual(f.commands[f.commands.length - 1].cmd, "c249");
});

test("markFenceSeen 置 seen=true + subscribe 收到通知", () => {
  const store = createStore();
  store.appendFence("omp#1", { commands: [{ cmd: "/open", result: "ok" }], feedbackSent: true });
  let hits = 0; store.subscribe(() => hits++);
  store.markFenceSeen("omp#1");
  assert.strictEqual(store.getState().fences["omp#1"].seen, true);
  assert.ok(hits >= 1);
});

test("markFenceSeen 对不存在的 label 不抛", () => {
  const store = createStore();
  assert.doesNotThrow(() => store.markFenceSeen("nope"));
});

test("dropSession 清除 fences[label](不悬挂)", () => {
  const store = createStore();
  store.attachSession("omp#1", new EventEmitter(), "omp", {});
  store.appendFence("omp#1", { commands: [{ cmd: "/open", result: "ok" }], feedbackSent: true });
  assert.ok(store.getState().fences["omp#1"]);
  store.dropSession("omp#1");
  assert.strictEqual(store.getState().fences["omp#1"], undefined);
});

import { EventEmitter as EE2 } from "node:events";
test("appendFence 向发起会话 entries 推 breadcrumb 条目(每命令一条)", () => {
  const store = createStore();
  store.attachSession("omp#1", new EE2(), "omp", {});
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

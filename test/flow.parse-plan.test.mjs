import { describe, it } from "node:test";
import assert from "node:assert";
import { parsePlan } from "../workflows/superpowers/execute-plan.mjs";

describe("parsePlan", () => {
  it("解析多个 Task 段", () => {
    const text = [
      "# Plan", "intro",
      "### Task 1: 加 foo", "实现 foo 返回 42", "",
      "### Task 2: 加 bar", "实现 bar 返回 7",
    ].join("\n");
    const tasks = parsePlan(text);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, "1");
    assert.equal(tasks[0].title, "加 foo");
    assert.match(tasks[0].body, /返回 42/);
    assert.equal(tasks[1].title, "加 bar");
  });

  it("兼容 ## 段头", () => {
    const tasks = parsePlan("## Task 1: only\nbody");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "only");
  });

  it("无 Task 头 → []", () => {
    assert.deepEqual(parsePlan("# 没有任务\n随便写"), []);
  });

  it("空/非串输入 → []", () => {
    assert.deepEqual(parsePlan(""), []);
    assert.deepEqual(parsePlan(null), []);
    assert.deepEqual(parsePlan(undefined), []);
  });
});

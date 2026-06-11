import test from "node:test";
import assert from "node:assert/strict";
import { renderPrompt } from "../src/ui/prompt.mjs";
import { stripAnsi } from "../src/ui/ansi.mjs";

function fakeSm(rows, current) {
  return {
    _sessions: new Map(rows.map(([l, status]) => [l, { session: { status } }])),
    currentLabel: current,
  };
}

test("非 TTY → 恒为 '> '(不破 e2e 探测)", () => {
  const sm = fakeSm([["omp#1", "idle"]], "omp#1");
  assert.equal(renderPrompt({ sm, stdout: { isTTY: false }, env: {} }), "> ");
  assert.equal(renderPrompt({ sm, stdout: {}, env: {} }), "> ");
});

test("TTY 无会话 → synod ❯", () => {
  const sm = fakeSm([], null);
  assert.equal(stripAnsi(renderPrompt({ sm, stdout: { isTTY: true }, env: {} })), "synod ❯ ");
});

test("TTY 当前空闲 → [omp#1] ❯", () => {
  const sm = fakeSm([["omp#1", "idle"]], "omp#1");
  assert.equal(stripAnsi(renderPrompt({ sm, stdout: { isTTY: true }, env: {} })), "[omp#1] ❯ ");
});

test("TTY 当前忙 + 另有 2 个在跑 → 计数徽标(§1)", () => {
  const sm = fakeSm([["omp#1", "running"], ["omp#2", "running"], ["codex#1", "running"]], "omp#1");
  assert.equal(stripAnsi(renderPrompt({ sm, stdout: { isTTY: true }, env: {} })), "[omp#1 ⠧ 2 running] ❯ ");
});

test("TTY 但 NO_COLOR → 徽标无色仍显示", () => {
  const sm = fakeSm([["omp#1", "idle"]], "omp#1");
  const p = renderPrompt({ sm, stdout: { isTTY: true }, env: { NO_COLOR: "1" } });
  assert.equal(p, "[omp#1] ❯ ");
  assert.ok(!/\x1b/.test(p));
});

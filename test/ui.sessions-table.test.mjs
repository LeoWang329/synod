import test from "node:test";
import assert from "node:assert/strict";
import { renderSessionsTable } from "../src/ui/sessions-table.mjs";
import { stripAnsi } from "../src/ui/ansi.mjs";
import { createSessionManager } from "../src/session-manager.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

test("表格:列头齐全、* 标当前、RELAY 列出/入边、空 model → (default)", () => {
  const t = renderSessionsTable({
    sessions: [
      { label: "omp#1", agent: "omp", model: "ds-v4", status: "idle", turns: 4 },
      { label: "codex#1", agent: "codex", model: "", status: "running", turns: 3 },
    ],
    currentLabel: "omp#1",
    relays: [{ from: "omp#1", to: "codex#1" }],
  });
  assert.match(t, /LABEL\s+BACKEND\s+MODEL\s+STATE\s+TURNS\s+RELAY/);
  const lines = t.split("\n");
  // 用 label 出现在行首(位置列)的 regex 定位,避免 RELAY 列的引用干扰
  const ompRow = lines.find((l) => /^\s*\*\s+omp#1/.test(l));
  assert.match(ompRow, /^\s*\*\s+omp#1/, "当前会话以 * 标注");
  assert.match(ompRow, /→ codex#1/, "出边");
  const codexRow = lines.find((l) => /^\s+codex#1/.test(l));
  assert.match(codexRow, /← omp#1/, "入边");
  assert.match(codexRow, /\(default\)/, "空 model 显示 (default)");
});

test("colorOn → label 着色,strip 后等于无色表格", () => {
  const args = {
    sessions: [{ label: "omp#1", agent: "omp", model: "m", status: "idle", turns: 1 }],
    currentLabel: "omp#1", relays: [],
  };
  const plain = renderSessionsTable({ ...args, colorOn: false });
  const colored = renderSessionsTable({ ...args, colorOn: true });
  assert.ok(/\x1b\[/.test(colored));
  assert.equal(stripAnsi(colored), plain);
});

test("sm.list() 渲染表格 + relay 列(经注入的 relays())", async () => {
  const lines = [];
  const sm = createSessionManager({
    openBackend: async () => new FakeSession({}),
    stdout: { write: (s) => lines.push(s) }, stderr: { write() {} },
    report: { omp: { available: true } }, cwd: process.cwd(),
    defaults: {}, onIdle: () => {},
    relays: () => [{ from: "omp#1", to: "omp#2" }],
  });
  await sm.open({ agent: "omp" });
  await sm.open({ agent: "omp" });
  sm.list();
  const out = lines.join("");
  assert.match(out, /LABEL\s+BACKEND/);
  assert.match(out, /→ omp#2/);
});

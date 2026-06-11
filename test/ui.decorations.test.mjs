import test from "node:test";
import assert from "node:assert/strict";
import { turnBoundary, relayBanner } from "../src/ui/decorations.mjs";
import { stripAnsi } from "../src/ui/ansi.mjs";
import { createRelayRegistry } from "../src/relay.mjs";
import { createSessionManager } from "../src/session-manager.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

test("turnBoundary:[label] ── done · Xs ── 形态 + 着色,strip 后纯文本", () => {
  const s = turnBoundary("omp#1", "12.3");
  assert.ok(/\x1b\[/.test(s), "TTY 渲染含 ANSI");
  assert.equal(stripAnsi(s), "[omp#1] ── done · 12.3s ──────────\n");
});

test("relayBanner:[to] ◀─ relay from <from> (Nk chars) + 着色", () => {
  assert.equal(stripAnsi(relayBanner("codex#1", "omp#1", 1234)), "[codex#1] ◀─ relay from omp#1 (1.2k chars)\n");
  assert.equal(stripAnsi(relayBanner("codex#1", "omp#1", 42)), "[codex#1] ◀─ relay from omp#1 (42 chars)\n");
});

test("relay.onTurnComplete 透传 {from,chars} meta 给 enqueue 回调(§2.3)", () => {
  const calls = [];
  const reg = createRelayRegistry((to, msg, meta) => calls.push({ to, msg, meta }));
  reg.add("omp#1", "codex#1");
  reg.onTurnComplete("omp#1", "hello world");
  assert.equal(calls[0].to, "codex#1");
  assert.match(calls[0].msg, /\[relay from omp#1\]/);
  assert.deepEqual(calls[0].meta, { from: "omp#1", chars: 11 });
});

test("session-manager:TTY turn 完成写边界线;非 TTY 无", async () => {
  async function run(isTTY) {
    const lines = [];
    const sm = createSessionManager({
      openBackend: async () => new FakeSession({ deltas: ["x\n"] }),
      stdout: { isTTY, write: (s) => lines.push(s) }, stderr: { write() {} },
      report: { omp: { available: true } }, cwd: process.cwd(),
      defaults: {}, onIdle: () => {},
    });
    const label = await sm.open({ agent: "omp" });
    await sm.enqueue({ target: label, msg: "go" });
    await sm.drainAll(); sm.flushAll(); sm.closeAll();
    return lines.join("");
  }
  assert.match(await run(true), /── done · [\d.]+s ──/);
  assert.doesNotMatch(await run(false), /── done ·/);
});

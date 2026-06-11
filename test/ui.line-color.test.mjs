// test/ui.line-color.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createLineBuffer, createSessionManager } from "../src/session-manager.mjs";
import { color, labelColor, stripAnsi } from "../src/ui/ansi.mjs";
import { FakeSession } from "./helpers/fake-backend.mjs";

test("createLineBuffer:colorize 着色 [label] 前缀,strip 后逐字节等于纯文本", () => {
  const lines = [];
  const stdout = { write: (s) => lines.push(s) };
  const colorize = (s) => color(labelColor("omp#1"), s);
  const buf = createLineBuffer("omp#1", stdout, { colorize });
  buf.feed("hello\n");
  assert.equal(lines.length, 1);
  assert.notEqual(lines[0], "[omp#1] hello\n", "TTY 路径含 ANSI");
  assert.equal(stripAnsi(lines[0]), "[omp#1] hello\n", "strip 后等于纯文本路径");
});

test("createLineBuffer:无 colorize → 纯文本(非 TTY 零 ANSI,现状不变)", () => {
  const lines = [];
  const stdout = { write: (s) => lines.push(s) };
  const buf = createLineBuffer("omp#1", stdout);
  buf.feed("hi\n");
  buf.flush();
  assert.deepEqual(lines, ["[omp#1] hi\n"]);
});

test("createSessionManager:stdout.isTTY → delta 行着色;非 TTY → 零 ANSI", async () => {
  async function run(isTTY) {
    const lines = [];
    const stdout = { isTTY, write: (s) => lines.push(s) };
    const sm = createSessionManager({
      openBackend: async () => new FakeSession({ deltas: ["yo\n"] }),
      stdout, stderr: { write() {} }, report: { omp: { available: true } },
      cwd: process.cwd(), defaults: {}, onIdle: () => {},
    });
    const label = await sm.open({ agent: "omp" });
    await sm.enqueue({ target: label, msg: "go" });
    await sm.drainAll(); sm.flushAll(); sm.closeAll();
    return lines.join("").split("\n").find((l) => l.includes("yo")) ?? "";
  }
  const tty = await run(true);
  const plain = await run(false);
  assert.ok(/\x1b\[/.test(tty), "TTY 的 delta 行含 ANSI");
  assert.ok(!/\x1b\[/.test(plain), "非 TTY 的 delta 行零 ANSI");
  assert.equal(stripAnsi(tty), plain, "strip(TTY delta 行)=非 TTY delta 行");
});

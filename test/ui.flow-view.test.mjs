import test from "node:test";
import assert from "node:assert/strict";
import { createFlowView } from "../src/ui/flow-view.mjs";
import { stripAnsi } from "../src/ui/ansi.mjs";

function cap(isTTY = false) {
  let buf = "";
  return { write(s) { buf += s; }, isTTY, get out() { return buf; } };
}

test("banner + result:头尾横幅 + 结果 JSON + turns/sessions/耗时", () => {
  let t = 0;
  const stdout = cap(true);
  const view = createFlowView({ stdout, name: "qa-loop", clock: () => (t += 1000), env: {} });
  view.banner();
  const sink = view.countingSink({ emit() {} });
  sink.emit({ type: "opening" });
  sink.emit({ type: "start" });
  sink.emit({ type: "start" });
  view.result({ passed: true });
  const out = stripAnsi(stdout.out);
  assert.match(out, /── flow qa-loop ─+/);
  assert.match(out, /── result ─+/);
  assert.match(out, /"passed": true/);
  assert.match(out, /── done · 2 turns · 1 sessions · [\d.]+s ─+/);
});

test("countingSink 透传内层 sink", () => {
  const seen = [];
  const view = createFlowView({ stdout: cap(), name: "x", clock: () => 0, env: {} });
  const sink = view.countingSink({ emit: (e) => seen.push(e.type) });
  sink.emit({ type: "delta", text: "hi" });
  assert.deepEqual(seen, ["delta"]);
});

test("非 TTY:横幅无 ANSI(降级);result 仍打 JSON", () => {
  const stdout = cap(false);
  const view = createFlowView({ stdout, name: "x", clock: () => 0, env: {} });
  view.banner();
  view.result({ ok: 1 });
  assert.ok(!/\x1b\[/.test(stdout.out));
  assert.match(stdout.out, /"ok": 1/);
});

test("TTY:横幅着色", () => {
  const stdout = cap(true);
  const view = createFlowView({ stdout, name: "x", clock: () => 0, env: {} });
  view.banner();
  assert.ok(/\x1b\[/.test(stdout.out));
});

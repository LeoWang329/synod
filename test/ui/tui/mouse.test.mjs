import { test } from "node:test";
import assert from "node:assert";
import { drainMouse, RegionRegistry, MOUSE_ON, MOUSE_OFF, isLeftClick } from "../../../src/ui/tui/mouse.mjs";

test("drainMouse 提取一个事件;尾随普通文本(非鼠标)被丢弃,rest 空", () => {
  const { events, rest } = drainMouse("\x1b[<0;12;5Mxyz");
  assert.deepStrictEqual(events, [{ x: 12, y: 5, button: 0, press: true, motion: false, wheel: 0 }]);
  assert.strictEqual(rest, "");   // "xyz" 是普通键盘字节,由 Ink 处理,鼠标 drainer 丢弃
});
test("drainMouse 一次提取多个事件,rest 空", () => {
  const { events, rest } = drainMouse("\x1b[<0;1;1M\x1b[<0;2;2m");
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[1].press, false);
  assert.strictEqual(rest, "");
});
test("drainMouse 完整事件 + 末尾不完整 ESC 片段:保留该片段待下次拼接", () => {
  const { events, rest } = drainMouse("\x1b[<0;1;1M\x1b[<0;12");
  assert.strictEqual(events.length, 1);
  assert.strictEqual(rest, "\x1b[<0;12");
});
test("drainMouse 纯不完整序列:整段留存", () => {
  const { events, rest } = drainMouse("\x1b[<0;12");
  assert.deepStrictEqual(events, []);
  assert.strictEqual(rest, "\x1b[<0;12");
});
test("滚轮(button 64)→ wheel:-1;motion(bit32)→ motion:true", () => {
  assert.strictEqual(drainMouse("\x1b[<64;1;1M").events[0].wheel, -1);
  assert.strictEqual(drainMouse("\x1b[<35;1;1M").events[0].motion, true);
});
test("isLeftClick:只认左键 press、非 motion、非 wheel", () => {
  assert.strictEqual(isLeftClick({ button: 0, press: true, motion: false, wheel: 0 }), true);
  assert.strictEqual(isLeftClick({ button: 0, press: false, motion: false, wheel: 0 }), false);
  assert.strictEqual(isLeftClick({ button: 0, press: true, motion: true, wheel: 0 }), false);
  assert.strictEqual(isLeftClick({ button: 64, press: true, motion: false, wheel: -1 }), false);
});
test("RegionRegistry 命中(1-based 坐标,左闭右开)", () => {
  const r = new RegionRegistry();
  r.set("agent:omp#1", { x: 71, y: 2, w: 30, h: 5 });
  assert.strictEqual(r.hit(72, 3), "agent:omp#1");
  assert.strictEqual(r.hit(71, 2), "agent:omp#1");
  assert.strictEqual(r.hit(101, 3), null);
  assert.strictEqual(r.hit(72, 7), null);
});
test("MOUSE_ON 只含 1000+1006(不含 1002),MOUSE_OFF 关之", () => {
  assert.ok(MOUSE_ON.includes("1000") && MOUSE_ON.includes("1006") && !MOUSE_ON.includes("1002"));
  assert.ok(MOUSE_OFF.includes("1006"));
});

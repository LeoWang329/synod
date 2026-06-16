import { test } from "node:test";
import assert from "node:assert";
import { drainMouse, createStdinSplitter, RegionRegistry, MOUSE_ON, MOUSE_OFF, isLeftClick } from "../../../src/ui/tui/mouse.mjs";

test("drainMouse 提取一个事件;尾随普通文本(非鼠标)经 passthrough 透传给 Ink,rest 空", () => {
  const { events, rest, passthrough } = drainMouse("\x1b[<0;12;5Mxyz");
  assert.deepStrictEqual(events, [{ x: 12, y: 5, button: 0, press: true, motion: false, wheel: 0 }]);
  assert.strictEqual(passthrough, "xyz");   // "xyz" 是普通键盘字节 → 透传给 Ink(不再被丢弃)
  assert.strictEqual(rest, "");
});
test("drainMouse passthrough:键盘字节夹在鼠标事件之间也按序透传,鼠标被剥离", () => {
  const { events, rest, passthrough } = drainMouse("a\x1b[<0;1;1Mb\x1b[<0;2;2mc");
  assert.strictEqual(events.length, 2);
  assert.strictEqual(passthrough, "abc");   // 鼠标序列剥离,键盘字节按原序拼回
  assert.strictEqual(rest, "");
});
test("drainMouse passthrough:方向键等非鼠标转义整体透传(不被当作鼠标残段吞掉)", () => {
  const { events, rest, passthrough } = drainMouse("\x1b[A");
  assert.deepStrictEqual(events, []);
  assert.strictEqual(passthrough, "\x1b[A");   // 关键:之前 lastIndexOf-ESC 逻辑会把它误吞进 rest
  assert.strictEqual(rest, "");
});
test("drainMouse passthrough:方向键 + 末尾残缺鼠标前缀 → 方向键透传,仅鼠标前缀留 rest", () => {
  const { passthrough, rest } = drainMouse("\x1b[A\x1b[<0;1");
  assert.strictEqual(passthrough, "\x1b[A");
  assert.strictEqual(rest, "\x1b[<0;1");
});
test("drainMouse passthrough:末尾残缺鼠标前缀不透传(留 rest 待下次拼接),其余透传", () => {
  const { passthrough, rest } = drainMouse("x\x1b[<0;1");
  assert.strictEqual(passthrough, "x");
  assert.strictEqual(rest, "\x1b[<0;1");
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
test("createStdinSplitter:跨块重组——残缺鼠标前缀在下块补全为事件,不污染 passthrough", () => {
  const split = createStdinSplitter();
  const r1 = split("a\x1b[<0;3");
  assert.strictEqual(r1.passthrough, "a");
  assert.strictEqual(r1.events.length, 0);
  const r2 = split(";4M");
  assert.strictEqual(r2.events.length, 1);
  assert.deepStrictEqual(r2.events[0], { x: 3, y: 4, button: 0, press: true, motion: false, wheel: 0 });
  assert.strictEqual(r2.passthrough, "");   // 鼠标事件被剥离,不漏入 passthrough
});
test("createStdinSplitter:残缺前缀下块解析为普通键(\\x1b[ → \\x1b[A)→ 整体透传一次", () => {
  const split = createStdinSplitter();
  assert.strictEqual(split("\x1b[").passthrough, "");        // 暂存为残段
  assert.strictEqual(split("A").passthrough, "\x1b[A");      // 解析为键盘 → 透传恰好一次
});
test("createStdinSplitter:超长残段防御——丢弃,不无限增长 mbuf", () => {
  const split = createStdinSplitter();
  // 一个以 ESC 开头、看似鼠标前缀但异常超长(>=64)的残段被丢弃。
  const junk = "\x1b[<" + "9".repeat(80);
  const r = split(junk);
  assert.strictEqual(r.events.length, 0);
  // 下一次普通输入不应被前面的超长残段污染。
  assert.strictEqual(split("hi").passthrough, "hi");
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

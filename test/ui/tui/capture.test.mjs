import { test } from "node:test";
import assert from "node:assert";
import { makeCaptureStream } from "../../../src/ui/tui/capture.mjs";

test("按换行切分,整行回调,残段留存", () => {
  const lines = [];
  const s = makeCaptureStream((line) => lines.push(line));
  s.write("Relay added: a->b\n");
  s.write("No session ");
  s.write("\"x\"\nmore");
  assert.deepStrictEqual(lines, ['Relay added: a->b', 'No session "x"']);
});

test("有 write 方法且返回 true(满足 Writable 鸭子类型)", () => {
  const s = makeCaptureStream(() => {});
  assert.strictEqual(typeof s.write, "function");
  assert.strictEqual(s.write("x\n"), true);
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { createLineBuffer } from "../src/cli.mjs";

function captureOutput(fn) {
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { lines.push(s); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return lines;
}

describe("createLineBuffer", () => {
  it("feed chunks without newline → no output; newline → complete line with [label]", () => {
    const buf = createLineBuffer("test");
    const captured = captureOutput(() => {
      buf.feed("hello ");
      buf.feed("world");
    });
    assert.deepStrictEqual(captured, [], "no output before newline");

    const captured2 = captureOutput(() => {
      buf.feed("!\n");
    });
    assert.deepStrictEqual(captured2, ["[test] hello world!\n"]);
  });

  it("flush() emits remaining buffered text", () => {
    const buf = createLineBuffer("test");
    const captured = captureOutput(() => {
      buf.feed("partial");
    });
    assert.deepStrictEqual(captured, []);

    const captured2 = captureOutput(() => {
      buf.flush();
    });
    assert.deepStrictEqual(captured2, ["[test] partial\n"]);
  });

  it("two buffers interleaved: each output line has exactly ONE [label] prefix, no mixing", () => {
    const bufA = createLineBuffer("A");
    const bufB = createLineBuffer("B");
    const captured = captureOutput(() => {
      bufA.feed("alpha\n");
      bufB.feed("beta\n");
      bufA.feed("gamma\n");
      bufB.feed("delta\n");
    });

    assert.strictEqual(captured.length, 4);
    for (const line of captured) {
      const match = line.match(/^\[([^\]]+)\]/);
      assert.ok(match, `line should have [label]: ${JSON.stringify(line)}`);
      const label = match[1];
      assert.ok(label === "A" || label === "B", `label should be A or B, got: ${label}`);
      // Verify exactly one [label] prefix
      const bracketCount = (line.match(/\[/g) || []).length;
      assert.strictEqual(bracketCount, 1, `line should have exactly one '[': ${JSON.stringify(line)}`);
    }
  });

  it("empty feed then flush → no output", () => {
    const buf = createLineBuffer("test");
    const captured = captureOutput(() => {
      buf.flush();
    });
    assert.deepStrictEqual(captured, []);
  });

  it("multiple newlines in one chunk → multiple lines emitted", () => {
    const buf = createLineBuffer("test");
    const captured = captureOutput(() => {
      buf.feed("line1\nline2\nline3\n");
    });

    assert.strictEqual(captured.length, 3);
    assert.deepStrictEqual(captured, [
      "[test] line1\n",
      "[test] line2\n",
      "[test] line3\n",
    ]);
  });
});

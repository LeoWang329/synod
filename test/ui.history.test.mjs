import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistory, appendHistory, historyPath } from "../src/ui/history.mjs";

test("historyPath:<home>/.synod/history", () => {
  assert.equal(historyPath("/h"), join("/h", ".synod", "history"));
});

test("loadHistory:缺文件→空;读取 newest-first 且封顶", () => {
  const f = join(mkdtempSync(join(tmpdir(), "synod-hist-")), "history");
  assert.deepEqual(loadHistory(f, 1000), []);
  writeFileSync(f, "one\ntwo\nthree\n");
  assert.deepEqual(loadHistory(f, 1000), ["three", "two", "one"]);
  assert.deepEqual(loadHistory(f, 2), ["three", "two"]);
});

test("appendHistory:追加非空行、自动建目录、忽略空白", () => {
  const f = join(mkdtempSync(join(tmpdir(), "synod-hist-")), "sub", "history");
  appendHistory(f, "hello");
  appendHistory(f, "   ");
  appendHistory(f, "world");
  assert.equal(readFileSync(f, "utf8"), "hello\nworld\n");
});

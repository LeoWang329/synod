import { test } from "node:test";
import assert from "node:assert";
import { computeHints, applyHint } from "../../../src/ui/tui/hints.mjs";
const ctx = { labels: () => ["omp#1", "codex#1"], flows: ["qa-loop"], backends: () => ["omp", "codex"], profiles: () => ["rev"] };

test("行首 / 列出斜杠命令", () => { const h = computeHints("/", ctx); assert.strictEqual(h.kind, "slash"); assert.ok(h.items.some((i) => i.value === "/open")); });
test("/op 前缀过滤", () => { assert.deepStrictEqual(computeHints("/op", ctx).items.map((i) => i.value), ["/open"]); });
test("/zz 非匹配前缀返回空候选(不倒出全表)", () => { const h = computeHints("/zz", ctx); assert.strictEqual(h.kind, "slash"); assert.deepStrictEqual(h.items, []); });
test("/use 后补全 label", () => { assert.deepStrictEqual(computeHints("/use ", ctx).items.map((i) => i.value), ["omp#1", "codex#1"]); });
test("@ 列出 @all + 各 label", () => { assert.deepStrictEqual(computeHints("@", ctx).items.map((i) => i.value), ["@all", "@omp#1", "@codex#1"]); });
test("$ 识别为 shell 前缀但本期无候选(不报错)", () => { const h = computeHints("$ ", ctx); assert.strictEqual(h.kind, "shell"); assert.deepStrictEqual(h.items, []); });
test("普通文本无提示", () => { const h = computeHints("hello", ctx); assert.strictEqual(h.kind, "none"); assert.deepStrictEqual(h.items, []); });

test("applyHint:slash 整行替换并补空格", () => { assert.strictEqual(applyHint("/op", "/open"), "/open "); });
test("applyHint:替换行尾 token(保留前缀)", () => { assert.strictEqual(applyHint("/use omp#", "omp#1"), "/use omp#1 "); });
test("applyHint:@ 单 token", () => { assert.strictEqual(applyHint("@al", "@all"), "@all "); });
test("applyHint:relay 中间态 -> 结尾不补空格", () => { assert.strictEqual(applyHint("/relay om", "omp#1->"), "/relay omp#1->"); });
test("applyHint:行尾已是空格 → 末 token 为空,直接接 value", () => { assert.strictEqual(applyHint("/use ", "omp#1"), "/use omp#1 "); });

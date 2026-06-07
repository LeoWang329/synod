import { describe, it } from "node:test";
import assert from "node:assert";
import { parseRelay } from "../src/relay.mjs";

describe("parseRelay", () => {
  it("parses bare omp->codex", () => {
    assert.deepStrictEqual(parseRelay("omp->codex"), { from: "omp", to: "codex" });
  });

  it("parses with /relay prefix", () => {
    assert.deepStrictEqual(parseRelay("/relay omp->codex"), { from: "omp", to: "codex" });
  });

  it("trims whitespace around parts", () => {
    assert.deepStrictEqual(parseRelay("  omp -> codex  "), { from: "omp", to: "codex" });
    assert.deepStrictEqual(parseRelay("/relay  omp#1 -> codex#2 "), { from: "omp#1", to: "codex#2" });
  });

  it("rejects missing ->", () => {
    const r = parseRelay("omp codex");
    assert.ok(r.error, "should have error");
    assert.ok(r.error.includes("->"), "error should mention ->");
  });

  it("rejects empty source (->codex)", () => {
    const r = parseRelay("->codex");
    assert.ok(r.error, "should have error");
  });

  it("rejects empty target (omp->)", () => {
    const r = parseRelay("omp->");
    assert.ok(r.error, "should have error");
  });

  it("rejects self-reference (omp->omp)", () => {
    const r = parseRelay("omp->omp");
    assert.ok(r.error, "should have error");
    assert.ok(r.error.includes("differ"), "error should mention must differ");
  });

  it("rejects empty input", () => {
    const r = parseRelay("");
    assert.ok(r.error, "should have error");
  });

  it("rejects whitespace-only input", () => {
    const r = parseRelay("   ");
    assert.ok(r.error, "should have error");
  });

  it("parses labels with hyphens and hashes", () => {
    assert.deepStrictEqual(parseRelay("omp#1->codex#2"), { from: "omp#1", to: "codex#2" });
    assert.deepStrictEqual(parseRelay("a-b->c-d"), { from: "a-b", to: "c-d" });
  });
});

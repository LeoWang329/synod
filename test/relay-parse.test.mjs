import { describe, it } from "node:test";
import assert from "node:assert";
import { parseRelay, parseForward } from "../src/relay.mjs";

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

describe("parseForward", () => {
  it("parses from->to with no note", () => {
    assert.deepStrictEqual(parseForward("omp#1->codex#1"), { from: "omp#1", to: "codex#1", note: "" });
  });

  it("parses with /forward prefix", () => {
    assert.deepStrictEqual(parseForward("/forward omp#1->codex#1"), { from: "omp#1", to: "codex#1", note: "" });
  });

  it("captures a note after the target, preserving internal spacing", () => {
    assert.deepStrictEqual(
      parseForward("/forward omp#1->codex#1 review for security bugs"),
      { from: "omp#1", to: "codex#1", note: "review for security bugs" },
    );
  });

  it("tolerates spaces around -> and trims the note", () => {
    assert.deepStrictEqual(
      parseForward("/forward  omp#1 -> codex#1   只看安全  "),
      { from: "omp#1", to: "codex#1", note: "只看安全" },
    );
  });

  it("note keeps inner punctuation/spacing verbatim (only outer trim)", () => {
    assert.deepStrictEqual(
      parseForward("/forward a->b  翻译成 Python,保留注释 "),
      { from: "a", to: "b", note: "翻译成 Python,保留注释" },
    );
  });

  it("rejects missing ->", () => {
    const r = parseForward("/forward omp#1 codex#1");
    assert.ok(r.error && r.error.includes("->"));
  });

  it("rejects empty source", () => {
    assert.ok(parseForward("/forward ->codex#1").error);
  });

  it("rejects empty target (no label before the note)", () => {
    assert.ok(parseForward("/forward omp#1->").error);
  });

  it("rejects self-forward", () => {
    const r = parseForward("/forward omp#1->omp#1 note");
    assert.ok(r.error && r.error.includes("differ"));
  });
});

// synod/test/control-fence.test.mjs — Tests for extractFenceCommands.
//
// Covers:
// 1. Return type (Array.isArray, each element string)
// 2. Happy path: /open, @, /relay → lands in lines, deduplicated, ordered
// 3. False-positive defense (four-prong):
//    a. Prose mentioning "synod" → zero lines
//    b. Non-column-0 (leading space) control fence → zero lines
//    c. Inside outer regular fence → outer priority → zero lines
//    d. R1 killer: body first line is prose/comment → zero lines + warning
// 4. Info string: "synod" matches, "  synod " matches, "synod x" / "synodx" don't
// 5. First-line gate: leading-space / or @ → R1 fail + warning
// 6. CommonMark behaviors (parity with control-marker):
//    - 4-backtick outer contains 3-backtick → not closer (length tracking)
//    - Tilde not control
//    - Column-0 required for control
//    - Indented outer (0-3 space) takes priority
//    - Unclosed control fence → empty
//    - BOM / CRLF normalization
//    - Empty text → empty
//    - Two control fences → both processed, ordered
//    - Empty body lines skipped
// 7. Partial delta alone → empty (only complete turn text)

import { describe, it } from "node:test";
import assert from "node:assert";
import { extractFenceCommands } from "../src/control-fence.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────

function extract(text) {
  return extractFenceCommands(text);
}

// ── Return type ──────────────────────────────────────────────────────────

describe("extractFenceCommands return type", () => {
  it("returns object with lines array and warnings array", () => {
    const r = extract("```synod\n/open --agent omp\n```");
    assert.ok(Array.isArray(r.lines), "lines must be an array");
    for (const line of r.lines) {
      assert.strictEqual(typeof line, "string", `line must be string, got ${typeof line}: ${line}`);
    }
    assert.ok(Array.isArray(r.warnings), "warnings must be an array");
  });

  it("empty input → empty lines, empty warnings", () => {
    const r = extract("");
    assert.deepStrictEqual(r.lines, []);
    assert.deepStrictEqual(r.warnings, []);
  });

  it("no fence → empty lines", () => {
    const r = extract("hello world\nno fence here");
    assert.deepStrictEqual(r.lines, []);
    assert.deepStrictEqual(r.warnings, []);
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe("extractFenceCommands happy path", () => {
  it("single /open command", () => {
    const r = extract("```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
    assert.deepStrictEqual(r.warnings, []);
  });

  it("multiple commands in order", () => {
    const r = extract("```synod\n/open --agent omp\n@codex#1 hello\n/relay a->b\n```");
    assert.deepStrictEqual(r.lines, [
      "/open --agent omp",
      "@codex#1 hello",
      "/relay a->b",
    ]);
    assert.deepStrictEqual(r.warnings, []);
  });

  it("duplicate lines are deduplicated (preserving first occurrence order)", () => {
    const r = extract("```synod\n/open --agent omp\n@codex#1 hello\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, [
      "/open --agent omp",
      "@codex#1 hello",
    ]);
  });

  it("lines are trimmed (first line col-0, subsequent may have leading whitespace)", () => {
    const r = extract("```synod\n/open --agent omp  \n  @codex#1 hello \n```");
    assert.deepStrictEqual(r.lines, [
      "/open --agent omp",
      "@codex#1 hello",
    ]);
  });

  it("empty body lines are skipped", () => {
    const r = extract("```synod\n/open --agent omp\n\n@codex#1 hello\n\n```");
    assert.deepStrictEqual(r.lines, [
      "/open --agent omp",
      "@codex#1 hello",
    ]);
  });

  it("@ command works", () => {
    const r = extract("```synod\n@omp#1 hi there\n```");
    assert.deepStrictEqual(r.lines, ["@omp#1 hi there"]);
  });

  it("/ command works", () => {
    const r = extract("```synod\n/relay a->b\n```");
    assert.deepStrictEqual(r.lines, ["/relay a->b"]);
  });
});

// ── False-positive defense (四连) ────────────────────────────────────────

describe("FP#1: bare prose mentioning synod", () => {
  it("prose line 'synod' alone → no fence, no lines", () => {
    const r = extract("synod");
    assert.deepStrictEqual(r.lines, []);
  });

  it("prose with 'synod' in sentence → no lines", () => {
    const r = extract("We discussed synod protocol yesterday.");
    assert.deepStrictEqual(r.lines, []);
  });

  it("@@synod bare line → no lines (dead form)", () => {
    const r = extract("@@synod /open --agent omp");
    assert.deepStrictEqual(r.lines, []);
  });
});

describe("FP#2: non-column-0 control fence", () => {
  it("leading space before ```synod → not a control fence", () => {
    const r = extract(" ```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("two leading spaces → not a control fence", () => {
    const r = extract("  ```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("three leading spaces → not a control fence", () => {
    const r = extract("   ```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });
});

describe("FP#3: control fence inside outer regular fence", () => {
  it("inside ```text outer fence → zero lines", () => {
    const r = extract("```text\n```synod\n/open --agent omp\n```\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("inside ~~~ outer fence → zero lines", () => {
    const r = extract("~~~\n```synod\n/open --agent omp\n```\n~~~");
    assert.deepStrictEqual(r.lines, []);
  });

  it("inside ```json outer fence → zero lines", () => {
    const r = extract("```json\n```synod\n/open --agent omp\n```\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("control fence outside regular fence → still recognized", () => {
    const r = extract("```synod\n/open --agent omp\n```\n```text\nsome code\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });
});

describe("FP#4: R1 killer — body first line is prose/comment", () => {
  it("body first line starts with # (comment) → zero lines + warning", () => {
    const r = extract("```synod\n# This is an example usage:\n/open --agent omp\n@codex#1 hi\n```");
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.warnings.length, 1);
    assert.ok(r.warnings[0].reason.includes("首行"), "warning should mention first line");
    assert.ok(r.warnings[0].reason.includes("顶格命令"), "warning should mention column-0 command");
  });

  it("body first line is Chinese prose → zero lines + warning", () => {
    const r = extract("```synod\n这样使用：\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.warnings.length, 1);
  });

  it("body first line is English prose → zero lines + warning", () => {
    const r = extract("```synod\nTo open a session: /open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.warnings.length, 1);
  });

  it("R1 gate uses original line (not trimmed) — leading space / fails", () => {
    const r = extract("```synod\n /open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.warnings.length, 1);
    assert.ok(r.warnings[0].reason.includes("首行"), "leading-space / should fail R1");
  });

  it("R1 gate uses original line — leading space @ fails", () => {
    const r = extract("```synod\n @omp#1 hello\n```");
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.warnings.length, 1);
  });

  it("R1 gate passes — first line starts with /", () => {
    const r = extract("```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
    assert.deepStrictEqual(r.warnings, []);
  });

  it("R1 gate passes — first line starts with @", () => {
    const r = extract("```synod\n@codex#1 hello\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["@codex#1 hello", "/open --agent omp"]);
  });
});

// ── Info string matching ─────────────────────────────────────────────────

describe("info string matching", () => {
  it("exactly 'synod' matches", () => {
    const r = extract("```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("'  synod  ' (trailing whitespace in info) matches", () => {
    const r = extract("```  synod  \n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("'synod <nonce>' (nonce residue) does NOT match", () => {
    const r = extract("```synod abc-123\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("'synodx' does NOT match (no space, wrong word)", () => {
    const r = extract("```synodx\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("'mysynod' does NOT match", () => {
    const r = extract("```mysynod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });
});

// ── CommonMark fence behaviors (parity with control-marker) ──────────────

describe("CommonMark fence behaviors", () => {
  it("outer 4-backtick fence contains 3-backtick — not a closer", () => {
    const r = extract("````\n```synod\n/open --agent omp\n```\n````");
    // 4-backtick opens outer regular fence, 3-backtick doesn't close it.
    // The entire body is absorbed by the outer fence.
    assert.deepStrictEqual(r.lines, []);
  });

  it("tilde is not a control opener", () => {
    const r = extract("~~~synod\n/open --agent omp\n~~~");
    assert.deepStrictEqual(r.lines, []);
  });

  it("column-0 required for control fence opener (even 1-space indent rejects)", () => {
    const r = extract(" ```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("indented outer fence (1 space ```text) takes priority over unindented ```synod inside", () => {
    const r = extract(" ```text\n```synod\n/open --agent omp\n```\n ```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("unclosed control fence → empty lines", () => {
    const r = extract("```synod\n/open --agent omp\n");
    assert.deepStrictEqual(r.lines, []);
  });

  it("trailing backtick run on different indent level is not a closer", () => {
    // ``` on column 0 opens.  ~~~ on column 0 is not a closer (wrong char).
    // ``` on column 0 closes.
    const r = extract("```synod\n/open --agent omp\n```\nmore text");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });
});

// ── BOM / CRLF normalization ────────────────────────────────────────────

describe("BOM / CRLF normalization", () => {
  it("leading BOM is stripped", () => {
    const r = extract("\uFEFF```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("CRLF line endings are normalized", () => {
    const r = extract("```synod\r\n/open --agent omp\r\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("bare CR line endings are normalized", () => {
    const r = extract("```synod\r/open --agent omp\r```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });
});

// ── Multiple fences / ordering ───────────────────────────────────────────

describe("multiple control fences", () => {
  it("two control fences → lines from both, ordered", () => {
    const r = extract(
      "```synod\n/open --agent omp\n```\n" +
      "some text\n" +
      "```synod\n@codex#1 hello\n```"
    );
    assert.deepStrictEqual(r.lines, [
      "/open --agent omp",
      "@codex#1 hello",
    ]);
  });

  it("dedup is across fences", () => {
    const r = extract(
      "```synod\n/open --agent omp\n```\n" +
      "```synod\n/open --agent omp\n```"
    );
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("second fence R1 fail → only first fence lines", () => {
    const r = extract(
      "```synod\n/open --agent omp\n```\n" +
      "```synod\nnot a command\n```"
    );
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
    assert.strictEqual(r.warnings.length, 1);
  });
});

// ── Partial / incremental delta ──────────────────────────────────────────

describe("partial delta handling", () => {
  it("partial delta with opener only → empty lines", () => {
    const r = extract("```synod\n/open --agent omp\n");
    assert.deepStrictEqual(r.lines, []);
  });

  it("partial delta with unclosed body → empty lines", () => {
    const r = extract("```synod\n/open --agent omp\n@codex#1 hello");
    assert.deepStrictEqual(r.lines, []);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("whitespace-only body lines are skipped", () => {
    const r = extract("```synod\n   \n/open --agent omp\n\t\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("body with only whitespace lines → R1 fails (no non-empty first line)", () => {
    const r = extract("```synod\n   \n\t\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("just an opener line with no body → empty", () => {
    const r = extract("```synod\n```");
    assert.deepStrictEqual(r.lines, []);
  });
});

// ── 4+ backtick control opener (A3 ledger: parity with control-marker) ─

describe("4+ backtick control opener", () => {
  it("4-backtick opener with info 'synod' is a valid control fence", () => {
    const r = extract("````synod\n/open --agent omp\n````");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("5-backtick opener works too", () => {
    const r = extract("`````synod\n@omp#1 hi\n`````");
    assert.deepStrictEqual(r.lines, ["@omp#1 hi"]);
  });
});

// ── Split/reassembly (cross-line opener reconstruction) ──────────────────

describe("split/reassembly", () => {
  it("opener split across two deltas → parsed after concatenation", () => {
    // Agent output may span multiple deltas.  Only the reassembled
    // complete turn text is parsed — individual deltas are empty.
    const r = extract("```sy" + "nod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("partial fragment alone → empty", () => {
    const r = extract("nod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });
});

// ── BOM edge case: BOM alone on first line ──────────────────────────────

describe("BOM normalization edge cases", () => {
  it("BOM on its own line before opener still parses", () => {
    // \uFEFF\n is the BOM character followed by a newline.
    // The BOM is stripped from the start of text, then normal
    // line splitting proceeds — so the BOM line becomes an empty
    // first line, and the opener on line 2 is found.
    const r = extract("\uFEFF\n```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });
});

// ── Outer fence type/indent equivalence (A3 ledger parity) ──────────────

describe("outer fence type/indent equivalence", () => {
  it("backtick outer (```text) containing ~~~ then ```synod → type tracking, zero lines", () => {
    const r = extract("```text\n~~~\n```synod\n/open --agent omp\n```\n~~~\n```");
    assert.deepStrictEqual(r.lines, []);
  });

  it("tilde outer (~~~text) containing ```synod → zero lines", () => {
    const r = extract("~~~text\n```synod\n/open --agent omp\n```\n~~~");
    assert.deepStrictEqual(r.lines, []);
  });

  it("indented outer 1-space ~~~text containing ```synod → outer priority", () => {
    const r = extract(" ~~~text\n```synod\n/open --agent omp\n```\n ~~~");
    assert.deepStrictEqual(r.lines, []);
  });

  it("indented outer 2-space 4-backtick ```text containing ```synod → outer priority", () => {
    const r = extract("  ````text\n```synod\n/open --agent omp\n```\n  ````");
    assert.deepStrictEqual(r.lines, []);
  });

  it("unclosed outer fence (```text no closer) before ```synod → everything absorbed", () => {
    const r = extract("```text\nsome code\n```synod\n/open --agent omp\n```");
    assert.deepStrictEqual(r.lines, []);
  });
});

// ── Length tracking recovery scan (A3 ledger parity) ────────────────────

describe("length tracking recovery scan", () => {
  it("4-backtick outer contains 3-backtick non-closer, then real ```synod after outer close", () => {
    // 4-backtick opens outer, 3-backtick inside does NOT close it.
    // Outer 4-backtick closer closes it.  Then ```synod /open ... ```
    // is a fresh control fence — length tracking recovers scanning.
    const r = extract(
      "````text\n" +
      "code with ``` inside\n" +
      "````\n" +
      "some text\n" +
      "```synod\n" +
      "/open --agent omp\n" +
      "```"
    );
    assert.deepStrictEqual(r.lines, ["/open --agent omp"]);
  });

  it("3-backtick inside 4-backtick is visible content (not closer), outer close → recovery", () => {
    const r = extract(
      "````text\n" +
      "```\n" +
      "not a closer line\n" +
      "````\n" +
      "```synod\n" +
      "@codex#1 hello\n" +
      "```"
    );
    assert.deepStrictEqual(r.lines, ["@codex#1 hello"]);
  })
});

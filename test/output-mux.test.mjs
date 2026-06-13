// test/output-mux.test.mjs — label-once (solo) ↔ per-line prefix (shared) mux.
//
// Mode is chosen by how many sessions are OPEN (not by streaming timing):
//   (SOLO, 1 session)  → print `[label]` once per turn, then stream the body
//      verbatim (model's own newlines preserved), no per-line prefix.
//   (SHARED, ≥2)       → every line prefixed, whole-line-atomic, so concurrent
//      sessions stay attributable and never interleave (A2/A6 no-cross-talk).
import { describe, it } from "node:test";
import assert from "node:assert";
import { createOutputMux } from "../src/session-manager.mjs";

function cap() {
  return { buf: "", write(s) { this.buf += s; return true; } };
}

describe("createOutputMux — solo (1 open session): label once, body verbatim", () => {
  it("prints the label once at turn start, then streams the body raw/live", () => {
    const out = cap();
    const a = createOutputMux(out).register("omp#1");
    a.startTurn();
    a.feed("一个程序员");                 // header + raw, no newline yet (live)
    assert.strictEqual(out.buf, "[omp#1]\n一个程序员");
    a.feed("去买鸡蛋。");                 // continues the SAME physical line
    assert.strictEqual(out.buf, "[omp#1]\n一个程序员去买鸡蛋。");
    a.endTurn();
    assert.strictEqual(out.buf, "[omp#1]\n一个程序员去买鸡蛋。\n");
  });

  it("preserves the model's own newlines without re-prefixing each line", () => {
    const out = cap();
    const a = createOutputMux(out).register("omp#1");
    a.startTurn();
    a.feed("行一\n\n行二");
    assert.strictEqual(out.buf, "[omp#1]\n行一\n\n行二");
    a.endTurn();
    assert.strictEqual(out.buf, "[omp#1]\n行一\n\n行二\n");
  });

  it("trims a leading newline so there is no blank gap under the header", () => {
    const out = cap();
    const a = createOutputMux(out).register("omp#1");
    a.startTurn();
    a.feed("\n\n有一天");                 // omp frequently leads with \n
    assert.strictEqual(out.buf, "[omp#1]\n有一天");
    a.endTurn();
  });

  it("each turn gets its own fresh header", () => {
    const out = cap();
    const a = createOutputMux(out).register("omp#1");
    a.startTurn(); a.feed("一"); a.endTurn();
    a.startTurn(); a.feed("二"); a.endTurn();
    assert.strictEqual(out.buf, "[omp#1]\n一\n[omp#1]\n二\n");
  });
});

describe("createOutputMux — shared (≥2 open sessions): per-line prefix, no cross-talk", () => {
  it("prefixes every line and never interleaves two sessions on one line", () => {
    const out = cap();
    const mux = createOutputMux(out);
    const a = mux.register("omp#1");
    const b = mux.register("codex#1");          // 2 sessions → shared
    a.startTurn();
    b.startTurn();
    a.feed("OCEAN par");                        // buffered (no newline)
    b.feed("FOREST wo");
    assert.strictEqual(out.buf, "", "shared mode withholds partial lines");
    a.feed("tial\n");
    b.feed("rld\n");
    assert.strictEqual(out.buf, "[omp#1] OCEAN partial\n[codex#1] FOREST world\n");
    for (const line of out.buf.split("\n")) {
      assert.ok(!(/OCEAN/.test(line) && /FOREST/.test(line)), "no line carries both markers");
    }
  });

  it("dropping back to one session resumes solo (label once)", () => {
    const out = cap();
    const mux = createOutputMux(out);
    const a = mux.register("omp#1");
    const b = mux.register("codex#1");
    b.dispose();                                // back to 1 session → solo
    a.startTurn();
    a.feed("hi");
    assert.strictEqual(out.buf, "[omp#1]\nhi");
    a.endTurn();
  });
});

describe("createOutputMux — transition: opening a 2nd session", () => {
  it("closes a dangling solo line before switching to shared", () => {
    const out = cap();
    const mux = createOutputMux(out);
    const a = mux.register("omp#1");            // 1 session → solo
    a.startTurn();
    a.feed("半行");                             // open solo line, no newline
    assert.strictEqual(out.buf, "[omp#1]\n半行");
    mux.register("codex#1");                    // 1→2: must close a's open line
    assert.strictEqual(out.buf, "[omp#1]\n半行\n");
    a.feed("续\n");                              // now shared → prefixed
    assert.strictEqual(out.buf, "[omp#1]\n半行\n[omp#1] 续\n");
  });
});

describe("createOutputMux — coloring", () => {
  it("colorizes the label header once (solo)", () => {
    const out = cap();
    const a = createOutputMux(out).register("omp#1", { colorize: (s) => `<${s}>` });
    a.startTurn();
    a.feed("x\n");
    assert.strictEqual(out.buf, "<[omp#1]>\nx\n");
  });
});

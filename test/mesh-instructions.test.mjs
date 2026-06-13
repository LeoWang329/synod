// synod/test/mesh-instructions.test.mjs — Tests for MESH_INSTRUCTIONS constant.
//
// Covers:
// 1. Fingerprint assertions (required content present)
// 2. Negative assertions (forbidden content absent)
// 3. Length < 16384
// 4. Snapshot anchor (opening framing sentence)

import { describe, it } from "node:test";
import assert from "node:assert";
import { MESH_INSTRUCTIONS } from "../src/mesh-instructions.mjs";

describe("MESH_INSTRUCTIONS content", () => {
  it("is a non-empty string", () => {
    assert.strictEqual(typeof MESH_INSTRUCTIONS, "string");
    assert.ok(MESH_INSTRUCTIONS.length > 0, "should not be empty");
  });

  it("length is under 16384", () => {
    assert.ok(
      MESH_INSTRUCTIONS.length < 16384,
      `length ${MESH_INSTRUCTIONS.length} should be < 16384`,
    );
  });
});

// ── Fingerprint assertions (required content must be present) ───────────

describe("MESH_INSTRUCTIONS fingerprints", () => {
  const text = MESH_INSTRUCTIONS;

  it("contains ```synod fence syntax", () => {
    assert.match(text, /```synod/);
  });

  it("contains /open --agent", () => {
    assert.match(text, /\/open --agent/);
  });

  it("documents both --mesh and --no-mesh overrides for agents", () => {
    assert.match(text, /--mesh/);
    assert.match(text, /--no-mesh/);
    // mesh is prompt-injection, not a capability gate: a leaf is only "not
    // prompted to orchestrate", never "cannot" (the wire still scans its output).
    assert.match(text, /not be prompted to orchestrate/);
  });

  it("contains @ label syntax reference", () => {
    assert.match(text, /@<label>/);
  });

  it("contains /relay", () => {
    assert.match(text, /\/relay/);
  });

  it("mentions maxSessions or session limit", () => {
    assert.match(text, /maxSessions|maximum.*session|session.*limit|护栏/i);
  });

  it("mentions maxDepth or depth limit", () => {
    assert.match(text, /maxDepth|maximum.*depth|depth.*limit|递归深度/i);
  });

  it("contains read-only or 只读", () => {
    assert.match(text, /read.only|只读/i);
  });

  it("tells the agent fence results are fed back to it next turn", () => {
    // The host injects each fence's outcome (created labels / rejections) back
    // to the originating agent.  The doc must announce this AND use the same
    // marker the injection uses, so the agent recognizes the message and can
    // act on the returned labels — otherwise it /open's a child it can't address.
    assert.match(text, /\[synod fence result\]/, "must reference the feedback marker");
    assert.match(
      text,
      /back to you|fed back|following turn|回(?:喂|传|报)/i,
      "must state results come back to the agent",
    );
  });
});

// ── Negative assertions (forbidden content must be absent) ──────────────

describe("MESH_INSTRUCTIONS sanitization", () => {
  const text = MESH_INSTRUCTIONS;

  it("does not contain 'nonce'", () => {
    assert.ok(!text.includes("nonce"), "must not contain nonce");
  });

  it("does not contain '@all'", () => {
    assert.ok(!text.includes("@all"), "must not contain @all");
  });

  it("does not contain 'skill' (--no-extensions)", () => {
    assert.ok(!text.includes("skill"), "must not reference skill");
  });

  it("does not contain inducing --write phrasing", () => {
    // "需要 --write", "use --write", "add --write", "pass --write"
    assert.ok(
      !/需要.*--write|use.*--write|add.*--write|pass.*--write/i.test(text),
      "must not induce agent to request --write",
    );
  });

  it("does not contain @all in any form", () => {
    assert.ok(!/@all/.test(text), "must not contain @all pattern");
  });

  it("covers @all exclusion without literal @all word", () => {
    // Must cover broadcast-style targets (like @all) without using "@all" literally
    assert.match(
      text,
      /Only the three command forms above|broadcast-style|non-label/i,
      "should cover @all exclusion generically",
    );
    assert.ok(!text.includes("@all"), "but must not contain @all literal");
  });
});

// ── Snapshot anchor ─────────────────────────────────────────────────────

describe("MESH_INSTRUCTIONS snapshot anchor", () => {
  it("opens with Synod mesh orchestration framing", () => {
    // Must start by disambiguating: this is protocol, not user instruction.
    assert.match(
      MESH_INSTRUCTIONS,
      /Synod.*mesh|mesh.*orchestrat|编排协议|protocol.*synod/i,
      "should frame as Synod mesh protocol",
    );
  });

  it("states it is NOT user instruction", () => {
    assert.match(
      MESH_INSTRUCTIONS,
      /not.*user|不是.*用户|并列.*system|system.*prompt/i,
      "should clarify this is not user/business instruction",
    );
  });

  it("states first line must start with / or @", () => {
    assert.match(
      MESH_INSTRUCTIONS,
      /首行.*(\/|@)|first.*line.*(\/|@)|column.*0.*(\/|@)/i,
      "should specify first line requirement",
    );
  });
});

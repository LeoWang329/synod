import { describe, it } from "node:test";
import assert from "node:assert";
import { extractControlCommands } from "../src/control-marker.mjs";

const NONCE = "secret123";

// Helper: build a control fence
function fence(body, nonce = NONCE) {
  const lines = ["```synod " + nonce];
  if (Array.isArray(body)) lines.push(...body);
  else lines.push(body);
  lines.push("```");
  return lines.join("\n");
}

describe("extractControlCommands", () => {

  // ═══════════════════════════════════════════════════════════════════
  // Happy path — fenced control blocks
  // ═══════════════════════════════════════════════════════════════════

  it("parses a single open command from control fence", () => {
    const text = fence('{"cmd":"open","agent":"omp","task":"write hello"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "write hello" },
    ]);
  });

  it("parses a single send command from control fence", () => {
    const text = fence('{"cmd":"send","to":"omp#1","msg":"what next?"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(commands, [
      { cmd: "send", to: "omp#1", msg: "what next?" },
    ]);
  });

  it("parses open with optional model field", () => {
    const text = fence('{"cmd":"open","agent":"codex","model":"slow","task":"review"}');
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "codex", model: "slow", task: "review" },
    ]);
  });

  it("parses multiple commands in order of appearance", () => {
    const text = [
      "Some prose before.",
      fence([
        '{"cmd":"open","agent":"omp","task":"first"}',
        '{"cmd":"send","to":"omp","msg":"second"}',
      ]),
      "Trailing prose.",
    ].join("\n");
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(commands.length, 2);
    assert.deepStrictEqual(commands[0], { cmd: "open", agent: "omp", task: "first" });
    assert.deepStrictEqual(commands[1], { cmd: "send", to: "omp", msg: "second" });
  });

  it("allows whitespace between backticks and synod in opener", () => {
    const lines = [
      "```  synod secret123",
      '{"cmd":"open","agent":"omp","task":"x"}',
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(lines, { nonce: NONCE });
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "x" },
    ]);
  });

  it("allows 4+ backticks in control fence opener", () => {
    const lines = [
      "````synod secret123",
      '{"cmd":"open","agent":"omp","task":"four ticks"}',
      "````",
    ].join("\n");
    const { commands } = extractControlCommands(lines, { nonce: NONCE });
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "four ticks" },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════════
  // FP#1 — prose "synod" and bare @@synod lines (DEAD)
  // ═══════════════════════════════════════════════════════════════════

  it("FP#1: ignores prose containing bare 'synod'", () => {
    const text = "synod is a great tool for agent orchestration. Use it wisely.";
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
    assert.deepStrictEqual(warnings, []);
  });

  it("FP#1: bare @@synod line is DEAD — never triggers", () => {
    const text = '@@synod secret123 {"cmd":"open","agent":"omp","task":"dead"}';
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("FP#1: bare @@synod line with correct nonce is DEAD", () => {
    // Even with the real nonce, bare @@synod lines are dead.
    const text = [
      "Here is the marker format:",
      '@@synod secret123 {"cmd":"open","agent":"omp","task":"demo"}',
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  // ═══════════════════════════════════════════════════════════════════
  // FP#2 — code fences: marker inside regular fence → zero commands
  // ═══════════════════════════════════════════════════════════════════

  it("FP#2: control fence inside outer backtick fence → zero commands", () => {
    const text = [
      "```text",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "```",
      "```",
    ].join("\n");
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
    assert.deepStrictEqual(warnings, []);
  });

  it("FP#2: control fence inside outer tilde fence → zero commands", () => {
    const text = [
      "~~~",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "```",
      "~~~",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("FP#2: control fence with language label on outer fence → zero commands", () => {
    const text = [
      "```json",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "```",
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("FP#2: control fence outside regular fence still recognized", () => {
    const text = [
      "```",
      '{"this":"is code"}',
      "```",
      fence('{"cmd":"send","to":"omp","msg":"keep"}'),
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 1);
    assert.deepStrictEqual(commands[0], { cmd: "send", to: "omp", msg: "keep" });
  });

  // ── Fence type + length tracking (CommonMark rules) ───────────────

  it("backtick fence containing ~~~ inside → zero commands (type tracking)", () => {
    // ~~~ inside a ``` fence is NOT a closer — different char type.
    const text = [
      "```text",
      "~~~",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "```",
      "~~~",
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("tilde fence containing ``` inside → zero commands (type tracking)", () => {
    const text = [
      "~~~text",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "```",
      "~~~",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("4-backtick fence containing 3-backtick closer → zero commands (length tracking)", () => {
    // 3 backticks won't close a 4-backtick fence.
    const text = [
      "````text",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "```",
      "````",
      fence('{"cmd":"send","to":"omp","msg":"keep"}'),
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 1);
    assert.deepStrictEqual(commands[0], { cmd: "send", to: "omp", msg: "keep" });
  });

  // ── Indented regular fences (CommonMark: up to 3 spaces) ─────────

  it("indented outer ```json (1 space) containing control fence → zero commands", () => {
    const text = [
      " ```json",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"indented outer"}',
      "```",
      " ```",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("indented outer ~~~text containing control fence → zero commands", () => {
    const text = [
      " ~~~text",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"indented tilde"}',
      "```",
      " ~~~",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("indented outer 4-backtick fence containing 3-backtick control fence → zero commands", () => {
    const text = [
      "  ````text",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"indented 4tik"}',
      "```",
      "  ````",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("control fence with leading space does NOT fire (column-0 required)", () => {
    // Control opener at column >0 is treated as a regular fence → body ignored.
    const text = [
      " ```synod secret123",
      '{"cmd":"open","agent":"omp","task":"indented ctrl"}',
      " ```",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  // ═══════════════════════════════════════════════════════════════════
  // FP#3 KILLER — agent explains syntax
  // ═══════════════════════════════════════════════════════════════════

  it("FP#3 KILLER: codex prose with real nonce as bare @@synod line → ZERO commands", () => {
    // This is THE test. Agent casually mentions the marker syntax and
    // outputs the real nonce in a bare line — must produce zero commands.
    const text = [
      "To control Synod, output:",
      '@@synod secret123 {"cmd":"open","agent":"omp","task":"demo"}',
      "This is only an example.",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("FP#3 KILLER: control fence with placeholder nonce → zero commands", () => {
    // Agent demonstrates the syntax with a placeholder nonce.
    const text = [
      "To control Synod, use a fenced block like:",
      "```synod <YOUR_NONCE>",
      '{"cmd":"open","agent":"omp","task":"write a function"}',
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("FP#3 KILLER: control fence with fake nonce → zero commands", () => {
    const text = [
      "```synod abc123",
      '{"cmd":"open","agent":"omp","task":"demo"}',
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("real control fence with real nonce → normal parsing", () => {
    const text = [
      "Prose before.",
      fence('{"cmd":"open","agent":"omp","task":"real command"}'),
      "Prose after.",
    ].join("\n");
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "real command" },
    ]);
  });

  it("control fence inside outer regular fence → zero commands (outer priority)", () => {
    // The outer ```json fence opens first; everything inside is ignored.
    const text = [
      "```json",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"demo"}',
      "```",
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  // ═══════════════════════════════════════════════════════════════════
  // No-nonce defense
  // ═══════════════════════════════════════════════════════════════════

  it("ignores all control fences when no nonce provided", () => {
    const text = fence('{"cmd":"open","agent":"omp","task":"x"}');
    const { commands } = extractControlCommands(text, { nonce: undefined });
    assert.deepStrictEqual(commands, []);
  });

  it("ignores all control fences when empty options object (no nonce)", () => {
    const text = fence('{"cmd":"open","agent":"omp","task":"x"}');
    const { commands } = extractControlCommands(text, {});
    assert.deepStrictEqual(commands, []);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Fragment reassembly
  // ═══════════════════════════════════════════════════════════════════

  it("parses control fence from assembled turn text (split across deltas)", () => {
    const delta1 = "```synod secre";
    const delta2 = 't123\n{"cmd":"open","agent":"omp","task":"fragmented"}\n```';
    const assembled = delta1 + delta2;
    const { commands, warnings } = extractControlCommands(assembled, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "fragmented" },
    ]);
  });

  it("partial delta1 alone produces zero commands", () => {
    const delta1 = "```synod secre";
    const { commands } = extractControlCommands(delta1, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("partial delta2 alone produces zero commands", () => {
    const delta2 = 't123\n{"cmd":"open","agent":"omp","task":"fragmented"}\n```';
    const { commands } = extractControlCommands(delta2, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("partial chunk with unclosed control fence → zero commands", () => {
    const text = [
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"incomplete"}',
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Deduplication
  // ═══════════════════════════════════════════════════════════════════

  it("deduplicates identical JSON commands in same control fence", () => {
    const line = '{"cmd":"open","agent":"omp","task":"hello"}';
    const text = fence([line, line]);
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(commands.length, 1);
  });

  it("deduplicates command appearing three times", () => {
    const line = '{"cmd":"send","to":"x","msg":"y"}';
    const text = fence([line, line, line]);
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 1);
  });

  it("does not deduplicate different commands", () => {
    const text = fence([
      '{"cmd":"open","agent":"omp","task":"task1"}',
      '{"cmd":"open","agent":"omp","task":"task2"}',
    ]);
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 2);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Corruption resilience
  // ═══════════════════════════════════════════════════════════════════

  it("skips corrupt JSON, emits warning, continues parsing valid lines", () => {
    const text = fence([
      "{not valid json}",
      '{"cmd":"open","agent":"omp","task":"good"}',
    ]);
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 1);
    assert.deepStrictEqual(commands[0], { cmd: "open", agent: "omp", task: "good" });
    assert.strictEqual(warnings.length, 1);
    const w = warnings[0];
    assert.ok(w.reason.includes("JSON"), "reason should mention JSON");
    assert.ok(w.marker.includes("{not valid json}"), "marker should contain broken line");
    assert.strictEqual(w.line, 2); // line 2 of the fence (body line 1)
  });

  it("skips missing cmd field and warns", () => {
    const text = fence('{"agent":"omp","task":"x"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].reason.includes("'cmd'"));
  });

  it("skips unknown cmd value and warns", () => {
    const text = fence('{"cmd":"destroy","target":"everything"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].reason.includes("unknown cmd"));
  });

  it("skips open without agent and warns", () => {
    const text = fence('{"cmd":"open","task":"something"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].reason.includes("agent"));
  });

  it("skips open without task and warns", () => {
    const text = fence('{"cmd":"open","agent":"omp"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].reason.includes("task"));
  });

  it("skips send without 'to' and warns", () => {
    const text = fence('{"cmd":"send","msg":"hello"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].reason.includes("'to'"));
  });

  it("skips send without 'msg' and warns", () => {
    const text = fence('{"cmd":"send","to":"omp#1"}');
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].reason.includes("'msg'"));
  });

  it("does not throw on mixed valid/corrupt body lines", () => {
    const text = fence([
      '{"cmd":"open","agent":"omp","task":"valid1"}',
      "{broken}",
      '{"cmd":"send","to":"omp","msg":"valid2"}',
      '{"cmd":"open"}',
    ]);
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 2);
    assert.deepStrictEqual(commands[0], { cmd: "open", agent: "omp", task: "valid1" });
    assert.deepStrictEqual(commands[1], { cmd: "send", to: "omp", msg: "valid2" });
    assert.strictEqual(warnings.length, 2);
  });

  it("skips non-object JSON (array, string, number) — JSON.parse succeeds but validate rejects", () => {
    // Arrays/strings/numbers parse fine but aren't command objects.
    const text = fence([
      "[1,2,3]",
      '"just a string"',
      "42",
      '{"cmd":"open","agent":"omp","task":"real"}',
    ]);
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 1);
    assert.deepStrictEqual(commands[0], { cmd: "open", agent: "omp", task: "real" });
    assert.strictEqual(warnings.length, 3);
    const objWarns = warnings.filter(w => w.reason.includes("plain object"));
    assert.strictEqual(objWarns.length, 3);
  });

  // ═══════════════════════════════════════════════════════════════════
  // BOM
  // ═══════════════════════════════════════════════════════════════════

  it("BOM: leading U+FEFF is normalized away, control fence parses normally", () => {
    const body = '{"cmd":"open","agent":"omp","task":"bom"}';
    const text = "\uFEFF" + fence(body);
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "bom" },
    ]);
  });

  it("BOM alone on first line does not prevent fence detection", () => {
    // BOM + newline + control fence
    const text = "\uFEFF\n" + fence('{"cmd":"open","agent":"omp","task":"bom2"}');
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "bom2" },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Line ending normalization (CRLF)
  // ═══════════════════════════════════════════════════════════════════

  it("CRLF: carriage returns are normalized, control fence parses", () => {
    const text = [
      "```synod secret123\r",
      '{"cmd":"open","agent":"omp","task":"crlf"}\r',
      "```\r",
    ].join("");
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "crlf" },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════════
  // String containing closing brace / backticks / special chars
  // ═══════════════════════════════════════════════════════════════════

  it("JSON string containing }", () => {
    const body = '{"cmd":"open","agent":"omp","task":"use } in output"}';
    const text = fence(body);
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "use } in output" },
    ]);
  });

  it("nested JSON objects in task field", () => {
    const body = '{"cmd":"open","agent":"omp","task":"config: {\\"key\\": \\"value\\"}"}';
    const text = fence(body);
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].task, 'config: {"key": "value"}');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Nonce with regex metacharacters
  // ═══════════════════════════════════════════════════════════════════

  it("nonce containing regex-special characters works (string comparison, not regex)", () => {
    const spicy = "a.b*c+?^${}[]()|\\";
    const lines = [
      "```synod " + spicy,
      '{"cmd":"open","agent":"omp","task":"spicy nonce"}',
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(lines, { nonce: spicy });
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "spicy nonce" },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Additional edge cases
  // ═══════════════════════════════════════════════════════════════════

  it("empty text → no commands", () => {
    const { commands, warnings } = extractControlCommands("", { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
    assert.deepStrictEqual(warnings, []);
  });

  it("text with no fences → no commands", () => {
    const text = "This is just a normal turn output.\nNothing to see here.";
    const { commands, warnings } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
    assert.deepStrictEqual(warnings, []);
  });

  it("tilde fence is never a control fence (only backtick)", () => {
    const lines = [
      "~~~synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "~~~",
    ].join("\n");
    const { commands } = extractControlCommands(lines, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("command preserves extra fields through unchanged", () => {
    const text = fence('{"cmd":"open","agent":"omp","task":"x","extra":"kept"}');
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, [
      { cmd: "open", agent: "omp", task: "x", extra: "kept" },
    ]);
  });

  it("nonce comparison is exact, not substring", () => {
    // NONCE is "secret123"; "secret1234" should not match.
    const lines = [
      "```synod secret1234",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      "```",
    ].join("\n");
    const { commands } = extractControlCommands(lines, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("body blank lines are skipped, not treated as commands", () => {
    const text = fence([
      "",
      '{"cmd":"open","agent":"omp","task":"real"}',
      "",
      "",
    ]);
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 1);
  });

  it("unclosed regular fence blanks rest of document", () => {
    const text = [
      "```text",
      "```synod secret123",
      '{"cmd":"open","agent":"omp","task":"nope"}',
      // no closer — fence never closes
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.deepStrictEqual(commands, []);
  });

  it("two control fences in one text produce ordered commands", () => {
    const text = [
      fence('{"cmd":"open","agent":"omp","task":"first"}'),
      "Some prose.",
      fence('{"cmd":"send","to":"omp","msg":"second"}'),
    ].join("\n");
    const { commands } = extractControlCommands(text, { nonce: NONCE });
    assert.strictEqual(commands.length, 2);
    assert.deepStrictEqual(commands[0], { cmd: "open", agent: "omp", task: "first" });
    assert.deepStrictEqual(commands[1], { cmd: "send", to: "omp", msg: "second" });
  });
});

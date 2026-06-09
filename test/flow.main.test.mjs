/**
 * test/flow.main.test.mjs — Injectable main() unit tests.
 *
 * Tests main() with faked dependencies: stdout/stderr collectors,
 * fake openBackend, memory fs (hermetic — no real disk writes).
 *
 * Hardened assertions (codex review round 2):
 *   - JSON input → echo-input fixture proves typeof==="object"
 *   - Raw string input → typeof==="string"
 *   - Real discoverFlows throw (bad .mjs at root) + loadFlow fallback
 *   - All success-path tests use noop fs (no run.log.jsonl writes)
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/flow.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "fixtures", "workflows");
const VALID_DIR = resolve(FIXTURES_DIR, "valid");
const NONEXISTENT = resolve(FIXTURES_DIR, "__does_not_exist__");

const noopFs = {
  writeFile: async () => {},
  appendFile: async () => {},
};

function collector() {
  let text = "";
  return { write(s) { text += s; }, text() { return text; } };
}

describe("main()", () => {
  async function runMain(argv, { workflowsRoot = VALID_DIR, cwd = process.cwd(), fs = noopFs } = {}) {
    const stdout = collector();
    const stderr = collector();
    const code = await main({ argv, stdout, stderr, openBackend: fakeOpenBackend, workflowsRoot, cwd, fs });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  // ── Error: --workflows missing value ─────────────────────────────

  it("--workflows missing value → exit 2 + stderr", async () => {
    const r = await runMain(["--workflows"]);
    assert.strictEqual(r.code, 2);
    assert.ok(r.stderr.includes("--workflows requires a path"));
  });

  // ── Error: no name provided ──────────────────────────────────────

  it("missing flow name → exit 2 + stderr", async () => {
    const r = await runMain([]);
    assert.strictEqual(r.code, 2);
    assert.ok(r.stderr.includes("flow name required"));
  });

  it("--list without name → succeeds (list mode)", async () => {
    const r = await runMain(["--list"]);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes("linear:"), "should list linear flow");
  });

  // ── Error: flow not found ────────────────────────────────────────

  it("flow not found → exit 1 + stderr", async () => {
    const r = await runMain(["nonexistent_flow_xyz"]);
    assert.strictEqual(r.code, 1);
    assert.ok(r.stderr.includes("not found"));
  });

  // ── Error: --list with bad directory ─────────────────────────────

  it("--list with non-existent directory → exit 1 + stderr", async () => {
    const r = await runMain(["--list"], { workflowsRoot: NONEXISTENT });
    assert.strictEqual(r.code, 1);
    assert.ok(r.stderr.includes("failed to discover flows"));
  });

  // ── Success: run a valid flow (hermetic fs) ──────────────────────

  it("runs a valid flow → exit 0 + JSON stdout, stderr empty", async () => {
    const r = await runMain(["linear"]);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    let out;
    try { out = JSON.parse(r.stdout.trim()); } catch { assert.fail(`stdout not JSON: ${r.stdout}`); }
    assert.ok(out && typeof out === "object", "output should be an object");
    assert.ok("a" in out, "should have agent output a");
    assert.ok("b" in out, "should have bash output b");
    assert.ok("c" in out, "should have agent output c");
  });

  // ── Input parsing: JSON object → typeof object (echo-input fixture) ──

  it("JSON input → parsed to object (echo-input fixture)", async () => {
    const r = await runMain(["echo-input", '{"x":1,"y":[2]}']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.type, "object", "JSON input should be typeof object");
    assert.strictEqual(out.isArray, false);
    assert.deepStrictEqual(out.input, { x: 1, y: [2] });
  });

  it("JSON array input → parsed to array (echo-input fixture)", async () => {
    const r = await runMain(["echo-input", "[1,2,3]"]);
    assert.strictEqual(r.code, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.type, "object", "arrays are typeof object in JS");
    assert.strictEqual(out.isArray, true);
    assert.deepStrictEqual(out.input, [1, 2, 3]);
  });

  // ── Input parsing: raw string fallback (echo-input fixture) ──────

  it("raw string input → typeof string (not JSON-parsed)", async () => {
    const r = await runMain(["echo-input", "hello world"]);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.type, "string", "raw string input should stay string");
    assert.strictEqual(out.input, "hello world");
  });

  it("illegal JSON input → kept as raw string", async () => {
    const r = await runMain(["echo-input", "{not valid json"]);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr, "");
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.type, "string");
    assert.strictEqual(out.input, "{not valid json");
  });

  // ── Error: flow execution fails ──────────────────────────────────

  it("flow execution error → exit 1 + stderr with flow name", async () => {
    // bad-flow fixture has a syntax error → discoverFlows throws → loadFlow also fails
    const r = await runMain(["bad-flow"], { workflowsRoot: FIXTURES_DIR });
    assert.strictEqual(r.code, 1);
    assert.ok(r.stderr.includes("not found") || r.stderr.includes("bad-flow"),
      `expected stderr about bad-flow, got: ${r.stderr}`);
  });

  // ── discoverFlows throws, loadFlow succeeds on subdirectory flow ──

  it("discoverFlows throws on root-level bad .mjs, loadFlow succeeds on subdirectory flow", async () => {
    // FIXTURES_DIR has bad-flow.mjs (syntax error) at root → discoverFlows throws
    // But valid/linear.mjs is in a subdirectory → loadFlow("valid/linear") succeeds
    const r = await runMain(["valid/linear"], { workflowsRoot: FIXTURES_DIR });
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    assert.strictEqual(r.stderr, "");
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.a !== undefined, "should have agent output a");
  });

  // ── --help ───────────────────────────────────────────────────────

  it("--help → exit 0 + usage text", async () => {
    const r = await runMain(["--help"]);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes("Usage:"));
    assert.ok(r.stdout.includes("--list"));
  });

  it("-h → exit 0 + usage text", async () => {
    const r = await runMain(["-h"]);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes("Usage:"));
  });

  // ── --list with --workflows override ─────────────────────────────

  it("--list with --workflows override → uses that directory", async () => {
    const r = await runMain(["--list", "--workflows", VALID_DIR]);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes("linear:"));
    assert.ok(r.stdout.includes("Linear 3-node: agent → bash → agent"));
  });
});

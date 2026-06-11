/**
 * test/flow-args.test.mjs — Pure-function unit tests for parseFlowArgs.
 *
 * Tests cover all parse cases: --list, --workflows, positional name/input,
 * --help, error conditions, and edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { parseFlowArgs } from "../src/flow.mjs";

describe("parseFlowArgs", () => {
  // ── --list ──────────────────────────────────────────────────────────

  it("parses --list", () => {
    const r = parseFlowArgs(["--list"]);
    assert.strictEqual(r.list, true);
    assert.strictEqual(r.name, null);
    assert.strictEqual(r._error, null);
  });

  // ── positional name ─────────────────────────────────────────────────

  it("parses a single flow name", () => {
    const r = parseFlowArgs(["myname"]);
    assert.strictEqual(r.name, "myname");
    assert.strictEqual(r.input, null);
    assert.strictEqual(r.list, false);
    assert.strictEqual(r._error, null);
  });

  it("parses name + input", () => {
    const r = parseFlowArgs(["myname", '{"x":1}']);
    assert.strictEqual(r.name, "myname");
    assert.strictEqual(r.input, '{"x":1}');
    assert.strictEqual(r._error, null);
  });

  it("parses name + plain string input", () => {
    const r = parseFlowArgs(["myname", "hello world"]);
    assert.strictEqual(r.name, "myname");
    assert.strictEqual(r.input, "hello world");
    assert.strictEqual(r._error, null);
  });

  // ── --workflows ─────────────────────────────────────────────────────

  it("parses --workflows with a path", () => {
    const r = parseFlowArgs(["--workflows", "/some/path"]);
    assert.strictEqual(r.workflowsRoot, "/some/path");
    assert.strictEqual(r._error, null);
  });

  it("parses --workflows before name", () => {
    const r = parseFlowArgs(["--workflows", "/some/path", "myname"]);
    assert.strictEqual(r.workflowsRoot, "/some/path");
    assert.strictEqual(r.name, "myname");
    assert.strictEqual(r._error, null);
  });

  it("errors when --workflows has no value", () => {
    const r = parseFlowArgs(["--workflows"]);
    assert.strictEqual(r._error, "--workflows requires a path");
  });

  it("errors when --workflows value is another flag", () => {
    const r = parseFlowArgs(["--workflows", "--list"]);
    assert.strictEqual(r._error, "--workflows requires a path");
  });

  // ── --help ──────────────────────────────────────────────────────────

  it("parses --help", () => {
    const r = parseFlowArgs(["--help"]);
    assert.strictEqual(r._help, true);
    assert.strictEqual(r._error, null);
  });

  it("parses -h", () => {
    const r = parseFlowArgs(["-h"]);
    assert.strictEqual(r._help, true);
    assert.strictEqual(r._error, null);
  });

  // ── combined flags ──────────────────────────────────────────────────

  it("parses --list with --workflows", () => {
    const r = parseFlowArgs(["--list", "--workflows", "/path"]);
    assert.strictEqual(r.list, true);
    assert.strictEqual(r.workflowsRoot, "/path");
    assert.strictEqual(r._error, null);
  });

  // ── error cases ─────────────────────────────────────────────────────

  it("errors on unrecognized option", () => {
    const r = parseFlowArgs(["--unknown"]);
    assert.ok(r._error?.includes("unrecognized option"));
    assert.ok(r._error?.includes("--unknown"));
  });

  it("errors when too many positional args", () => {
    const r = parseFlowArgs(["name", "input", "extra"]);
    assert.ok(r._error?.includes("unexpected argument"));
    assert.ok(r._error?.includes("extra"));
  });

  // ── edge cases ──────────────────────────────────────────────────────

  it("returns defaults for empty argv", () => {
    const r = parseFlowArgs([]);
    assert.strictEqual(r.list, false);
    assert.strictEqual(r.name, null);
    assert.strictEqual(r.input, null);
    assert.strictEqual(r.workflowsRoot, null);
    assert.strictEqual(r._help, false);
    assert.strictEqual(r._error, null);
  });

  it("allows --list with positional name (--list wins)", () => {
    const r = parseFlowArgs(["--list", "somename"]);
    assert.strictEqual(r.list, true);
    assert.strictEqual(r.name, "somename");
    assert.strictEqual(r._error, null);
  });

  it("parses name with flag-like value as input", () => {
    // Positional args after the name are input, not flags
    const r = parseFlowArgs(["myname", "--something"]);
    assert.strictEqual(r.name, "myname");
    assert.strictEqual(r.input, "--something");
    assert.strictEqual(r._error, null);
  });
});

it("P2-45 `--` 后的 token 一律按位置参数,input 为 --list 不被吞成 flag", () => {
  const r = parseFlowArgs(["--progress", "--", "myflow", "--list"]);
  assert.equal(r.progress, true);
  assert.equal(r.name, "myflow");
  assert.equal(r.input, "--list");
  assert.equal(r.list, false, "`--` 之后的 --list 是 input,不是 --list flag");
  assert.equal(r._error, null);
});
it("P2-45 `--` 后超过两个位置参数报错", () => {
  const r = parseFlowArgs(["--", "a", "b", "c"]);
  assert.match(r._error, /unexpected argument: c/);
});

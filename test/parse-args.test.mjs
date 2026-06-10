import { describe, it } from "node:test";
import assert from "node:assert";
import { parseArgs, AGENTS, meshFromEnv } from "../src/cli.mjs";

describe("parseArgs", () => {
  it("defaults: no args", () => {
    const out = parseArgs([]);
    assert.strictEqual(out.agent, "omp");
    assert.strictEqual(out.model, undefined);
    assert.strictEqual(out.effort, undefined);
    assert.strictEqual(out.write, false);
    assert.deepStrictEqual(out.tasks, []);
    assert.strictEqual(out._unknown, null);
  });

  it("--agent codex", () => {
    const out = parseArgs(["--agent", "codex"]);
    assert.strictEqual(out.agent, "codex");
    assert.strictEqual(out._unknown, null);
  });

  it("--agent invalid", () => {
    const out = parseArgs(["--agent", "invalid"]);
    assert.ok(out._unknown);
    assert.match(out._unknown, /--agent value must be one of omp, codex/);
  });

  it("--model foo", () => {
    const out = parseArgs(["--model", "foo"]);
    assert.strictEqual(out.model, "foo");
    assert.strictEqual(out._unknown, null);
  });

  it("--model missing value", () => {
    const out = parseArgs(["--model", "--other"]);
    assert.ok(out._unknown);
    assert.match(out._unknown, /--model requires a value/);
  });

  it("--effort high", () => {
    const out = parseArgs(["--effort", "high"]);
    assert.strictEqual(out.effort, "high");
    assert.strictEqual(out._unknown, null);
  });

  it("--write", () => {
    const out = parseArgs(["--write"]);
    assert.strictEqual(out.write, true);
    assert.strictEqual(out._unknown, null);
  });

  it("--mesh", () => {
    const out = parseArgs(["--mesh"]);
    assert.strictEqual(out.mesh, true);
    assert.strictEqual(out._unknown, null);
  });

  it("--no-mesh", () => {
    const out = parseArgs(["--no-mesh"]);
    assert.strictEqual(out.mesh, false);
    assert.strictEqual(out._unknown, null);
  });

  it("mesh defaults to undefined (tri-state: falls back to SYNOD_MESH env)", () => {
    const out = parseArgs([]);
    assert.strictEqual(out.mesh, undefined);
  });

  it("--mesh --no-mesh → mutually-exclusive error (mirrors /open)", () => {
    const out = parseArgs(["--mesh", "--no-mesh"]);
    assert.ok(out._unknown && out._unknown.includes("mutually exclusive"));
  });

  it("--no-mesh --mesh (reverse) → mutually-exclusive error", () => {
    const out = parseArgs(["--no-mesh", "--mesh"]);
    assert.ok(out._unknown && out._unknown.includes("mutually exclusive"));
  });

  it("repeated --mesh is idempotent (no error)", () => {
    const out = parseArgs(["--mesh", "--mesh"]);
    assert.strictEqual(out.mesh, true);
    assert.strictEqual(out._unknown, null);
  });

  it("repeated --no-mesh is idempotent (no error)", () => {
    const out = parseArgs(["--no-mesh", "--no-mesh"]);
    assert.strictEqual(out.mesh, false);
    assert.strictEqual(out._unknown, null);
  });

  it("--task omp:hello", () => {
    const out = parseArgs(["--task", "omp:hello"]);
    assert.deepStrictEqual(out.tasks, [{ agent: "omp", prompt: "hello" }]);
  });

  it("multiple --task", () => {
    const out = parseArgs(["--task", "omp:a", "--task", "codex:b"]);
    assert.deepStrictEqual(out.tasks, [
      { agent: "omp", prompt: "a" },
      { agent: "codex", prompt: "b" },
    ]);
    assert.strictEqual(out._unknown, null);
  });

  it("--task missing colon", () => {
    const out = parseArgs(["--task", "no-colon"]);
    assert.ok(out._unknown);
    assert.match(out._unknown, /must contain ":"/);
  });

  it("--task invalid:prompt", () => {
    const out = parseArgs(["--task", "invalid:prompt"]);
    assert.ok(out._unknown);
    assert.match(out._unknown, /--task agent must be one of omp, codex/);
  });

  it("--task omp: (empty prompt after trim)", () => {
    const out = parseArgs(["--task", "omp:"]);
    assert.ok(out._unknown);
    assert.match(out._unknown, /--task prompt must not be empty/);
  });

  it("--task missing value", () => {
    const out = parseArgs(["--task", "--other"]);
    assert.ok(out._unknown);
    assert.match(out._unknown, /--task requires a value/);
  });

  it("unknown arg", () => {
    const out = parseArgs(["--foo"]);
    assert.ok(out._unknown);
    assert.match(out._unknown, /unrecognized argument: --foo/);
  });

  it("--help", () => {
    const out = parseArgs(["--help"]);
    assert.strictEqual(out._help, true);
    assert.strictEqual(out._unknown, null);
  });

  it("-h", () => {
    const out = parseArgs(["-h"]);
    assert.strictEqual(out._help, true);
    assert.strictEqual(out._unknown, null);
  });
});

describe("meshFromEnv", () => {
  it('"1" → true', () => {
    assert.strictEqual(meshFromEnv({ SYNOD_MESH: "1" }), true);
  });

  it('"true" → true', () => {
    assert.strictEqual(meshFromEnv({ SYNOD_MESH: "true" }), true);
  });

  it('"0" → false', () => {
    assert.strictEqual(meshFromEnv({ SYNOD_MESH: "0" }), false);
  });

  it('"false" → false', () => {
    assert.strictEqual(meshFromEnv({ SYNOD_MESH: "false" }), false);
  });

  it('"" → false', () => {
    assert.strictEqual(meshFromEnv({ SYNOD_MESH: "" }), false);
  });

  it("no key → false", () => {
    assert.strictEqual(meshFromEnv({}), false);
  });

  it("undefined value → false", () => {
    assert.strictEqual(meshFromEnv({ SYNOD_MESH: undefined }), false);
  });

  it("arbitrary string → false", () => {
    assert.strictEqual(meshFromEnv({ SYNOD_MESH: "yes" }), false);
  });
});

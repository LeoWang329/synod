import { describe, it } from "node:test";
import assert from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFlows } from "../src/flow/loader.mjs";

const FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "fixtures", "workflows",
);

const VALID_DIR = resolve(FIXTURES_ROOT, "valid");
const NO_RUN_DIR = resolve(FIXTURES_ROOT, "no-run");
const NO_META_DIR = resolve(FIXTURES_ROOT, "no-meta");
const BAD_IMPORT_DIR = resolve(FIXTURES_ROOT, "bad-import");
const COMMENT_OK_DIR = resolve(FIXTURES_ROOT, "comment-ok");
const STRING_OK_DIR = resolve(FIXTURES_ROOT, "string-ok");
const COMPACT_BAD_DIR = resolve(FIXTURES_ROOT, "compact-bad");
const FROM_KEYWORD_BAD_DIR = resolve(FIXTURES_ROOT, "from-keyword-bad");
const FROM_KEYWORD_OK_DIR = resolve(FIXTURES_ROOT, "from-keyword-ok");
const TEMPLATE_NESTED_OK_DIR = resolve(FIXTURES_ROOT, "template-nested-ok");
const DYNAMIC_OK_DIR = resolve(FIXTURES_ROOT, "dynamic-ok");
const IMPORT_COMMENT_BAD_DIR = resolve(FIXTURES_ROOT, "import-comment-bad");
const FROM_COMMENT_BAD_DIR = resolve(FIXTURES_ROOT, "from-comment-bad");
const EXPORT_STAR_BAD_DIR = resolve(FIXTURES_ROOT, "export-star-bad");
const EXPORT_LOCAL_THEN_BAD_DIR = resolve(FIXTURES_ROOT, "export-local-then-bad");
const EXPORT_LOCAL_THEN_OK_DIR = resolve(FIXTURES_ROOT, "export-local-then-ok");
describe("discovery", () => {
  it("discovers flow names from filenames (strips .mjs)", async () => {
    const flows = await discoverFlows(VALID_DIR);
    const names = flows.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ["echo-input", "linear"]);
  });
  it("extracts meta.description from valid flows", async () => {
    const flows = await discoverFlows(VALID_DIR);
    const linear = flows.find((f) => f.name === "linear");
    assert.ok(linear, "linear flow should be discovered");
    assert.ok(
      linear.meta.description.includes("Linear"),
      "meta.description should be extracted",
    );
  });

  it("rejects flow with missing run export", async () => {
    await assert.rejects(
      () => discoverFlows(NO_RUN_DIR),
      /no-run.*must export.*run/,
    );
  });

  it("rejects flow with missing meta.description", async () => {
    await assert.rejects(
      () => discoverFlows(NO_META_DIR),
      /no-meta.*must export meta\.description/,
    );
  });

  it("rejects flow that imports non-synod/flow modules (AST lint)", async () => {
    await assert.rejects(
      () => discoverFlows(BAD_IMPORT_DIR),
      /bad-import.*not allowed/,
    );
  });

  it("accepts flow where bad import only appears in comments (lexical lint strips comments)", async () => {
    const flows = await discoverFlows(COMMENT_OK_DIR);
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].name, "comment-ok");
  });

  it("rejects compact import {x} from \"bad\" — lexical lint catches compact syntax", async () => {
    await assert.rejects(
      () => discoverFlows(COMPACT_BAD_DIR),
      /compact-bad.*not allowed/,
    );
  });

  it("accepts flow with dynamic import — static lint is not a sandbox", async () => {
    const flows = await discoverFlows(DYNAMIC_OK_DIR);
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].name, "dynamic-ok");
  });

  it("accepts flow with bad import inside a template literal (state-machine skips strings)", async () => {
    const flows = await discoverFlows(STRING_OK_DIR);
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].name, "string-ok");
  });

  it("rejects import where from is used as binding name but real specifier is bad", async () => {
    await assert.rejects(
      () => discoverFlows(FROM_KEYWORD_BAD_DIR),
      /from-keyword-bad.*not allowed/,
    );
  });

  it("accepts import where from is used as binding name but specifier is synod/flow", async () => {
    const flows = await discoverFlows(FROM_KEYWORD_OK_DIR);
    assert.strictEqual(flows.length, 1);
  });

  it("accepts flow with bad import inside nested template ${} expression", async () => {
    const flows = await discoverFlows(TEMPLATE_NESTED_OK_DIR);
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].name, "template-nested-ok");
  });

  it("rejects side-effect import with comment before specifier (skipTrivia)", async () => {
    await assert.rejects(
      () => discoverFlows(IMPORT_COMMENT_BAD_DIR),
      /import-comment-bad.*not allowed/,
    );
  });

  it("rejects import where comment precedes specifier after from (skipTrivia)", async () => {
    await assert.rejects(
      () => discoverFlows(FROM_COMMENT_BAD_DIR),
      /from-comment-bad.*not allowed/,
    );
  });

  it("rejects static re-export of disallowed module (export * from)", async () => {
    await assert.rejects(
      () => discoverFlows(EXPORT_STAR_BAD_DIR),
      /export-star-bad.*not allowed/,
    );
  });

  it("rejects bad import after local export { … } (extractExportSpec stops at statement boundary)", async () => {
    await assert.rejects(
      () => discoverFlows(EXPORT_LOCAL_THEN_BAD_DIR),
      /export-local-then-bad.*not allowed/,
    );
  });

  it("accepts valid synod/flow import after local export { … } (statement boundary does not block)", async () => {
    const flows = await discoverFlows(EXPORT_LOCAL_THEN_OK_DIR);
    assert.strictEqual(flows.length, 1);
  });
});

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntime } from "../src/flow/runtime.mjs";
import { runFlow } from "../src/flow/runner.mjs";
import { loadFlow } from "../src/flow/loader.mjs";
import { fakeOpenBackend } from "./helpers/fake-backend.mjs";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "workflows",
);

const NESTING_ROOT = resolve(FIXTURES_ROOT, "nesting");

function memoryFs() {
  const files = new Map();
  return {
    async writeFile(path, content) { files.set(path, content); },
    async appendFile(path, content) {
      files.set(path, (files.get(path) ?? "") + content);
    },
    get(path) { return files.get(path); },
  };
}

function parseLog(fs) {
  const raw = fs.get("run.log.jsonl") ?? "";
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function makeRt(overrides = {}) {
  return createRuntime({
    fs: overrides.fs ?? memoryFs(),
    clock: () => 0,
    workflowsRoot: NESTING_ROOT,
    maxDepth: overrides.maxDepth ?? 5,
    maxActiveSubRuns: overrides.maxActiveSubRuns ?? 1,
    openBackend: overrides.openBackend ??
      (async (opts) => fakeOpenBackend({ ...opts, deltas: [`reply-from-${opts.agent}`] })),
  });
}

describe("runWorkflow nesting", () => {
  let runtime;

  before(() => {
    runtime = makeRt();
  });

  // ── 1. parent calls child and uses return value ───────────────────
  it("parent calls child via runWorkflow and uses child's return value", async () => {
    const parentPath = resolve(NESTING_ROOT, "parent-calls-child.mjs");
    const parentModule = await import(pathToFileURL(parentPath).href);
    const ctx = runtime.createCtx({});
    const result = await runFlow(runtime, parentModule, ctx, { message: "hi" });

    assert.ok(result.summary.includes("reply-from-codex"));
    assert.ok(result.childEchoed.includes("reply-from-omp"));
  });

  // ── 2a. child log entries carry parentRunId ───────────────────────
  it("child step/session log entries carry parentRunId", async () => {
    const fs = memoryFs();
    const rt = makeRt({ fs });
    const parentPath = resolve(NESTING_ROOT, "parent-calls-child.mjs");
    const parentModule = await import(pathToFileURL(parentPath).href);
    const ctx = rt.createCtx({});
    await runFlow(rt, parentModule, ctx, { message: "log-test" });

    const log = parseLog(fs);
    const childSteps = log.filter(
      (e) => e.event === "step:succeeded" && e.parentRunId === ctx.runId,
    );
    assert.ok(childSteps.length > 0, "child steps should carry parentRunId");

    for (const step of childSteps) {
      assert.ok(typeof step.parentRunId === "string" && step.parentRunId.length > 0);
      assert.notStrictEqual(step.parentRunId, step.runId, "parentRunId ≠ child runId");
      assert.strictEqual(step.parentRunId, ctx.runId);
    }

    const childSessions = log.filter(
      (e) => (e.event === "session:open" || e.event === "session:close") &&
        e.parentRunId === ctx.runId,
    );
    assert.ok(childSessions.length > 0, "child session events carry parentRunId");
  });

  // ── 2b. root run has NO parentRunId on any log entry ──────────────
  it("root run (no parent) log entries do NOT contain parentRunId", async () => {
    const fs = memoryFs();
    const rt = makeRt({ fs });
    const childPath = resolve(NESTING_ROOT, "child-echo.mjs");
    const mod = await import(pathToFileURL(childPath).href);
    const ctx = rt.createCtx({});
    await runFlow(rt, mod, ctx, { message: "root" });

    const log = parseLog(fs);
    const withParent = log.filter((e) => e.parentRunId !== undefined);
    assert.strictEqual(withParent.length, 0,
      `root run should have zero entries with parentRunId, found: ${JSON.stringify(withParent)}`);
  });

  // ── 3. depth exceeds maxDepth → throw ────────────────────────────
  it("throws when nesting depth exceeds maxDepth", async () => {
    const rt = makeRt({ maxDepth: 2, maxActiveSubRuns: 10 });
    const chainPath = resolve(NESTING_ROOT, "deep-chain.mjs");
    const mod = await import(pathToFileURL(chainPath).href);
    const ctx = rt.createCtx({});

    await assert.rejects(
      () => runFlow(rt, mod, ctx, { maxDepth: 99 }),
      (err) => {
        assert.ok(err.message.includes("nesting depth") ||
          err.message.includes("depth limit"),
          `expected depth error, got: ${err.message}`);
        return true;
      },
    );
  });

  // ── 4. maxActiveSubRuns:0 forbids any child ───────────────────────
  it("rejects when maxActiveSubRuns is 0", async () => {
    const rt = makeRt({ maxActiveSubRuns: 0 });
    const parentPath = resolve(NESTING_ROOT, "parent-calls-child.mjs");
    const mod = await import(pathToFileURL(parentPath).href);
    const ctx = rt.createCtx({});

    await assert.rejects(
      () => runFlow(rt, mod, ctx, { message: "test" }),
      (err) => {
        assert.ok(err.message.includes("active") ||
          err.message.includes("sub-run"),
          `expected active sub-run error, got: ${err.message}`);
        return true;
      },
    );
  });

  // ── 5. sequential calls succeed (counter resets per call) ────────
  it("sequential runWorkflow calls succeed when each completes before next", async () => {
    const rt = makeRt({ maxActiveSubRuns: 1 });
    const twoChildFlow = {
      async run(ctx, _input) {
        const { runWorkflow } = await import("synod/flow");
        const a = await runWorkflow(ctx, "./sibling-a", { label: "first" });
        const b = await runWorkflow(ctx, "./sibling-b", { label: "second" });
        return { a, b };
      },
    };

    const ctx = rt.createCtx({});
    const result = await runFlow(rt, twoChildFlow, ctx, {});
    assert.strictEqual(result.a.from, "a");
    assert.strictEqual(result.b.from, "b");
  });

  // ── 6. cwd inheritance — child bash pwd matches parent cwd ───────
  it("child inherits parent cwd (bash pwd matches parent cwd)", async () => {
    const rt = makeRt({ maxActiveSubRuns: 1 });
    const parentCwd = NESTING_ROOT;

    const parentFlow = {
      async run(ctx, _input) {
        const { runWorkflow } = await import("synod/flow");
        return await runWorkflow(ctx, "./child-bash", {
          cmd: 'node -e "process.stdout.write(process.cwd())"',
        });
      },
    };

    const ctx = rt.createCtx({}, { cwd: parentCwd });
    const result = await runFlow(rt, parentFlow, ctx, {});

    assert.strictEqual(result.result.code, 0);
    assert.strictEqual(result.result.stdout.trim(), parentCwd,
      `child pwd should be ${parentCwd}, got: ${result.result.stdout.trim()}`);
  });

  // ── 7. cwd inheritance — child agent receives parent cwd ──────────
  it("child agent call receives parent cwd via openBackend opts", async () => {
    let capturedCwd = null;
    const rt = makeRt({
      maxActiveSubRuns: 1,
      openBackend: async (opts) => {
        capturedCwd = opts.cwd;
        return fakeOpenBackend({ ...opts, deltas: [`ok`] });
      },
    });

    const parentCwd = NESTING_ROOT;
    const parentFlow = {
      async run(ctx, _input) {
        const { runWorkflow } = await import("synod/flow");
        return await runWorkflow(ctx, "./child-echo", { message: "cwd-test" });
      },
    };

    const ctx = rt.createCtx({}, { cwd: parentCwd });
    await runFlow(rt, parentFlow, ctx, {});
    assert.strictEqual(capturedCwd, parentCwd,
      `child agent should receive parent cwd ${parentCwd}, got: ${capturedCwd}`);
  });

  // ── 8. race — maxActiveSubRuns:1, Promise.all of 2 → one rejects ──
  it("concurrent children with maxActiveSubRuns:1 — one rejects", async () => {
    const rt = makeRt({ maxActiveSubRuns: 1 });

    const concurrentParent = {
      async run(ctx, _input) {
        const { runWorkflow } = await import("synod/flow");
        const results = await Promise.allSettled([
          runWorkflow(ctx, "./sibling-a", { label: "concurrent-1" }),
          runWorkflow(ctx, "./sibling-b", { label: "concurrent-2" }),
        ]);
        return results;
      },
    };

    const ctx = rt.createCtx({});
    const results = await runFlow(rt, concurrentParent, ctx, {});

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.strictEqual(fulfilled.length, 1,
      `expected exactly 1 fulfilled, got ${fulfilled.length}`);
    assert.strictEqual(rejected.length, 1,
      `expected exactly 1 rejected, got ${rejected.length}`);
    assert.ok(
      rejected[0].reason.message.includes("active") ||
        rejected[0].reason.message.includes("sub-run"),
      `rejection should mention active sub-run: ${rejected[0].reason.message}`,
    );
  });

  // ── 9. race — maxActiveSubRuns:2, Promise.all of 2 → both succeed ──
  it("concurrent children with maxActiveSubRuns:2 — both succeed", async () => {
    const rt = makeRt({ maxActiveSubRuns: 2 });

    const concurrentParent = {
      async run(ctx, _input) {
        const { runWorkflow } = await import("synod/flow");
        const [a, b] = await Promise.all([
          runWorkflow(ctx, "./sibling-a", { label: "parallel-a" }),
          runWorkflow(ctx, "./sibling-b", { label: "parallel-b" }),
        ]);
        return { a, b };
      },
    };

    const ctx = rt.createCtx({});
    const result = await runFlow(rt, concurrentParent, ctx, {});
    assert.strictEqual(result.a.from, "a");
    assert.strictEqual(result.b.from, "b");
  });

  // ── 10. counter released on child failure → next child succeeds ───
  it("counter released when child throws; subsequent child succeeds", async () => {
    const rt = makeRt({ maxActiveSubRuns: 1 });

    const parentFlow = {
      async run(ctx, _input) {
        const { runWorkflow } = await import("synod/flow");
        // First call: loadFlow fails → counter should release in finally
        try {
          await runWorkflow(ctx, "./nonexistent-flow", {});
        } catch (_) { /* expected */ }

        // Second call: should succeed since counter was released
        const result = await runWorkflow(ctx, "./sibling-a", { label: "after-fail" });
        return result;
      },
    };

    const ctx = rt.createCtx({});
    const result = await runFlow(rt, parentFlow, ctx, {});
    assert.strictEqual(result.from, "a",
      "second child should succeed after first child's loadFlow failed");
  });

  // ── 11. per-parent counters are independent ──────────────────────
  it("per-parent active sub-run counters are independent", async () => {
    const rt = makeRt({ maxActiveSubRuns: 1 });

    // A flow that calls runWorkflow itself (spawns grandchild).
    // The parent ctx.runId differs from this flow's ctx.runId,
    // so counters are independent.
    const childThatNests = {
      async run(ctx, _input) {
        const { runWorkflow } = await import("synod/flow");
        const gc = await runWorkflow(ctx, "./child-echo", { message: "grandchild" });
        return gc;
      },
    };

    const ctx = rt.createCtx({});
    const result = await runFlow(rt, childThatNests, ctx, {});
    assert.ok(result.echoed.includes("reply-from-omp"),
      "grandchild should succeed with independent per-parent counter");
  });

  // ── 12. loadFlow rejects path escape (../ traversal) ─────────────
  it("loadFlow rejects refs that escape workflowsRoot via ../", async () => {
    await assert.rejects(
      () => loadFlow(NESTING_ROOT, "../valid/linear"),
      (err) => {
        assert.ok(err.message.includes("escape") ||
          err.message.includes("outside"),
          `expected path-escape error, got: ${err.message}`);
        return true;
      },
    );
  });

  // ── 13. loadFlow rejects absolute paths ──────────────────────────
  it("loadFlow rejects absolute path refs", async () => {
    await assert.rejects(
      () => loadFlow(NESTING_ROOT, "/etc/passwd"),
      (err) => {
        assert.ok(err.message.includes("absolute") ||
          err.message.includes("not allowed"),
          `expected absolute-path error, got: ${err.message}`);
        return true;
      },
    );
  });

  // ── 14. loadFlow accepts valid relative refs (with ./ prefix) ────
  it("loadFlow accepts valid refs within workflowsRoot", async () => {
    const flow = await loadFlow(NESTING_ROOT, "./child-echo");
    assert.strictEqual(typeof flow.run, "function");
    assert.strictEqual(flow.name, "child-echo");
  });

  // ── 15. loadFlow accepts ref without ./ prefix ───────────────────
  it("loadFlow accepts ref without leading ./", async () => {
    const flow = await loadFlow(NESTING_ROOT, "sibling-a");
    assert.strictEqual(flow.name, "sibling-a");
    assert.strictEqual(typeof flow.run, "function");
  });

  // ── 16. realpath symlink escape — link inside root → outside ────
  it("loadFlow rejects symlink that escapes workflowsRoot (realpath guard)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "synod-nesting-"));
    const outsideDir = join(tmpDir, "outside");
    const rootDir = join(tmpDir, "root");

    try {
      await mkdir(outsideDir, { recursive: true });
      await mkdir(rootDir, { recursive: true });

      // Create a valid-looking flow outside the root
      await writeFile(
        join(outsideDir, "escape.mjs"),
        [
          'import { agent } from "synod/flow";',
          "export const meta = { description: 'escaped' };",
          "export async function run() { return 'escaped'; }",
        ].join("\n"),
      );

      // Create symlink inside root pointing to the outside file
      try {
        await symlink(
          join(outsideDir, "escape.mjs"),
          join(rootDir, "link.mjs"),
        );
      } catch (err) {
        if (err.code === "EPERM" || err.code === "ENOSYS" || err.code === "ENOENT") {
          // Symlinks not supported on this platform — skip gracefully
          return;
        }
        throw err;
      }

      // loadFlow should detect the realpath escape
      await assert.rejects(
        () => loadFlow(rootDir, "./link"),
        (err) => {
          assert.ok(
            err.message.includes("escape") ||
              err.message.includes("outside"),
            `expected path-escape error, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

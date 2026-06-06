#!/usr/bin/env node
// scripts/acceptance.mjs — End-to-end acceptance tests (require real omp/codex).
//
// Usage: node scripts/acceptance.mjs
//
// Runs A1–A5 from docs/PROTOTYPE.md §7.  Skips tests when the required agent is
// not installed; CI without agents exits 0.  Any genuine failure → non-zero exit.

import { spawn, spawnSync } from "node:child_process";
import { doctor } from "../src/backend.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "src", "cli.mjs");
const NODE = process.execPath;

const passed = [];
const failed = [];
const skipped = [];

function pass(name) {
  console.log(`  PASS  ${name}`);
  passed.push(name);
}
function fail(name, reason) {
  console.log(`  FAIL  ${name} — ${reason}`);
  failed.push(name);
}
function skip(name, reason) {
  console.log(`  SKIP  ${name} — ${reason}`);
  skipped.push(name);
}

// ── helpers ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run the CLI with args, feed lines to stdin, collect stdout/stderr. */
function runCli(args, { inputLines = [], timeoutMs = 120_000, envExtra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envExtra },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code, signal });
    });

    // Feed input lines one by one, waiting for prompt between steps
    (async () => {
      try {
        const promptState = { promptCount: 0 };
        await _waitForPrompt(() => stdout, promptState, 15_000);
        for (const step of inputLines) {
          if (step.delay) await sleep(step.delay);
          if (step.text !== undefined) {
            child.stdin.write(step.text + "\n");
          }
          if (step.waitForPrompt) {
            await _waitForPrompt(() => stdout, promptState, 30_000);
          }
        }
      } catch {
        // If feeding fails (e.g., timeout), let the close handler resolve
      }
    })();
  });
}


/**
 * Wait for a *new* "> " prompt beyond the already-consumed count.
 * @param {()=>string} getStdout — function returning current stdout
 * @param {{promptCount:number}} state — mutable counter, updated in-place
 * @param {number} [timeoutMs=30_000]
 */
async function _waitForPrompt(getStdout, state, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = getStdout();
    const count = (val.match(/> /g) || []).length;
    if (count > state.promptCount) {
      state.promptCount = count;
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for prompt #${state.promptCount + 1}`);
}

/** Returns Set of PIDs matching omp/codex agent patterns. */
function getAgentPids() {
  const pids = new Set();
  const patterns =
    process.platform === "win32"
      ? [] // tasklist approach not needed for POSIX acceptance
      : ["omp --mode rpc", "codex app-server"];
  for (const pat of patterns) {
    const r = spawnSync("pgrep", ["-f", pat], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      r.stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .forEach((p) => pids.add(Number(p)));
    }
  }
  return pids;
}

async function assertNoNewResidue(before, label) {
  await sleep(500);
  const after = getAgentPids();
  const fresh = [...after].filter((p) => !before.has(p));
  if (fresh.length > 0) {
    fail(`${label} residue`, `new agent PIDs: ${fresh.join(", ")}`);
  } else {
    pass(`${label} no residue`);
  }
}

// ── tests ──────────────────────────────────────────────────────────────

async function test_A1(ompOk) {
  console.log("\n── A1  single session, streaming output ──");
  if (!ompOk) {
    skip("A1", "omp not available");
    return;
  }

  const before = getAgentPids();
  let result;
  try {
    result = await runCli(["--agent", "omp"], {
      inputLines: [
        { text: "reply with exactly: OK A1", waitForPrompt: true },
        { text: "/exit" },
      ],
      timeoutMs: 60_000,
    });
  } catch (err) {
    fail("A1", `CLI error: ${err.message}`);
    return;
  }

  // Must have streaming output (deltas before prompt redraws)
  const hasLabelLine = /\[omp#\d+\]/.test(result.stdout);
  if (!hasLabelLine) {
    fail("A1 streaming", "no label-prefixed streaming output in stdout");
  } else {
    pass("A1 streaming output present");
  }

  if (result.code !== 0) {
    fail("A1 exit", `exit code ${result.code}, expected 0`);
  } else {
    pass("A1 clean exit");
  }

  await assertNoNewResidue(before, "A1");
}

async function test_A2(ompOk, codexOk) {
  console.log("\n── A2  two agents, parallel tasks ──");
  if (!ompOk || !codexOk) {
    skip("A2", `need omp + codex (omp=${ompOk} codex=${codexOk})`);
    return;
  }

  const before = getAgentPids();

  // Distinctive prompts that force each agent to emit a unique marker word.
  // This makes cross-talk trivially detectable: OCEAN must only appear in
  // [omp#N] prefixed lines, FOREST only in [codex#N] lines.
  const result = await runCli(
    [
      "--task",
      "omp:reply with exactly one sentence that includes the word OCEAN",
      "--task",
      "codex:reply with exactly one sentence that includes the word FOREST",
    ],
    { timeoutMs: 120_000 },
  );

  const out = result.stdout;

  // Split output at the Summary divider so summary lines don't contaminate
  // streaming-line checks.  Everything before "── Summary ──" is the streaming
  // section; the divider and everything after is the summary section.
  const summaryIdx = out.indexOf("── Summary ──");
  const streamingSection = summaryIdx >= 0 ? out.slice(0, summaryIdx) : out;
  const summarySection = summaryIdx >= 0 ? out.slice(summaryIdx) : "";

  // (a) At least one streaming line (label-prefixed, not summary) per agent
  const ompLines = streamingSection.split("\n").filter((l) => /\[omp#\d+\]/.test(l));
  const codexLines = streamingSection.split("\n").filter((l) => /\[codex#\d+\]/.test(l));
  if (ompLines.length > 0) pass("A2 [omp#N] streaming lines");
  else fail("A2 [omp#N] streaming lines", "none found");
  if (codexLines.length > 0) pass("A2 [codex#N] streaming lines");
  else fail("A2 [codex#N] streaming lines", "none found");

  // (b) Positive: each agent's marker word appears in at least one of its
  //     own streaming lines.  This proves streaming actually delivered
  //     content — not just empty labels or summary-only mentions.
  const ompHasOcean = ompLines.some((l) => /OCEAN/i.test(l));
  const codexHasForest = codexLines.some((l) => /FOREST/i.test(l));
  if (ompHasOcean) pass("A2 OCEAN in [omp#N] streaming line");
  else fail("A2 OCEAN in [omp#N] streaming line", "OCEAN not found in any omp streaming line");
  if (codexHasForest) pass("A2 FOREST in [codex#N] streaming line");
  else fail("A2 FOREST in [codex#N] streaming line", "FOREST not found in any codex streaming line");

  // (c) Reverse: no cross-talk — OCEAN only in omp lines, FOREST only in
  //     codex lines; no streaming line contains both markers.
  let crossTalk = false;
  for (const line of ompLines) {
    if (/FOREST/i.test(line)) { crossTalk = true; break; }
  }
  for (const line of codexLines) {
    if (/OCEAN/i.test(line)) { crossTalk = true; break; }
  }
  for (const line of streamingSection.split("\n")) {
    if (/OCEAN/i.test(line) && /FOREST/i.test(line)) { crossTalk = true; break; }
  }
  if (!crossTalk) pass("A2 no cross-talk (marker isolation)");
  else fail("A2 cross-talk", "marker word appeared in wrong agent's lines or co-occurred");

  // (d) Summary section, exit 0, no residue
  if (summarySection.includes("── Summary ──")) pass("A2 summary section");
  else fail("A2 summary section", "missing");

  if (result.code === 0) pass("A2 exit 0");
  else fail("A2 exit", `exit code ${result.code}`);

  await assertNoNewResidue(before, "A2");
}

async function test_A3(ompOk) {
  console.log("\n── A3  same session, two messages ──");
  if (!ompOk) {
    skip("A3", "omp not available");
    return;
  }

  const before = getAgentPids();
  let result;
  try {
    result = await runCli(["--agent", "omp"], {
      inputLines: [
        { text: "reply with exactly: FIRST", waitForPrompt: true },
        { text: "reply with exactly: SECOND", waitForPrompt: true },
        { text: "/exit" },
      ],
      timeoutMs: 90_000,
    });
  } catch (err) {
    fail("A3", `CLI error: ${err.message}`);
    return;
  }

  // Count how many times we see streaming output blocks (label-prefixed lines after "> " vanishes)
  const labelLines = result.stdout
    .split("\n")
    .filter((l) => /\[omp#\d+\]/.test(l));
  // We sent two messages; each should produce some output lines
  if (labelLines.length >= 2) {
    pass("A3 both messages got responses");
  } else {
    fail("A3 responses", `only ${labelLines.length} label-prefixed lines`);
  }

  if (result.code === 0) pass("A3 exit 0");
  else fail("A3 exit", `code ${result.code}`);

  await assertNoNewResidue(before, "A3");
}

async function test_A4_omp_bin() {
  console.log("\n── A4a OMP_BIN=/nonexistent → non-zero exit ──");

  const before = getAgentPids();

  const result = await runCli(["--agent", "omp"], {
    envExtra: { OMP_BIN: "/nonexistent" },
    timeoutMs: 10_000,
  });

  // The doctor gate should catch this and exit non-zero
  if (result.code !== 0) pass("A4a non-zero exit");
  else fail("A4a exit", `expected non-zero, got ${result.code}`);

  await assertNoNewResidue(before, "A4a");
}

async function test_A4_sigint(ompOk) {
  console.log("\n── A4b SIGINT during streaming → clean exit ──");
  if (!ompOk) {
    skip("A4b", "omp not available");
    return;
  }

  const before = getAgentPids();

  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, "--agent", "omp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const closeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      fail("A4b", "timeout");
      resolve();
    }, 30_000);

    child.on("close", async (code, signal) => {
      clearTimeout(closeTimer);
      if (settled) return;
      settled = true;

      // (b) Must have "Interrupted. Cleaning up..." (stderr from SIGINT handler)
      if (stderr.includes("Interrupted. Cleaning up...")) {
        pass("A4b interrupted message");
      } else {
        fail("A4b interrupted message", "missing 'Interrupted. Cleaning up...' in stderr");
      }

      // SIGINT handler in cli.mjs calls process.exit(0) after cleanup,
      // so exit should be clean: code 0, no signal.
      if (code === 0 && signal === null) {
        pass("A4b clean exit (code 0)");
      } else {
        fail("A4b exit", `code=${code} signal=${signal}, expected code=0 signal=null`);
      }

      // (c) No residue
      await assertNoNewResidue(before, "A4b");
      resolve();
    });

    // (a) Wait for prompt, send prompt, then confirm streaming actually started
    //     before sending SIGINT
    (async () => {
      try {
        // Wait for initial prompt
        let waited = 0;
        while (waited < 15_000 && !stdout.includes("> ")) {
          await sleep(200);
          waited += 200;
        }
        if (!stdout.includes("> ")) {
          fail("A4b", "prompt never appeared");
          child.kill("SIGKILL");
          resolve();  // settled check in close handler prevents double-resolve
          return;
        }

        // Long multi-line request so the first [omp#N] streaming line reliably
        // arrives while the turn is still in progress, not at turn-end flush.
        // Black-box limitation: we cannot 100% prove SIGINT lands mid-turn, but
        // a 30+ line output makes the first label line highly likely to fall
        // during active generation.  Turn-internal state is unobservable by
        // design — this is the strongest check achievable without white-box hooks.
        child.stdin.write("write a poem about programming with at least 30 lines, each line a short phrase, no blank lines\n");
        // Wait for streaming to actually start (first [omp#N] line)
        waited = 0;
        while (waited < 20_000 && !/\[omp#\d+\]/.test(stdout)) {
          await sleep(200);
          waited += 200;
        }
        if (!/\[omp#\d+\]/.test(stdout)) {
          fail("A4b", "streaming never started before SIGINT");
          child.kill("SIGKILL");
          resolve();
          return;
        }

        // Now send SIGINT — we know streaming is active
        child.kill("SIGINT");
      } catch {
        child.kill("SIGKILL");
      }
    })();
  });
}

// A5 is a CLI plumbing smoke test: it verifies model/effort appear in the
// summary output.  Real argv passthrough (--model / --thinking reaching the
// omp subprocess) is covered by the contract test
// "passes --model and --thinking to omp spawn argv" in
// test/backend.contract.test.mjs.
async function test_A5(ompOk) {
  console.log("\n── A5  --model / --effort passed through ──");
  if (!ompOk) {
    skip("A5", "omp not available");
    return;
  }

  const before = getAgentPids();

  const MODEL = "minimax-code-cn/MiniMax-M3";
  const EFFORT = "high";

  const result = await runCli(
    ["--model", MODEL, "--effort", EFFORT, "--task", `omp:reply OK`],
    { timeoutMs: 60_000 },
  );

  // The summary line now includes model and effort (see cli.mjs line 400)
  const out = result.stdout;
  const modelOk = out.includes(MODEL);
  const effortOk = out.includes(`effort=${EFFORT}`);

  if (modelOk) pass("A5 model in summary");
  else fail("A5 model", `"${MODEL}" not found in output`);

  if (effortOk) pass("A5 effort in summary");
  else fail("A5 effort", `"effort=${EFFORT}" not found in output`);

  if (result.code === 0) pass("A5 exit 0");
  else fail("A5 exit", `code ${result.code}`);

  await assertNoNewResidue(before, "A5");
}

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  console.log("Synod acceptance tests\n");

  const availability = doctor();
  const ompOk = availability.omp?.available === true;
  const codexOk = availability.codex?.available === true;

  console.log(`omp:   ${ompOk ? "available" + (availability.omp.version ? ` (${availability.omp.version})` : "") : "NOT FOUND"}`);
  console.log(`codex: ${codexOk ? "available" + (availability.codex.version ? ` (${availability.codex.version})` : "") : "NOT FOUND"}`);

  if (!ompOk && !codexOk) {
    console.log("\nNo agents available — nothing to test. Exit 0 (not a failure).");
    process.exit(0);
  }

  await test_A1(ompOk);
  await test_A2(ompOk, codexOk);
  await test_A3(ompOk);
  await test_A4_omp_bin();
  await test_A4_sigint(ompOk);
  await test_A5(ompOk);

  // ── summary ──
  console.log(`\n═══════════════════════════════════`);
  console.log(`  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  console.log(`═══════════════════════════════════`);

  if (failed.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failed) console.log(`  ✖ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});

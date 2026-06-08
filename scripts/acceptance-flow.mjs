#!/usr/bin/env node
/**
 * scripts/acceptance-flow.mjs — Flow engine end-to-end acceptance tests.
 *
 * Usage:  node scripts/acceptance-flow.mjs
 *
 * Hardened assertions (codex review F7):
 *   FA1: exact description match
 *   FA2: session open/close paired, omp session, stepId matching
 *   FA3: passed=false⇒attempts=maxTurns, codex session, produce/review align
 *   FA4: feedback text in approve output and agent input, fail-fast on timeout
 *   FA5: child.received exact value, same parentRunId, root lacks it
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctor } from "../src/backend.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FLOW_CLI = path.resolve(ROOT, "src", "flow.mjs");
const NODE = process.execPath;
const FIXTURES_VALID = path.resolve(ROOT, "fixtures", "workflows", "valid");
const WORKFLOWS_DIR = path.resolve(ROOT, "workflows");
const LOG_PATH = path.resolve(ROOT, "run.log.jsonl");
const ARTIFACTS_DIR = path.resolve(ROOT, "artifacts");

const passed = [];
const failed = [];
const skipped = [];

function pass(name) { console.log(`  PASS  ${name}`); passed.push(name); }
function fail(name, reason) { console.log(`  FAIL  ${name} — ${reason}`); failed.push(name); }
function skip(name, reason) { console.log(`  SKIP  ${name} — ${reason}`); skipped.push(name); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _waitForOutput(getStdout, pattern, timeoutMs, n = 1) {
  const start = Date.now();
  while (true) {
    const text = getStdout();
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");
    const count = (text.match(re) || []).length;
    if (count >= n) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`_waitForOutput: timeout for "${pattern}" (${count}/${n})`);
    }
    await sleep(200);
  }
}

function runFlowCli(args, { inputLines = [], timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [FLOW_CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"], env: process.env, cwd: ROOT,
    });
    let stdout = "", stderr = "", settled = false;
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      if (settled) return; settled = true; child.kill("SIGTERM");
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer); if (settled) return; settled = true;
      resolve({ stdout, stderr, code, signal });
    });
    (async () => {
      try {
        for (const line of inputLines) {
          if (line.delay) await sleep(line.delay);
          if (line.waitForPrompt) await _waitForOutput(() => stdout, line.waitForPrompt, 120_000, line.waitForNth ?? 1);
          child.stdin.write(line.text + "\n");
          await sleep(100);
        }
      } catch (err) {
        if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
        if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGTERM"); reject(err); }
      }
    })();
  });
}

async function cleanLog() {
  try { await fs.unlink(LOG_PATH); } catch {}
  try { await fs.rm(ARTIFACTS_DIR, { recursive: true, force: true }); } catch {}
}

async function readLogLines() {
  try { const r = await fs.readFile(LOG_PATH, "utf-8"); return r.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

function extractLastJson(text) {
  const ci = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (ci === -1) throw new Error("no JSON");
  const isB = text[ci] === "}", oc = isB ? "{" : "[", cc = isB ? "}" : "]";
  let d = 0, s = false, e = false;
  for (let i = ci; i >= 0; i--) {
    const c = text[i];
    if (e) { e = false; continue; }
    if (c === "\\" && s) { e = true; continue; }
    if (c === '"') { s = !s; continue; }
    if (s) continue;
    if (c === cc) d++; else if (c === oc) { d--; if (d === 0) return JSON.parse(text.slice(i, ci + 1)); }
  }
  throw new Error("unbalanced JSON");
}

// ═══════════════════════════════════════════════════════════════════════════
// FA1: --list (pure, no agent, always runs)
// ═══════════════════════════════════════════════════════════════════════════

async function test_FA1() {
  console.log("\nFA1: --list (pure, no agent)");

  const r1 = await runFlowCli(["--list", "--workflows", FIXTURES_VALID], { timeoutMs: 10_000 });
  if (r1.code !== 0) { fail("FA1", `exit ${r1.code}: ${r1.stderr}`); return; }
  const lines = r1.stdout.trim().split("\n").filter(Boolean);
  const ll = lines.find((l) => l.startsWith("linear:"));
  if (!ll) { fail("FA1", "linear not listed"); return; }
  if (ll !== "linear: Linear 3-node: agent → bash → agent") { fail("FA1", `bad desc: "${ll}"`); return; }

  const r2 = await runFlowCli(["--list", "--workflows", WORKFLOWS_DIR], { timeoutMs: 10_000 });
  if (r2.code !== 0) { fail("FA1 real", `exit ${r2.code}: ${r2.stderr}`); return; }
  const rlines = r2.stdout.trim().split("\n").filter(Boolean);
  const expected = {
    "hello": "Simple linear: call omp, return response",
    "backtrack-demo": "Backtrack: produce with omp, review with codex, retry on fail",
    "revise-demo": "Revise with human: draft → feedback → accept",
    "child-echo": "Child: echo input via omp",
    "parent": "Parent: calls child workflow and returns its result",
  };
  for (const [name, desc] of Object.entries(expected)) {
    const line = rlines.find((l) => l.startsWith(name + ":"));
    if (!line) { fail("FA1 real", `missing ${name}`); return; }
    if (line !== `${name}: ${desc}`) { fail("FA1 real", `bad desc for ${name}: "${line}"`); return; }
  }
  pass("FA1");
}

// ═══════════════════════════════════════════════════════════════════════════
// FA2: linear flow + real omp
// ═══════════════════════════════════════════════════════════════════════════

async function test_FA2(ompOk) {
  console.log("\nFA2: linear flow + real omp");
  if (!ompOk) { skip("FA2", "omp unavailable"); return; }
  await cleanLog();

  const r = await runFlowCli(
    ["--workflows", WORKFLOWS_DIR, "hello", JSON.stringify({ prompt: "Say exactly: TEST-PASSED" })],
    { timeoutMs: 120_000 },
  );
  if (r.code !== 0) { fail("FA2", `exit ${r.code}: ${r.stderr.slice(0,300)}`); return; }
  let out;
  try { out = JSON.parse(r.stdout.trim()); } catch { fail("FA2", `bad JSON: ${r.stdout.slice(0,200)}`); return; }
  if (!out.response || typeof out.response !== "string" || !out.response) { fail("FA2", `bad output`); return; }

  const ll = await readLogLines();

  // session open/close paired by sessionId (exact set equality)
  const opens  = ll.filter((l) => l.event === "session:open");
  const closes = ll.filter((l) => l.event === "session:close");
  if (opens.length !== closes.length) { fail("FA2", `open/close count mismatch: ${opens.length}/${closes.length}`); return; }
  const openIds  = new Set(opens.map((l) => l.sessionId));
  const closeIds = new Set(closes.map((l) => l.sessionId));
  const missingClose = [...openIds].filter((id) => !closeIds.has(id));
  const missingOpen  = [...closeIds].filter((id) => !openIds.has(id));
  if (missingClose.length || missingOpen.length) {
    fail("FA2", `sessionId mismatch: missing close=${missingClose}, missing open=${missingOpen}`); return;
  }
  // at least one omp session
  if (!opens.some((l) => l.agent === "omp")) { fail("FA2", "no omp session"); return; }

  // step start/succeed share stepId
  const started   = ll.filter((l) => l.event === "step:started");
  const succeeded = ll.filter((l) => l.event === "step:succeeded");
  if (!started.length || !succeeded.length) { fail("FA2", "missing steps"); return; }
  const sIds = new Set(started.map((l) => l.stepId));
  const eIds = new Set(succeeded.map((l) => l.stepId));
  for (const id of sIds) { if (!eIds.has(id)) { fail("FA2", `step ${id} started without succeeded`); return; } }
  for (const id of eIds) { if (!sIds.has(id)) { fail("FA2", `step ${id} succeeded without started`); return; } }

  pass("FA2");
}

// ═══════════════════════════════════════════════════════════════════════════
// FA3: backtrack flow + real codex review
// ═══════════════════════════════════════════════════════════════════════════

async function test_FA3(codexOk, ompOk) {
  console.log("\nFA3: backtrack flow + codex review");
  if (!ompOk) { skip("FA3", "omp unavailable"); return; }
  if (!codexOk) { skip("FA3", "codex unavailable"); return; }
  await cleanLog();

  const r = await runFlowCli(
    ["--workflows", WORKFLOWS_DIR, "backtrack-demo", JSON.stringify({ topic: "testing" })],
    { timeoutMs: 180_000 },
  );
  if (r.code !== 0) { fail("FA3", `exit ${r.code}: ${r.stderr.slice(0,300)}`); return; }
  let out;
  try { out = JSON.parse(r.stdout.trim()); } catch { fail("FA3", `bad JSON`); return; }
  if (typeof out.attempts !== "number" || out.attempts < 1) { fail("FA3", `bad attempts`); return; }
  if (typeof out.passed !== "boolean") { fail("FA3", `bad passed`); return; }
  if (out.output == null) { fail("FA3", "no output"); return; }

  // Hardened: not passed ⇒ must have exhausted maxTurns (2)
  if (!out.passed && out.attempts !== 2) { fail("FA3", `not passed but attempts=${out.attempts} (expected 2)`); return; }
  // Hardened: passed on first try ⇒ attempts===1
  if (out.passed && out.attempts !== 1) { fail("FA3", `passed but attempts=${out.attempts} (expected 1)`); return; }

  const ll = await readLogLines();

  // Hardened: codex session must exist (the assertion was in comment but not code)
  if (!ll.some((l) => l.event === "session:open" && l.agent === "codex")) {
    fail("FA3", "no codex session in log (review never reached codex)"); return;
  }

  // Separate omp and codex agent step counts must each === attempts
  const ompSucceeded   = ll.filter((l) => l.event === "step:succeeded" && l.type === "agent" && l.agent === "omp");
  const codexSucceeded = ll.filter((l) => l.event === "step:succeeded" && l.type === "agent" && l.agent === "codex");
  if (ompSucceeded.length !== out.attempts) {
    fail("FA3", `omp agent steps=${ompSucceeded.length} != attempts=${out.attempts}`); return;
  }
  if (codexSucceeded.length !== out.attempts) {
    fail("FA3", `codex agent steps=${codexSucceeded.length} != attempts=${out.attempts}`); return;
  }

  pass("FA3");
 }

// ═══════════════════════════════════════════════════════════════════════════
// FA4: reviseWithHuman — scripted stdin end-to-end
// ═══════════════════════════════════════════════════════════════════════════

async function test_FA4(ompOk) {
  console.log("\nFA4: reviseWithHuman — scripted stdin");
  if (!ompOk) { skip("FA4", "omp unavailable"); return; }
  await cleanLog();

  const feedbackText = "Make it sound like a haiku about nature";

  // Wait for each approve prompt before writing the corresponding input line.
  // This ensures readline's question() listener is attached when we write.
  const r = await runFlowCli(
    ["--workflows", WORKFLOWS_DIR, "revise-demo"],
    {
      inputLines: [
        { text: feedbackText, waitForPrompt: "(accept / feedback / /abort):", waitForNth: 1 },
        { text: "accept",     waitForPrompt: "(accept / feedback / /abort):", waitForNth: 2 },
      ],
      timeoutMs: 180_000,
    },
  );
  if (r.code !== 0) { fail("FA4", `exit ${r.code}: ${r.stderr.slice(0,300)}`); return; }

  let out;
  try { out = extractLastJson(r.stdout); } catch { fail("FA4", `no JSON: ${r.stdout.slice(-200)}`); return; }
  if (!out.final || typeof out.final !== "string" || out.final.length < 5) { fail("FA4", `bad final`); return; }
  if (out.final === "The sky is blue.") { fail("FA4", "not revised"); return; }

  const ll = await readLogLines();
  const apOk = ll.filter((l) => l.event === "step:succeeded" && l.node === "approve");
  if (apOk.length < 2) { fail("FA4", `need >=2 approve succeeded, got ${apOk.length}`); return; }

  // First approve output must contain the feedback text (user's input line)
  if (!apOk[0].output || !apOk[0].output.includes(feedbackText)) {
    fail("FA4", `first approve output missing feedback "${feedbackText}"`); return;
  }

  // Agent steps have type:"agent" (not node:"agent")
  const agentStarted = ll.filter((l) => l.event === "step:started" && l.type === "agent");
  if (agentStarted.length === 0) {
    fail("FA4", "no agent steps (type=agent) — revision never happened"); return;
  }

  // Hardened: a subsequent agent step must have input containing the feedback
  const agentSucceeded = ll.filter((l) => l.event === "step:succeeded" && l.type === "agent");
  const agentWithFeedback = agentSucceeded.find((l) => l.input && l.input.includes(feedbackText));
  if (!agentWithFeedback) {
    fail("FA4", `no agent succeeded step with input containing feedback "${feedbackText}"`); return;
  }

  pass("FA4");
}

// ═══════════════════════════════════════════════════════════════════════════
// FA5: nested flow — parent calls child, verify parentRunId
// ═══════════════════════════════════════════════════════════════════════════

async function test_FA5(ompOk) {
  console.log("\nFA5: nested flow — parent calls child");
  if (!ompOk) { skip("FA5", "omp unavailable"); return; }
  await cleanLog();

  const r = await runFlowCli(["--workflows", WORKFLOWS_DIR, "parent"], { timeoutMs: 120_000 });
  if (r.code !== 0) { fail("FA5", `exit ${r.code}: ${r.stderr.slice(0,300)}`); return; }

  let out;
  try { out = JSON.parse(r.stdout.trim()); } catch { fail("FA5", `bad JSON`); return; }
  if (!out.fromChild) { fail("FA5", `no fromChild`); return; }

  // Hardened: child.received must be the exact input passed by parent
  if (out.fromChild.received !== "hello from parent") {
    fail("FA5", `child.received=${JSON.stringify(out.fromChild.received)} expected "hello from parent"`); return;
  }

  const ll = await readLogLines();
  const childEntries = ll.filter((l) => l.parentRunId);
  if (childEntries.length === 0) { fail("FA5", "no child entries with parentRunId"); return; }

  const parentRunId = childEntries[0].parentRunId;
  for (const e of childEntries) {
    if (e.parentRunId !== parentRunId) { fail("FA5", `inconsistent parentRunId: ${e.parentRunId} vs ${parentRunId}`); return; }
  }

  // Root entry: parent workflow now has bash("echo root-primitive") which
  // produces a root-level step:started/succeeded WITHOUT parentRunId.
  // Its runId must match the child's parentRunId.
  const rootEntry = ll.find((l) => !l.parentRunId && l.event === "step:started");
  if (!rootEntry) { fail("FA5", "no root-level step entry without parentRunId (parent bash missing?)"); return; }
  if (rootEntry.runId !== parentRunId) {
    fail("FA5", `root runId=${rootEntry.runId} != child parentRunId=${parentRunId}`); return;
  }

  // Child runId must differ from parentRunId
  const childStep = childEntries.find((l) => l.event === "step:started");
  if (!childStep) { fail("FA5", "no child step:started with parentRunId"); return; }
  if (childStep.runId === parentRunId) { fail("FA5", "child runId === parentRunId"); return; }

  pass("FA5");
 }

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("Flow engine acceptance tests\n");
  const a = doctor();
  const ompOk = a.omp?.available === true;
  const codexOk = a.codex?.available === true;
  console.log(`omp:   ${ompOk ? "available" + (a.omp.version ? ` (${a.omp.version})` : "") : "NOT FOUND"}`);
  console.log(`codex: ${codexOk ? "available" + (a.codex.version ? ` (${a.codex.version})` : "") : "NOT FOUND"}`);

  await test_FA1();
  await test_FA2(ompOk);
  await test_FA3(codexOk, ompOk);
  await test_FA4(ompOk);
  await test_FA5(ompOk);

  console.log(`\n═══════════════════════════════════`);
  console.log(`  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  console.log(`═══════════════════════════════════`);
  if (failed.length > 0) { console.log(`\nFailures:`); for (const f of failed) console.log(`  ✖ ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(2); });

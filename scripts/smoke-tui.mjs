#!/usr/bin/env node
// scripts/smoke-tui.mjs — real-wiring TUI smoke.
//
// Drives the ACTUAL startTui() (gate path → adapter registration → real Ink
// render → real keyboard → real store) with TTY-shaped streams and a fake omp
// session that emits the real `toolevent` shapes, then injects real keystroke
// bytes (↑ to select, Ctrl-E to expand) and asserts the rendered frames + store.
//
// What this proves: boot into full-screen TUI, user echo (❯), toolevent → tool
// card (collapsed 🔧), ↑ selects the card, Ctrl-E expands it (▾ + output), all
// through the same startTui/App/store/adapters the real app uses — including the
// attach-before-register lazy-resolution path (we attach BEFORE startTui registers
// the omp adapter, exactly like cli.mjs does).
//
// NOT a real OS pseudo-terminal (this sandbox has no controlling console, so
// winpty/node-pty can't allocate one). The final *visual* pass in a real terminal
// is a human step — see the manual checklist printed at the end.
//
// Usage: node scripts/smoke-tui.mjs   (exit 0 = pass, non-zero = fail)

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createStore } from "../src/ui/tui/store.mjs";
import { startTui } from "../src/ui/tui/index.mjs";

// Ink patches console.* into its render buffer (patchConsole:true), so we report
// via raw fd writes to keep the captured frames clean and our logs on the real tty.
const out = (s) => fs.writeSync(1, s + "\n");
const err = (s) => fs.writeSync(2, s + "\n");
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB0]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake TTY stdout that captures everything Ink writes (mirrors ink-testing-library's stream).
function makeStdout() {
  let buf = "";
  return {
    isTTY: true, columns: 120, rows: 40,
    write(d) { buf += String(d); return true; },
    on() {}, off() {}, once() {}, removeListener() {}, emit() {},
    frames: () => buf, text: () => stripAnsi(buf),
  };
}
// Fake TTY stdin mirroring ink-testing-library's Stdin: ink v6 reads input via the
// 'readable' event + stdin.read(), so write() must stash data, emit 'readable' then
// 'data', and read() must return+clear it. (Emitting only 'data' is silently ignored.)
function makeStdin() {
  const s = new EventEmitter();
  s.isTTY = true; s.data = null;
  s.setRawMode = () => {}; s.setEncoding = () => {};
  s.ref = () => {}; s.unref = () => {}; s.resume = () => {}; s.pause = () => {};
  s.read = () => { const d = s.data; s.data = null; return d; };
  s.write = (d) => { s.data = d; s.emit("readable"); s.emit("data", d); };
  return s;
}

const checks = [];
const ok = (name, cond) => { checks.push([name, !!cond]); out(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

async function main() {
  const stdout = makeStdout();
  const stdin = makeStdin();
  const store = createStore();

  // Fake omp session — same EventEmitter contract real backend uses.
  const session = new EventEmitter();
  session.abort = () => {};

  // ATTACH BEFORE startTui registers adapters — exactly the cli.mjs order that
  // exposed the freeze-at-attach bug. Lazy resolution must make this still work.
  store.attachSession("omp#1", session, "omp", { model: "deepseek-v4-pro" });

  const hintsCtx = { labels: () => ["omp#1"], flows: [], backends: () => ["omp"], profiles: () => [] };
  // dispatch mimics cli.mjs's echo: plain text → pushUser to the current session.
  const dispatchCalls = [];
  const dispatch = (line) => {
    dispatchCalls.push(line);
    if (line && !/^[/@$]/.test(line)) store.pushUser("omp#1", line);
    return { redraw: false };
  };

  const selects = [];
  const tui = await startTui({
    store, dispatch, hintsCtx, mesh: true,
    onSelect: (l) => selects.push(l), onCycle: () => {}, onInterrupt: () => { try { tui.unmount(); } catch {} },
    stdin, stdout,
  });

  await sleep(60); // first render

  // 1) Boot: full-screen TUI rendered with the focus label.
  ok("boot: TUI rendered with omp#1 focus", stdout.text().includes("omp#1"));

  // 2) User echo (❯) via dispatch → pushUser.
  store.pushUser("omp#1", "读 package.json 的 name");
  dispatch("读 package.json 的 name"); // (already pushed once; dispatch echoes plain text)
  await sleep(40);
  ok("user echo: ❯ line shows the typed message", /❯[\s\S]*读 package\.json 的 name/.test(stdout.text()));

  // 3) A streaming assistant turn + a tool call, via the real toolevent channel.
  session.emit("status", { status: "running", isStreaming: true });
  session.emit("delta", "好的,我来读文件。");
  session.emit("toolevent", { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: { path: "package.json" }, intent: "读文件" });
  session.emit("toolevent", { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ text: "line1-name\nline2\nline3" }] } });
  session.emit("status", { status: "idle", isStreaming: false });
  await sleep(60);

  const entriesAfter = store.getState().sessions["omp#1"].entries;
  const toolCard = entriesAfter.find((e) => e.type === "tool");
  ok("toolevent → tool entry created (read_file, done)", toolCard && toolCard.name === "read_file" && toolCard.status === "done");
  ok("assistant delta rendered", stdout.text().includes("好的,我来读文件"));
  ok("tool card rendered collapsed (🔧 read_file)", /🔧[\s\S]*read_file/.test(stdout.text()) && !stdout.text().includes("line1-name"));

  // 4a) Keystroke reaches App.useInput? Ctrl-O → dispatch("/open").
  const callsBefore = dispatchCalls.length;
  stdin.write("\x0f");
  await sleep(60);
  ok("Ctrl-O keystroke reaches App → dispatch('/open')", dispatchCalls.length > callsBefore && dispatchCalls.at(-1) === "/open");

  // 4) ↑ selects the tool card (real key bytes through Ink useInput).
  stdin.write("\x1b[A");
  await sleep(50);

  // 5) Ctrl-E expands the selected card.
  stdin.write("\x05");
  await sleep(60);

  const toolCard2 = store.getState().sessions["omp#1"].entries.find((e) => e.type === "tool");
  ok("Ctrl-E expanded the tool card (store.expanded=true)", toolCard2 && toolCard2.expanded === true);
  ok("expanded card renders ▾ + output content", stdout.text().includes("▾") && stdout.text().includes("line1-name"));

  // 6) Ctrl-E again collapses it.
  stdin.write("\x05");
  await sleep(50);
  const toolCard3 = store.getState().sessions["omp#1"].entries.find((e) => e.type === "tool");
  ok("Ctrl-E again collapses (store.expanded=false)", toolCard3 && toolCard3.expanded === false);

  // 7) 编排面包屑 + 后台"待你" + Ctrl-G 跳转(替代旧 C/D 折叠条)。
  // 7a) appendFence → 发起会话流里淡淡滚一行人话面包屑(瞬时,不再是底部折叠条)。
  store.appendFence("omp#1", { commands: [{ cmd: "/open --agent codex", result: "ok · session codex#1" }], feedbackSent: true });
  await sleep(40);
  ok("appendFence → 流内面包屑「开了 codex#1」", stdout.text().includes("开了 codex#1"));

  // 7b) 后台会话跑完一个 turn → 置 awaiting + 焦点流冒泡;状态栏"待你"计数 +1。
  const bg = new EventEmitter(); bg.abort = () => {};
  store.attachSession("omp#2", bg, "omp", {});   // 非焦点(焦点仍 omp#1)
  bg.emit("status", { status: "running", isStreaming: true });
  bg.emit("status", { status: "idle", isStreaming: false });
  await sleep(50);
  ok("后台 omp#2 turn 结束 → awaiting", store.getState().sessions["omp#2"].status === "awaiting");
  ok("焦点流冒泡「omp#2 跑完了 · ^G 去看」", stdout.text().includes("omp#2 跑完了") && stdout.text().includes("去看"));
  ok("状态栏待你计数显示「1 待你」", stdout.text().includes("1 待你"));

  // 7c) Ctrl-G 跳到 awaiting 的后台 agent(经 onSelect,不再是展开 C)。
  stdin.write("\x07");  // Ctrl-G
  await sleep(50);
  ok("Ctrl-G → onSelect(omp#2)(跳到待你,不再展开 C)", selects.at(-1) === "omp#2");

  // 8) flow-in-TUI:假 flowMain 驱动 progress sink + 一次 io.question,经真 store/render 走通。
  const { createFlowTui } = await import("../src/ui/tui/flow-tui.mjs");
  let _ans = null;
  const fakeFlowMain = async ({ progress, io }) => {
    progress.emit({ type: "opening", agent: "planner", model: "m" });
    progress.emit({ type: "delta", agent: "planner", model: "m", text: "分析需求…" });
    _ans = await io.question("接受 diff?", {});
    return 0;
  };
  const flowTui = createFlowTui({ store, openBackend: () => {}, workflowsRoot: ".", cwd: ".", config: {}, flowMain: fakeFlowMain, dropDelayMs: 50 });
  const fp = flowTui.runFlow(["demo"]);
  await sleep(60);
  ok("flow:⑂planner 卡冒出且流式(rail 显示名 + lastLine)", /⑂planner/.test(stdout.text()) && stdout.text().includes("分析需求"));
  const flowLabel = store.getState().order.find((l) => l.startsWith("⑂planner"));
  ok("flow:approve 门置 awaiting + pendingQuestion", store.getState().sessions[flowLabel].pendingQuestion === "接受 diff?");
  ok("flow:flowStatus 报 running", flowTui.flowStatus().includes("running"));
  // 作答(直接走 flow-tui;真 app 经 dispatchWrapped→handleHumanLine,这里等价驱动)。
  flowTui.handleHumanLine(flowLabel, "y");
  await fp;
  ok("flow:作答后 resolve + pendingQuestion 清空", _ans === "y" && store.getState().sessions[flowLabel].pendingQuestion === null);
  await sleep(80);   // 等 dropFlow(dropDelayMs=50)
  ok("flow:结束后卡片撤除 + 结果进系统消息", !store.getState().order.includes(flowLabel) && store.getState().system.some((m) => /flow demo 结束/.test(m)));

  try { tui.teardown ? tui.teardown() : tui.unmount(); } catch {}

  const failed = checks.filter(([, c]) => !c);
  out(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) { out("FAILED: " + failed.map(([n]) => n).join("; ")); process.exit(1); }
  out("\nSMOKE PASS (real startTui + Ink + keyboard + store wiring).");
  process.exit(0);
}

// Hard timeout so a hung render can't wedge the smoke.
const guard = setTimeout(() => { err("SMOKE TIMEOUT"); process.exit(2); }, 15000);
guard.unref?.();
main().catch((e) => { err("SMOKE ERROR: " + (e?.stack || e)); process.exit(3); });

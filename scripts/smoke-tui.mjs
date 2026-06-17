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

  // 8) flow 群聊视图:假 flowMain 模拟真引擎形状(agent 恒 "omp"、靠 model 区分)→ 一张 ⑂qa 群聊卡,
  //    每次 agent() 调用各成一段(按 start/turn 分段,非按后端名)。
  const { createFlowTui } = await import("../src/ui/tui/flow-tui.mjs");
  const MIMO = "xiaomi/mimo-v2.5-pro", MINIMAX = "minimax/MiniMax-M3";
  let _ans = null;
  const fakeFlowMain = async ({ progress, io }) => {
    progress.emit({ type: "opening", agent: "omp", model: MIMO });
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "出一道题…" });
    progress.emit({ type: "start", agent: "omp", model: MINIMAX });
    progress.emit({ type: "delta", agent: "omp", model: MINIMAX, text: "我的回答…" });
    progress.emit({ type: "start", agent: "omp", model: MIMO });       // mimo 评审(qa-loop 最后发言是 review,非答题者)
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "评审中…" });
    _ans = await io.question("PASS?", {});
    return 0;
  };
  // 续聊用假后端会话(契约同 backend session);openBackend 返回它。
  const liveSess = new EventEmitter();
  liveSess.sent = [];
  liveSess.send = (m) => { liveSess.sent.push(m); return Promise.resolve({}); };
  liveSess.close = () => {}; liveSess.abort = () => Promise.resolve({}); liveSess.summary = () => ({ id: "live" });
  const flowTui = createFlowTui({ store, openBackend: async () => liveSess, workflowsRoot: ".", cwd: ".", config: {}, flowMain: fakeFlowMain, defaultAgent: "omp" });
  const fp = flowTui.runFlow(["qa"]);
  await sleep(60);
  const flowLabel = store.getState().order.find((l) => l.startsWith("⑂qa"));
  ok("flow:一张 ⑂qa 群聊卡(非每 agent 一张)", store.getState().order.filter((l) => l.startsWith("⑂")).length === 1 && !!flowLabel);
  // 聚焦该 flow 卡(真 app 经 onSelect→store.setFocus;smoke 的 onSelect 只记录,这里等价驱动)→ 焦点区渲染群聊页。
  store.setFocus(flowLabel);
  await sleep(40);
  ok("flow:群聊页按 model 区分两发言人 mimo/MiniMax(非合并一段)", /mimo-v2\.5-pro/.test(stdout.text()) && /MiniMax-M3/.test(stdout.text()) && stdout.text().includes("出一道题") && stdout.text().includes("我的回答"));
  ok("flow:store 层 3 个发言段(mimo/minimax/mimo,按 start/turn 分,非后端名)", store.getState().sessions[flowLabel].entries.filter((e) => e.type === "assistant").length === 3);
  ok("flow:approve 门置 awaiting + pendingQuestion.prompt", store.getState().sessions[flowLabel].pendingQuestion && store.getState().sessions[flowLabel].pendingQuestion.prompt === "PASS?");
  ok("flow:flowStatus 报 running", flowTui.flowStatus().includes("running"));
  // 作答(直接走 flow-tui;真 app 经 dispatchWrapped→handleHumanLine,这里等价驱动)。
  flowTui.handleHumanLine(flowLabel, "y");
  await fp;
  ok("flow:作答后 resolve + pendingQuestion 清空", _ans === "y" && store.getState().sessions[flowLabel].pendingQuestion === null);
  await sleep(40);
  ok("flow:结束后卡片保留(不自动撤)+ 记最后发言 turn 身份(mimo review)+ 结果进系统消息",
    store.getState().order.includes(flowLabel)
    && store.getState().sessions[flowLabel].status === "done"
    && store.getState().sessions[flowLabel].lastModel === MIMO
    && store.getState().sessions[flowLabel].lastAgent === "omp"
    && store.getState().system.some((m) => /flow qa 结束/.test(m)));

  // 8b) 原地续聊:在结束的 flow 卡里发消息 → 卡内接管会话,回复续写进同一张卡(不蹦新卡)。
  const beforeOrder = store.getState().order.length;
  await flowTui.continueInPlace(flowLabel, "再出一题");
  await sleep(30);
  ok("续聊:用户输入回显进同一张 flow 卡,不新增卡",
    store.getState().order.length === beforeOrder
    && store.getState().sessions[flowLabel].entries.some((e) => e.type === "user" && e.text === "再出一题"));
  ok("续聊:首轮喂带 transcript 的 seed", liveSess.sent.length === 1 && /再出一题/.test(liveSess.sent[0]) && /出一道题/.test(liveSess.sent[0]));
  liveSess.emit("status", { status: "running", isStreaming: true });
  liveSess.emit("delta", "续聊的新题目");
  liveSess.emit("status", { status: "idle", isStreaming: false });
  await sleep(30);
  ok("续聊:会话回复续写进同一张卡(不蹦新卡)",
    store.getState().order.length === beforeOrder
    && store.getState().sessions[flowLabel].entries.some((e) => e.type === "assistant" && /续聊的新题目/.test(e.text)));

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

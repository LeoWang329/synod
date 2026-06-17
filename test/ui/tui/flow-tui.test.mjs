import { test } from "node:test";
import assert from "node:assert";
import { getEventListeners, EventEmitter } from "node:events";
import { createStore } from "../../../src/ui/tui/store.mjs";
import { createFlowTui } from "../../../src/ui/tui/flow-tui.mjs";

// 真引擎(src/flow/api/agent.mjs)进度事件:`agent` 是后端名(恒 "omp"),靠 `model` 区分各步。
const MIMO = "xiaomi/mimo-v2.5-pro";
const MINIMAX = "minimax/MiniMax-M3";

function mk(flowMain) {
  const store = createStore();
  const ft = createFlowTui({ store, openBackend: () => {}, workflowsRoot: "/x", cwd: "/x", config: {}, flowMain });
  return { store, ft };
}

// 续聊用:假后端会话(契约同 backend session:on/send/close/abort/summary)。
function fakeSession() {
  const s = new EventEmitter();
  s.sent = [];
  s.send = (m) => { s.sent.push(m); return Promise.resolve({ text: "", accepted: true }); };
  s.close = () => { s.closed = true; };
  s.abort = () => { s.aborted = true; return Promise.resolve({ aborted: true }); };
  s.summary = () => ({ id: "live", status: "idle" });
  return s;
}
function mkWithBackend(flowMain, openBackend) {
  const store = createStore();
  const ft = createFlowTui({ store, openBackend, workflowsRoot: "/x", cwd: "/x", config: {}, flowMain, defaultAgent: "omp" });
  return { store, ft };
}

test("真引擎形状(agent 恒 'omp'、靠 model 区分):每次 agent() 调用各成一段(qa-loop 式)", async () => {
  // mimo 出题 → minimax 答 → mimo 评审 → minimax 再答。全 omp,model 在 mimo/minimax 间变。
  const flowMain = async ({ progress }) => {
    progress.emit({ type: "opening", agent: "omp", model: MIMO });
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "出题" });
    progress.emit({ type: "opening", agent: "omp", model: MINIMAX });
    progress.emit({ type: "start", agent: "omp", model: MINIMAX });
    progress.emit({ type: "delta", agent: "omp", model: MINIMAX, text: "答1" });
    progress.emit({ type: "start", agent: "omp", model: MIMO });    // reuse → 只 start
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "评审" });
    progress.emit({ type: "start", agent: "omp", model: MINIMAX });
    progress.emit({ type: "delta", agent: "omp", model: MINIMAX, text: "答2" });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["qa"]);
  const labels = store.getState().order;
  const fl = labels.find((l) => l.startsWith("⑂qa"));
  assert.ok(fl, "应有 ⑂qa 卡");
  assert.strictEqual(labels.filter((l) => l.startsWith("⑂")).length, 1, "只有一张 flow 卡");
  const s = store.getState().sessions[fl];
  // 关键:4 次 agent() 调用 → 4 段,即便 agent 恒为 'omp'、mimo/minimax 各出现两次
  const asst = s.entries.filter((e) => e.type === "assistant");
  assert.strictEqual(asst.length, 4, "4 个发言段,不再合并成一段");
  assert.deepStrictEqual(asst.map((e) => e.agent), ["mimo-v2.5-pro", "MiniMax-M3", "mimo-v2.5-pro", "MiniMax-M3"]);
  assert.deepStrictEqual(asst.map((e) => e.text), ["出题", "答1", "评审", "答2"]);
  assert.deepStrictEqual(s.agents, ["mimo-v2.5-pro", "MiniMax-M3"], "花名册=去重发言人(model 短名)");
  assert.strictEqual(s.status, "done");
});

test("opening+start 双发不重复段;reuse 只 start 仍建段", async () => {
  const flowMain = async ({ progress }) => {
    progress.emit({ type: "opening", agent: "omp", model: MIMO });   // 仅登记花名册
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "A" });
    progress.emit({ type: "start", agent: "omp", model: MIMO });     // reuse,无 opening
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "B" });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["qa"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  const asst = store.getState().sessions[fl].entries.filter((e) => e.type === "assistant");
  assert.strictEqual(asst.length, 2, "两次 start → 两段(opening 不另算)");
  assert.deepStrictEqual(asst.map((e) => e.text), ["A", "B"]);
});

test("flow 结束后卡片保留(不自动撤),且记 lastAgent/lastModel 供续聊", async () => {
  const flowMain = async ({ progress }) => {
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "出题" });
    progress.emit({ type: "start", agent: "omp", model: MINIMAX });
    progress.emit({ type: "delta", agent: "omp", model: MINIMAX, text: "答" });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 20));   // 等任何可能的撤卡定时器(现已无)
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  assert.ok(fl, "结束后卡片仍在(不自动撤)");
  const s = store.getState().sessions[fl];
  assert.strictEqual(s.status, "done");
  assert.strictEqual(s.lastAgent, "omp");
  assert.strictEqual(s.lastModel, MINIMAX, "lastModel = 最后发言 turn 的真 model");
});

test("并发不同 model:交错 delta 按 sourceKey 归属正确发言人(不串台;允许分块)", async () => {
  // v1 限制:无 call-id,交错时同发言人的 delta 可能分成不相邻的块——但绝不能串到别的发言人身上。
  const flowMain = async ({ progress }) => {
    progress.emit({ type: "start", agent: "omp", model: MIMO });      // turn1 mimo
    progress.emit({ type: "start", agent: "omp", model: MINIMAX });   // turn2 minimax
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "甲" });    // 归 mimo
    progress.emit({ type: "delta", agent: "omp", model: MINIMAX, text: "乙" }); // 归 minimax
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "甲2" });   // 归 mimo
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["qa"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  const asst = store.getState().sessions[fl].entries.filter((e) => e.type === "assistant");
  const textOf = (speaker) => asst.filter((e) => e.agent === speaker).map((e) => e.text).join("");
  assert.strictEqual(textOf("mimo-v2.5-pro"), "甲甲2", "mimo 的 delta 全归 mimo,一字不串到 minimax");
  assert.strictEqual(textOf("MiniMax-M3"), "乙", "minimax 只拿到自己的");
});

test("io.question:发言人=当前 turn 的 model 短名;pendingQuestion={agent,prompt};answer resolve", async () => {
  let resolved = null;
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    resolved = await io.question("PASS?", {});
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  assert.deepStrictEqual(store.getState().sessions[fl].pendingQuestion, { agent: "mimo-v2.5-pro", prompt: "PASS?" });
  assert.strictEqual(store.getState().sessions[fl].status, "awaiting");
  assert.strictEqual(ft.answer(fl, "y"), true);
  await p;
  assert.strictEqual(resolved, "y");
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, null);
});

test("并发提问 guard:同一 flow 已有待答 → 第二问 reject,不覆盖第一问", async () => {
  let firstResolved = null, secondErr = null;
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    const p1 = io.question("q1", {});                  // 不 await,制造并发
    try { await io.question("q2", {}); } catch (e) { secondErr = e; }
    firstResolved = await p1;
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion.prompt, "q1", "第一问未被覆盖");
  assert.ok(secondErr && /已有待答/.test(secondErr.message), "第二问被拒");
  ft.answer(fl, "ok");
  await p;
  assert.strictEqual(firstResolved, "ok", "第一问正常 resolve,未悬挂");
});

test("io.stdout.write 投影成 flow 级 output 条(不归属发言人——结果 JSON 不挂 agent 名下)", async () => {
  const flowMain = async ({ progress, io }) => {
    progress.emit({ type: "start", agent: "omp", model: MINIMAX });
    io.stdout.write("flow 结果 JSON");
    return 0;
  };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["qa"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  const e = store.getState().sessions[fl].entries.find((x) => x.type === "output");
  assert.ok(e && e.text === "flow 结果 JSON");
  assert.strictEqual(e.agent, undefined, "flow 程序输出不归属最后发言人");
});

test("answer 后移除 abort 监听器(同一 flow 顺序两问不泄漏)", async () => {
  let sig;
  const flowMain = async ({ progress, io, signal }) => {
    sig = signal;
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    await io.question("q1", { signal });
    await io.question("q2", { signal });
    return 0;
  };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 10));
  let fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  ft.answer(fl, "a1");
  await new Promise((r) => setTimeout(r, 10));
  fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  ft.answer(fl, "a2");
  await p;
  assert.strictEqual(getEventListeners(sig, "abort").length, 0, "answered 不应残留 abort 监听器");
});

test("abortAll:拒绝待答问题,引擎据 signal 收口", async () => {
  let rejected = false;
  const flowMain = async ({ progress, io, signal }) => {
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    try { await io.question("PASS?", { signal }); } catch { rejected = true; }
    return 1;
  };
  const { ft } = mk(flowMain);
  const p = ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 10));
  ft.abortAll();
  await p;
  assert.strictEqual(rejected, true);
});

test("flowStatus:运行中计数,空闲 none", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const flowMain = async () => { await gate; return 0; };
  const { ft } = mk(flowMain);
  const p = ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(ft.flowStatus(), /running/);
  release(); await p;
  assert.strictEqual(ft.flowStatus(), "none");
});

test("handleHumanLine:有待答→作答并吞掉;非 flow→不处理", async () => {
  const flowMain = async ({ progress, io }) => { progress.emit({ type: "start", agent: "omp", model: MIMO }); await io.question("?", {}); return 0; };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  assert.strictEqual(ft.handleHumanLine(fl, "y"), true);
  assert.strictEqual(store.getState().sessions[fl].pendingQuestion, null);
  await p;
  assert.strictEqual(ft.handleHumanLine("omp#1", "hi"), false);
});

test("作答 flow 问题 → 用户答案进 entries(群聊回显 + 续聊上下文)", async () => {
  const flowMain = async ({ progress, io }) => { progress.emit({ type: "start", agent: "omp", model: MIMO }); await io.question("PASS?", {}); return 0; };
  const { store, ft } = mk(flowMain);
  const p = ft.runFlow(["qa"]);
  await new Promise((r) => setTimeout(r, 10));
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  ft.handleHumanLine(fl, "不对,再来");
  await p;
  assert.ok(store.getState().sessions[fl].entries.some((e) => e.type === "user" && e.text === "不对,再来"), "用户答案应进 entries");
});

test("handleHumanLine:flow 会话无待答 → 拒绝(系统消息)", () => {
  const { store, ft } = mk(async () => 0);
  store.attachFlow("⑂x#f9", { flowId: "f9", flowName: "x" });
  const before = store.getState().system.length;
  assert.strictEqual(ft.handleHumanLine("⑂x#f9", "hi"), true);
  assert.ok(store.getState().system.length > before);
});

test("io.stdout.write 无对应卡(/flow --list)→ 落系统消息,不建卡也不静默丢", async () => {
  const flowMain = async ({ io }) => { io.stdout.write("flow-a: 描述\nflow-b: 描述\n"); return 0; };
  const { store, ft } = mk(flowMain);
  await ft.runFlow(["--list"]);
  const sys = store.getState().system;
  assert.ok(sys.some((m) => /flow-a: 描述/.test(m)), "应有 flow-a 行");
  assert.ok(sys.some((m) => /flow-b: 描述/.test(m)), "应有 flow-b 行");
  assert.ok(!store.getState().order.some((l) => l.startsWith("⑂")), "--list 不建 flow 卡");
});

test("continueInPlace 首轮:在同一张 flow 卡内接管会话(不蹦新卡),回复续写进该卡", async () => {
  const flowMain = async ({ progress }) => {
    progress.emit({ type: "start", agent: "omp", model: MIMO });
    progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "评审通过" });
    return 0;
  };
  const sess = fakeSession();
  const { store, ft } = mkWithBackend(flowMain, async () => sess);
  await ft.runFlow(["qa"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  const before = store.getState().order.length;
  await ft.continueInPlace(fl, "再来一题");
  assert.strictEqual(store.getState().order.length, before, "续聊不新增卡");
  assert.ok(store.getState().sessions[fl].entries.some((e) => e.type === "user" && e.text === "再来一题"), "用户输入回显进同一张卡");
  assert.strictEqual(sess.sent.length, 1);
  assert.ok(/再来一题/.test(sess.sent[0]) && /评审通过/.test(sess.sent[0]), "首轮发送带 transcript 的 seed");
  // 会话流式回复 → 续写进同一张卡(经 store.attachSession 的适配管线)
  sess.emit("status", { status: "running", isStreaming: true });
  sess.emit("delta", "这是续聊回复");
  sess.emit("status", { status: "idle", isStreaming: false });
  const reply = store.getState().sessions[fl].entries.find((e) => e.type === "assistant" && /这是续聊回复/.test(e.text));
  assert.ok(reply, "回复续写进该卡");
  assert.ok(reply.agent === "mimo-v2.5-pro" && typeof reply.turn === "number", "续聊回复带发言人名头(agent=mimo 短名 + turn)");
  assert.strictEqual(store.getState().order.length, before, "回复也不新增卡");
});

test("continueInPlace 次轮:复用同一会话,直接 send(line),不再喂 transcript", async () => {
  const flowMain = async ({ progress }) => { progress.emit({ type: "start", agent: "omp", model: MIMO }); progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "答" }); return 0; };
  const sess = fakeSession();
  let opens = 0;
  const { store, ft } = mkWithBackend(flowMain, async () => { opens += 1; return sess; });
  await ft.runFlow(["qa"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  await ft.continueInPlace(fl, "第一问");
  await ft.continueInPlace(fl, "第二问");
  assert.strictEqual(opens, 1, "只开一次会话(次轮复用)");
  assert.strictEqual(sess.sent.length, 2);
  assert.match(sess.sent[0], /第一问/);          // 首轮带 seed
  assert.strictEqual(sess.sent[1], "第二问");     // 次轮只发原话,无 transcript
});

test("continueInPlace:上一条回复在飞(running)时再发 → 提示稍候,不重复 send", async () => {
  const flowMain = async ({ progress }) => { progress.emit({ type: "start", agent: "omp", model: MIMO }); progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "答" }); return 0; };
  const sess = fakeSession();
  const { store, ft } = mkWithBackend(flowMain, async () => sess);
  await ft.runFlow(["qa"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  await ft.continueInPlace(fl, "q1");                               // 首轮,开会话
  sess.emit("status", { status: "running", isStreaming: true });   // 回复在飞
  await ft.continueInPlace(fl, "q2");                               // 飞行中再发
  assert.strictEqual(sess.sent.length, 1, "飞行中不再 send");
  assert.ok(store.getState().system.some((m) => /稍候/.test(m)), "提示稍候");
});

test("closeLive 关掉续聊会话;abortAll 也打断它", async () => {
  const flowMain = async ({ progress }) => { progress.emit({ type: "start", agent: "omp", model: MIMO }); progress.emit({ type: "delta", agent: "omp", model: MIMO, text: "x" }); return 0; };
  const sess = fakeSession();
  const { store, ft } = mkWithBackend(flowMain, async () => sess);
  await ft.runFlow(["qa"]);
  const fl = store.getState().order.find((l) => l.startsWith("⑂qa"));
  const flowId = store.getState().sessions[fl].flowId;
  await ft.continueInPlace(fl, "q");
  ft.abortAll();
  assert.strictEqual(sess.aborted, true, "abortAll 打断续聊会话当前 turn");
  ft.closeLive(flowId);
  assert.strictEqual(sess.closed, true, "closeLive 关闭续聊会话");
});

test("flowName 从 argv 跳过前置 flag(--progress/-- 不当成名字)", async () => {
  const { store, ft } = mk(async () => 0);
  await ft.runFlow(["--progress", "myflow"]);
  await ft.runFlow(["--progress", "--", "other", "{\"x\":1}"]);
  const sys = store.getState().system;
  assert.ok(sys.some((m) => /flow myflow 结束/.test(m)), "['--progress','myflow'] → myflow");
  assert.ok(sys.some((m) => /flow other 结束/.test(m)), "['--progress','--','other',…] → other");
  assert.ok(!sys.some((m) => /--progress/.test(m)), "摘要不出现 --progress");
});

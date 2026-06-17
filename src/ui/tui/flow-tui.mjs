// src/ui/tui/flow-tui.mjs — 把 flow 引擎运行投影进 TUI store(一个 flow = 一张群聊卡 + approve 经输入框作答)。
// 不碰真 stdout(全屏 alt-screen):flow 的 progress/io/signal 三个注入接缝在此装配。
//
// 发言人模型(根因修正,2026-06-17):flow 引擎(src/flow/api/agent.mjs)发的进度事件里
// `agent` 是**后端名**(如 "omp"),不是每步角色——真实 flow(qa-loop)各步全是 "omp",靠 `model` 区分。
// 故"发言人"边界取**每次 agent() 调用**(`start` 事件每个 send 必发一次,首次非复用还先发 `opening`),
// 发言人标签取 model 短名(`prov/name` → `name`)fallback 后端名。turn 状态在此层维护(非 store 全局)。
// 并发口径(无 call-id 的 v1 限制):并发**不同** model 按 sourceKey 各归各发言人(绝不串台,但同发言人的
// delta 可能分成不相邻的块);并发**同** model(同 sourceKey)后一个 start 覆盖前一个 → 退化为最新 turn 一块,
// 不保证按调用分段。串行 flow(如 qa-loop)无此问题。
import { main as realFlowMain } from "../../flow.mjs";
import path from "node:path";
import os from "node:os";
import { prepareResume } from "../../flow/replay.mjs";
import { buildContinuation } from "./flow-continue.mjs";

// argv 可能带前置 flag(repl-dispatch 给 TUI 的是 ["--progress", name] 或 ["--progress","--",name,input])。
// 取第一个非 flag(或 "--" 之后)的 token 作 flow 名——用于卡 label/结束摘要,避免取到 "--progress"。
const flowNameOf = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") return argv[i + 1] ?? null;
    if (!argv[i].startsWith("-")) return argv[i];
  }
  return null;
};
const shortModel = (model) => (model ? String(model).split("/").pop() : "");
const speakerOf = (agent, model, flowName) => shortModel(model) || agent || flowName;
const sourceKey = (agent, model) => `${agent ?? ""} ${model ?? ""}`;

export function createFlowTui({ store, openBackend, workflowsRoot, cwd, config, env = process.env, flowMain = realFlowMain, defaultAgent = null, mesh = false }) {
  let _seq = 0;
  const activeFlows = new Map();   // flowId → { ctrl }
  const pending = new Map();       // flow label → { resolve, reject, flowId, signal, onAbort }
  const liveSessions = new Map();  // flowId → 续聊会话(flow 结束后在原卡内接管的真后端会话,实现"原地多轮对话")

  const flowLabelOf = (flowId, flowName) => `⑂${flowName}#${flowId}`;

  // 一个 flow 的投影:sink(progress→store)+ io(stdout/question→store),共享 turn 状态。
  function makeProjection(flowId, flowName) {
    const label = flowLabelOf(flowId, flowName);
    let turnSeq = 0;
    let lastTurn = null;                  // {turn, speaker} 最近 start 的 turn(output/question 归属)
    const turnBySource = new Map();       // sourceKey(agent+model) → {turn, speaker};并发交错 delta 按来源归段
    const ensureCard = () => { if (!store.getState().sessions[label]) store.attachFlow(label, { flowId, flowName }); };

    const sink = {
      emit(ev) {
        if (!ev) return;
        const speaker = speakerOf(ev.agent, ev.model, flowName);
        if (ev.type === "opening") {
          ensureCard();
          store.noteFlowAgent(label, speaker);                 // 仅登记花名册,不建 turn(start 才建,避免 opening+start 双发占两号)
        } else if (ev.type === "start") {
          ensureCard();
          turnSeq += 1;
          const t = { turn: turnSeq, speaker };
          turnBySource.set(sourceKey(ev.agent, ev.model), t);
          lastTurn = t;
          store.noteFlowTurn(label, { speaker, agent: ev.agent, model: ev.model });   // 花名册 + 记真后端身份(供续聊)
        } else if (ev.type === "delta" && ev.text) {
          ensureCard();
          const t = turnBySource.get(sourceKey(ev.agent, ev.model)) || lastTurn || { turn: (turnSeq += 1), speaker };
          store.appendFlowDelta(label, t.turn, t.speaker, ev.text);
        }
      },
    };

    const cap = (s) => {   // write 返回 true = 无背压;flow 程序级输出,不归属发言人
      if (store.getState().sessions[label]) store.appendFlowOutput(label, String(s));
      else for (const ln of String(s).split("\n")) if (ln.trim()) store.pushSystem(ln);   // 无卡(如 /flow --list):落系统消息,别静默丢
      return true;
    };

    const io = {
      stdout: { write: cap }, stderr: { write: cap }, stdin: {},
      question(prompt, { signal } = {}) {
        if (pending.has(label)) return Promise.reject(new Error("flow 已有待答问题(v1 同一 flow 同刻仅支持一个)"));
        ensureCard();
        store.setFlowQuestion(label, lastTurn?.turn ?? 0, lastTurn?.speaker ?? flowName, prompt);
        return new Promise((resolve, reject) => {
          const onAbort = () => { if (pending.delete(label)) reject(new Error("flow aborted")); };
          pending.set(label, { resolve, reject, flowId, signal, onAbort });
          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      },
    };

    return { sink, io };
  }

  function start(argv, extra = {}) {
    const flowId = `f${++_seq}`;
    const flowName = flowNameOf(argv) || flowId;
    const ctrl = new AbortController();
    const { sink, io } = makeProjection(flowId, flowName);
    activeFlows.set(flowId, { ctrl });
    const p = Promise.resolve()
      .then(() => flowMain({
        argv, progress: sink, io, signal: ctrl.signal,
        stdout: io.stdout, stderr: io.stderr,
        openBackend, workflowsRoot, cwd, config, env, ...extra,
      }))
      .then((code) => { store.endFlow(flowId, { ok: code === 0, summary: `flow ${flowName} 结束(exit ${code})` }); return code; })
      .catch((err) => { store.endFlow(flowId, { ok: false, summary: `flow ${flowName} 出错: ${err?.message ?? err}` }); return 1; })
      .finally(() => {
        activeFlows.delete(flowId);
        for (const [lbl, pr] of [...pending]) if (pr.flowId === flowId) { pending.delete(lbl); pr.signal?.removeEventListener("abort", pr.onAbort); pr.reject(new Error("flow ended")); }
        // 不自动撤卡:flow 结束后群聊卡保留(done/failed 态),供续聊/翻看,Ctrl-W 手动关。
      });
    return p;
  }

  const api = {
    runFlow: (argv) => start(argv),
    flowStatus: () => (activeFlows.size > 0 ? `${activeFlows.size} running` : "none"),
    abortAll: () => {
      for (const { ctrl } of activeFlows.values()) ctrl.abort();
      for (const s of liveSessions.values()) { try { s.abort?.(); } catch { /* best-effort */ } }   // 也打断续聊会话的当前 turn
    },
    answer(label, line) {
      const pr = pending.get(label);
      if (!pr) return false;
      pending.delete(label);
      pr.signal?.removeEventListener("abort", pr.onAbort);
      store.resolveFlowQuestion(label);
      pr.resolve(line);
      return true;
    },
    // 原地续聊:flow 结束后,用户在同一张 flow 卡里发消息 → 在卡内接管一个真后端会话,
    // 回复/工具流式续写进这张卡(复用 store.attachSession 的适配/渲染管线),不蹦新卡。
    async continueInPlace(label, line) {
      const card = store.getState().sessions[label];
      if (!card || card.kind !== "flow") return false;
      const existing = liveSessions.get(card.flowId);
      // 续聊会话不走 smTui 的 sendQueue:回复在飞(running)时再发会和后端当前 turn 冲突 → 提示稍候,不重复 send。
      if (existing && card.status === "running") { store.pushSystem("⑂ 上一条还在回复,请稍候再发"); return true; }
      store.pushUser(label, line);                                   // 回显用户输入(同步,立即可见)
      if (existing) {                                                // 次轮:复用会话,直接发(不再喂 transcript)
        try { Promise.resolve(existing.send(line)).catch((e) => store.pushSystem(`续聊出错: ${e?.message ?? e}`)); }
        catch (e) { store.pushSystem(`续聊出错: ${e?.message ?? e}`); }
        return true;
      }
      // 首轮:开会话(最后发言 turn 的真 agent+model),接进同一张卡,喂 transcript + 追问。
      const { agent, model, seed } = buildContinuation(card, line, { defaultAgent });
      card._live = true;                                            // 之后即便流式 running 也按"续聊"路由(非"flow 在跑")
      store.pushSystem(`续聊 ${card.flowName} · ${agent}${model ? " · " + shortModel(model) : ""}`);
      let s;
      try { s = await openBackend({ agent, model, cwd, mesh, write: false }); }
      catch (e) { store.pushSystem(`续聊:开会话失败 ${e?.message ?? e}`); return true; }
      if (!s) { store.pushSystem("续聊:开会话失败"); return true; }
      liveSessions.set(card.flowId, s);
      store.startFlowContinuation(label, speakerOf(agent, model, card.flowName));   // 续聊回复按 turn 分段、插发言人名头
      store.attachSession(label, s, agent, { model });              // 把会话事件投进这张 flow 卡
      try { Promise.resolve(s.send(seed)).catch((e) => store.pushSystem(`续聊出错: ${e?.message ?? e}`)); }
      catch (e) { store.pushSystem(`续聊出错: ${e?.message ?? e}`); }
      return true;
    },
    closeLive(flowId) { const s = liveSessions.get(flowId); if (s) { try { s.close?.(); } catch { /* */ } liveSessions.delete(flowId); } },
    closeAllLive() { for (const s of liveSessions.values()) { try { s.close?.(); } catch { /* */ } } liveSessions.clear(); },
    resumeFlow: async (runId) => {
      const runsRoot = path.resolve(env.SYNOD_HOME || os.homedir(), ".synod", "runs");
      let r;
      try { r = await prepareResume(runsRoot, runId); }
      catch (err) { store.pushSystem(`/resume: ${err.message}`); return; }
      return start([r.flowName], { resume: { runId: r.runId, input: r.input, steps: r.steps }, cwd: r.cwd, runsRoot });
    },
    handleHumanLine(label, line) {
      const s = store.getState().sessions[label];
      if (!s || s.kind !== "flow") return false;     // 非 flow → 交回普通 dispatch
      // 作答:把用户答案回显进 flow 群聊(也进续聊 transcript)——否则人工反馈丢失。
      if (s.pendingQuestion != null) { store.pushUser(label, line); api.answer(label, line); return true; }
      store.pushSystem("⑂ 这是 flow 会话,不能直接发消息(只能在它请求确认时作答)");
      return true;
    },
  };
  return api;
}

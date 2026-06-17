// src/ui/tui/flow-tui.mjs — 把 flow 引擎运行投影进 TUI store(只读会话卡 + approve 经输入框作答)。
// 不碰真 stdout(全屏 alt-screen):flow 的 progress/io/signal 三个注入接缝在此装配。
import { main as realFlowMain } from "../../flow.mjs";
import path from "node:path";
import os from "node:os";
import { prepareResume } from "../../flow/replay.mjs";

const DROP_DELAY_MS = 3000;
const shortAgent = (label) => label.replace(/^⑂/, "").replace(/#.*$/, "").replace(/:.*$/, "");

export function createFlowTui({ store, openBackend, workflowsRoot, cwd, config, env = process.env, flowMain = realFlowMain, dropDelayMs = DROP_DELAY_MS }) {
  let _seq = 0;
  const activeFlows = new Map();   // flowId → { ctrl }
  const pending = new Map();       // label → { resolve, reject, flowId, signal, onAbort }

  const keyOf = (flowId, agent, model) => `⑂${agent}${model ? ":" + model : ""}#${flowId}`;

  function makeSink(flowId) {
    let last = null;   // { label, agent, model }
    return {
      last: () => last,
      emit(ev) {
        if (!ev) return;
        const agent = ev.agent ?? String(flowId);
        const label = keyOf(flowId, agent, ev.model);
        last = { label, agent, model: ev.model ?? null };
        if (ev.type === "opening" || ev.type === "start") {
          store.attachFlowAgent(label, { flowId, agent, model: ev.model ?? null });
        } else if (ev.type === "delta" && ev.text) {
          if (!store.getState().sessions[label])
            store.attachFlowAgent(label, { flowId, agent, model: ev.model ?? null });
          store.appendFlowDelta(label, ev.text);
        }
      },
    };
  }

  function makeIo(flowId, sink, flowName) {
    const targetLabel = () => (sink.last()?.label) || keyOf(flowId, flowName, null);
    const cap = (s) => {   // write 返回 true = 无背压
      const l = targetLabel();
      if (store.getState().sessions[l]) store.appendFlowOutput(l, String(s));
      else for (const ln of String(s).split("\n")) if (ln.trim()) store.pushSystem(ln);   // 无对应卡(如 /flow --list):落系统消息,别静默丢
      return true;
    };
    return {
      stdout: { write: cap }, stderr: { write: cap }, stdin: {},
      question(prompt, { signal } = {}) {
        const label = targetLabel();
        store.attachFlowAgent(label, { flowId, agent: shortAgent(label), model: null });
        store.setFlowQuestion(label, prompt);
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
  }

  function start(argv, extra = {}) {
    const flowId = `f${++_seq}`;
    const flowName = argv[0] || flowId;
    const ctrl = new AbortController();
    const sink = makeSink(flowId);
    const io = makeIo(flowId, sink, flowName);
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
        for (const [label, pr] of [...pending]) if (pr.flowId === flowId) { pending.delete(label); pr.signal?.removeEventListener("abort", pr.onAbort); pr.reject(new Error("flow ended")); }
        setTimeout(() => store.dropFlow(flowId), dropDelayMs).unref?.();
      });
    return p;
  }

  const api = {
    runFlow: (argv) => start(argv),
    flowStatus: () => (activeFlows.size > 0 ? `${activeFlows.size} running` : "none"),
    abortAll: () => { for (const { ctrl } of activeFlows.values()) ctrl.abort(); },
    answer(label, line) {
      const pr = pending.get(label);
      if (!pr) return false;
      pending.delete(label);
      pr.signal?.removeEventListener("abort", pr.onAbort);
      store.resolveFlowQuestion(label);
      pr.resolve(line);
      return true;
    },
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
      if (s.pendingQuestion != null) { api.answer(label, line); return true; }
      store.pushSystem("⑂ 这是 flow 会话,不能直接发消息(只能在它请求确认时作答)");
      return true;
    },
  };
  return api;
}

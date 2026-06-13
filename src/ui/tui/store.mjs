// src/ui/tui/store.mjs — TUI 状态容器(纯逻辑,React 之外,可单测)。
// P1:每个 session 只保留"当前 turn 的流式 assistant 文本"(非完整 timeline,见计划头部说明)。
import { getEventAdapter } from "./events.mjs";
const MAX_SYSTEM = 100;

export function createStore() {
  const state = {
    sessions: {}, order: [], focusLabel: null,
    system: [], relays: [], fences: {},
  };
  const subs = new Set();
  const notify = () => { for (const fn of subs) fn(); };
  const trimSystem = () => { while (state.system.length > MAX_SYSTEM) state.system.shift(); };

  function ensure(label) {
    if (!state.sessions[label]) {
      state.sessions[label] = {
        agent: "", model: null, effort: null, status: "idle", isStreaming: false,
        turn: 0, assistantText: "", lastLine: "", turnStartAt: null, ms: null,
      };
      state.order.push(label);
    }
    return state.sessions[label];
  }
  function apply(label, ev) {
    if (!ev) return;
    const s = ensure(label);
    if (ev.kind === "status") {
      s.status = ev.status; s.isStreaming = ev.isStreaming;
      if (ev.status === "running") { s.assistantText = ""; s.lastLine = ""; s.turnStartAt = Date.now(); }
      else if (ev.status === "idle") {
        s.turn += 1;
        if (s.turnStartAt != null) { s.ms = Date.now() - s.turnStartAt; s.turnStartAt = null; }
      }
    } else if (ev.kind === "message.delta") {
      s.assistantText += ev.text;
      const nl = s.assistantText.lastIndexOf("\n");
      s.lastLine = nl === -1 ? s.assistantText : s.assistantText.slice(nl + 1);
    }
    notify();
  }
  return {
    getState() { return state; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    attachSession(label, session, agent, { model = null, effort = null } = {}) {
      const s = ensure(label); s.agent = agent; s.model = model; s.effort = effort;
      if (!state.focusLabel) state.focusLabel = label;
      const normalize = getEventAdapter(agent);
      session.on("delta", (d) => apply(label, normalize({ channel: "delta", payload: d, agent })));
      session.on("status", (st) => apply(label, normalize({ channel: "status", payload: st, agent })));
      session.on("event", (e) => apply(label, normalize({ channel: "event", payload: e, agent })));
      session.on("error", (err) => { state.system.push(`[${label}] ${err?.message ?? err}`); trimSystem(); notify(); });
      notify();
    },
    setFocus(label) { if (state.sessions[label]) { state.focusLabel = label; notify(); } },
    focusNext() {
      if (state.order.length === 0) return;
      const i = state.order.indexOf(state.focusLabel);
      state.focusLabel = state.order[(i + 1) % state.order.length]; notify();
    },
    pushSystem(line) { state.system.push(line); trimSystem(); notify(); },
    setRelays(list) { state.relays = list; notify(); },
    setFence(label, data) { state.fences[label] = data; notify(); },
    dropSession(label) {
      delete state.sessions[label];
      state.order = state.order.filter((l) => l !== label);
      if (state.focusLabel === label) state.focusLabel = state.order[state.order.length - 1] ?? null;
      notify();
    },
  };
}

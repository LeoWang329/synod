// src/ui/tui/store.mjs — TUI 状态容器(纯逻辑,React 之外,可单测)。
// P1:每个 session 只保留"当前 turn 的流式 assistant 文本"(非完整 timeline,见计划头部说明)。
import { getEventAdapter } from "./events.mjs";
const MAX_SYSTEM = 100;
const MAX_ENTRIES = 300;   // 时间线条目上限,防内存无界

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
        entries: [], _newAsst: false,     // P2:有序时间线 + 新-assistant-条 标志(turn 边界)
      };
      state.order.push(label);
    }
    return state.sessions[label];
  }
  function trimEntries(s) { while (s.entries.length > MAX_ENTRIES) s.entries.shift(); }
  function apply(label, ev) {
    if (!ev) return;
    const s = ensure(label);
    if (ev.kind === "status") {
      s.status = ev.status; s.isStreaming = ev.isStreaming;
      if (ev.status === "running") { s.assistantText = ""; s.lastLine = ""; s.turnStartAt = Date.now(); s._newAsst = true; }
      else if (ev.status === "idle") {
        s.turn += 1;
        if (s.turnStartAt != null) { s.ms = Date.now() - s.turnStartAt; s.turnStartAt = null; }
      }
    } else if (ev.kind === "message.delta") {
      // P1 字段(AgentRail 依赖)
      s.assistantText += ev.text;
      const nl = s.assistantText.lastIndexOf("\n");
      s.lastLine = nl === -1 ? s.assistantText : s.assistantText.slice(nl + 1);
      // P2 时间线:同一 turn 内追加到末条 assistant;新 turn(running 后首段,_newAsst)或遇 tool 后另起一条。
      const last = s.entries[s.entries.length - 1];
      if (!s._newAsst && last && last.type === "assistant") last.text += ev.text;
      else { s.entries.push({ type: "assistant", text: ev.text }); s._newAsst = false; trimEntries(s); }
    } else if (ev.kind === "tool.start") {
      s.entries.push({ type: "tool", id: ev.id, name: ev.name, args: ev.args ?? null,
        intent: ev.intent ?? null, status: "running", ok: null, output: "", diff: null, expanded: false });
      trimEntries(s);
    } else if (ev.kind === "tool.end") {
      let card = ev.id != null ? s.entries.find((x) => x.type === "tool" && x.id === ev.id) : null;
      if (!card) {  // 只见 end(codex 一次性 / 漏 start):新建一张已完成卡
        card = { type: "tool", id: ev.id, name: ev.name ?? "tool", args: ev.args ?? null,
          intent: null, status: "done", ok: null, output: "", diff: null, expanded: false };
        s.entries.push(card); trimEntries(s);
      }
      card.status = "done"; card.ok = ev.ok ?? null;
      if (ev.output) card.output = ev.output;
      if (ev.diff) card.diff = ev.diff;
      if (ev.name && card.name === "tool") card.name = ev.name;
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
      session.on("toolevent", (e) => apply(label, normalize({ channel: "toolevent", payload: e, agent })));
      session.on("error", (err) => { state.system.push(`[${label}] ${err?.message ?? err}`); trimSystem(); notify(); });
      notify();
    },
    setFocus(label) { if (state.sessions[label]) { state.focusLabel = label; notify(); } },
    focusNext() {
      if (state.order.length === 0) return;
      const i = state.order.indexOf(state.focusLabel);
      state.focusLabel = state.order[(i + 1) % state.order.length]; notify();
    },
    pushUser(label, text) { const s = ensure(label); s.entries.push({ type: "user", text }); trimEntries(s); notify(); },
    toggleEntry(label, index) {
      const s = state.sessions[label];
      if (s && s.entries[index] && s.entries[index].type === "tool") { s.entries[index].expanded = !s.entries[index].expanded; notify(); }
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

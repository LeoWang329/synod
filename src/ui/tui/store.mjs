// src/ui/tui/store.mjs — TUI 状态容器(纯逻辑,React 之外,可单测)。
// P1:每个 session 只保留"当前 turn 的流式 assistant 文本"(非完整 timeline,见计划头部说明)。
import { getEventAdapter } from "./events.mjs";
import { fenceBreadcrumb } from "./breadcrumbs.mjs";
const MAX_SYSTEM = 100;
const MAX_ENTRIES = 300;   // 时间线条目上限,防内存无界

export function createStore() {
  const state = {
    sessions: {}, order: [], focusLabel: null,
    system: [],
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

  // ── flow 伪会话:一个 flowId 一张群聊卡,条目带发言人(agent)字段 ──
  function ensureFlow(label, { flowId, flowName }) {
    let s = state.sessions[label];
    if (!s) {
      s = state.sessions[label] = {
        kind: "flow", flowId, flowName: flowName ?? "", agent: flowName ?? "",
        model: null, effort: null, status: "running", isStreaming: true, turn: 0,
        assistantText: "", lastLine: "", turnStartAt: null, ms: null,
        agents: [], entries: [], _newAsst: false, pendingQuestion: null,
        lastAgent: null, lastModel: null,   // 最后发言 turn 的真后端身份(供 flow 结束后续聊新开会话)
      };
      state.order.push(label);
      if (!state.focusLabel) state.focusLabel = label;
    }
    return s;
  }
  function noteAgent(s, agent) { if (agent && !s.agents.includes(agent)) s.agents.push(agent); }
  function maxTurnOf(s) { let m = 0; for (const e of s.entries) if (typeof e.turn === "number" && e.turn > m) m = e.turn; return m; }

  function pushNudgeToFocus(fromLabel, what) {
    const fl = state.focusLabel;
    if (!fl || fl === fromLabel) return;
    const fs = state.sessions[fl];
    if (!fs) return;
    fs.entries.push({ type: "nudge", text: `${fromLabel} ${what}`, target: fromLabel });
    trimEntries(fs);
  }
  function apply(label, ev) {
    if (!ev) return;
    const s = ensure(label);
    if (ev.kind === "status") {
      s.status = ev.status; s.isStreaming = ev.isStreaming;
      if (ev.status === "running") { s.assistantText = ""; s.lastLine = ""; s.turnStartAt = Date.now(); s._newAsst = true; if (s._contSpeaker != null) s._contTurn += 1; }
      else if (ev.status === "idle") {
        s.turn += 1;
        if (s.turnStartAt != null) { s.ms = Date.now() - s.turnStartAt; s.turnStartAt = null; }
        if (label !== state.focusLabel) { s.status = "awaiting"; pushNudgeToFocus(label, "跑完了"); }
      }
    } else if (ev.kind === "message.delta") {
      // P1 字段(AgentRail 依赖)
      s.assistantText += ev.text;
      const nl = s.assistantText.lastIndexOf("\n");
      s.lastLine = nl === -1 ? s.assistantText : s.assistantText.slice(nl + 1);
      // P2 时间线:同一 turn 内追加到末条 assistant;新 turn(running 后首段,_newAsst)或遇 tool 后另起一条。
      const last = s.entries[s.entries.length - 1];
      if (!s._newAsst && last && last.type === "assistant") last.text += ev.text;
      // 续聊态:给新 assistant 段带上续聊发言人 + turn,使 FocusPane 按 turn 分段、插发言人名头。
      else { s.entries.push({ type: "assistant", text: ev.text, ...(s._contSpeaker != null ? { agent: s._contSpeaker, turn: s._contTurn } : {}) }); s._newAsst = false; trimEntries(s); }
    } else if (ev.kind === "tool.start") {
      s.entries.push({ type: "tool", id: ev.id, name: ev.name, args: ev.args ?? null, turn: s._contSpeaker != null ? s._contTurn : undefined,
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
      // Resolve the adapter per-event (lazy), NOT once at attach: a session can be attached
      // before its agent's adapter is registered (cli opens the default session before startTui
      // registers omp/codex adapters). Capturing once would freeze it to defaultAdapter and
      // silently drop toolevents. getEventAdapter falls back to defaultAdapter, never undefined.
      const norm = (channel, payload) => apply(label, getEventAdapter(agent)({ channel, payload, agent }));
      session.on("delta", (d) => norm("delta", d));
      session.on("status", (st) => norm("status", st));
      session.on("event", (e) => norm("event", e));
      session.on("toolevent", (e) => norm("toolevent", e));
      session.on("error", (err) => {
        state.system.push(`[${label}] ${err?.message ?? err}`); trimSystem();
        const es = state.sessions[label];
        if (es && label !== state.focusLabel) { es.status = "awaiting"; pushNudgeToFocus(label, "出错了"); }
        notify();
      });
      notify();
    },
    setFocus(label) {
      const s = state.sessions[label];
      if (s) { if (s.status === "awaiting") s.status = "idle"; state.focusLabel = label; notify(); }
    },
    focusNext() {
      if (state.order.length === 0) return;
      const i = state.order.indexOf(state.focusLabel);
      const nl = state.order[(i + 1) % state.order.length];
      state.focusLabel = nl;
      const s = state.sessions[nl];
      if (s && s.status === "awaiting") s.status = "idle";
      notify();
    },
    firstAwaiting() {
      for (const l of state.order) if (state.sessions[l] && state.sessions[l].status === "awaiting") return l;
      return null;
    },
    pushUser(label, text) { const s = ensure(label); s.entries.push({ type: "user", text }); trimEntries(s); notify(); },
    toggleEntry(label, index) {
      const s = state.sessions[label];
      if (s && s.entries[index] && s.entries[index].type === "tool") { s.entries[index].expanded = !s.entries[index].expanded; notify(); }
    },
    pushSystem(line) { state.system.push(line); trimSystem(); notify(); },
    appendFence(label, fence) {
      // 编排发生时,把每条命令翻成流内面包屑条目(供对话流渲染;无底部 C 折叠条)。
      const s = state.sessions[label];
      if (!s) return;
      for (const c of (fence.commands || [])) s.entries.push({ type: "breadcrumb", text: fenceBreadcrumb(c.cmd, c.result) });
      trimEntries(s);
      notify();
    },
    dropSession(label) {
      delete state.sessions[label];
      state.order = state.order.filter((l) => l !== label);
      if (state.focusLabel === label) state.focusLabel = state.order[state.order.length - 1] ?? null;
      notify();
    },
    attachFlow(label, meta) { ensureFlow(label, meta); notify(); },
    noteFlowAgent(label, agent) { const s = state.sessions[label]; if (!s) return; noteAgent(s, agent); notify(); },
    // start 事件:登记花名册(展示用 speaker)+ 记最后发言 turn 的真后端身份(agent/model,供续聊新开会话)。
    noteFlowTurn(label, { speaker, agent, model }) {
      const s = state.sessions[label]; if (!s) return;
      noteAgent(s, speaker);
      // 原子配对:有 agent 才整对更新,model 缺省置 null——不能保留上一个 turn 的旧 model(否则 agent/model 错配)。
      if (agent != null) { s.lastAgent = agent; s.lastModel = model ?? null; }
      notify();
    },
    // 续聊态:记发言人标签 + 续聊 turn 基线(后续每个 reply 在 apply 的 status:running 分支 +1),
    // 使续聊回复像群聊一样按 turn 分段、各插发言人名头。
    startFlowContinuation(label, speaker) {
      const s = state.sessions[label]; if (!s) return;
      s._contSpeaker = speaker || s.flowName; s._contTurn = maxTurnOf(s);
      notify();
    },
    // turn:发言人 turn 号(每次 agent() 调用一个,由 flow-tui 按 start 事件递增);speaker:展示标签(model 短名)。
    // 分段以 turn 为界——同 turn 累加,turn 变即另起一段(故同 speaker 的两次调用也分段;真引擎里 agent 恒为后端名,靠 model/turn 区分)。
    appendFlowDelta(label, turn, speaker, text) {
      const s = state.sessions[label]; if (!s) return;
      noteAgent(s, speaker);
      s.isStreaming = true;
      const last = s.entries[s.entries.length - 1];
      const sameTurn = last && last.type === "assistant" && last.turn === turn;
      if (sameTurn) last.text += text;
      else s.entries.push({ type: "assistant", agent: speaker, turn, text });
      if (!sameTurn) s.assistantText = "";   // 新 turn 段 → 重置 rail 预览,别把上个发言人的尾行粘上来
      s.assistantText += text;
      const nl = s.assistantText.lastIndexOf("\n");
      s.lastLine = nl === -1 ? s.assistantText : s.assistantText.slice(nl + 1);
      trimEntries(s); notify();
    },
    // flow 程序级 stdout(结果 JSON / banner / approve 待审内容等)——不属于任何 agent,
    // 故不归属发言人、不进花名册、不带 turn(渲染为独立 flow 输出块,不挂在发言人名下)。
    appendFlowOutput(label, text) {
      const s = state.sessions[label]; if (!s) return;
      s.entries.push({ type: "output", text: String(text) }); trimEntries(s); notify();
    },
    setFlowQuestion(label, turn, speaker, prompt) {
      const s = state.sessions[label]; if (!s) return;
      noteAgent(s, speaker);
      s.pendingQuestion = { agent: speaker, prompt }; s.status = "awaiting";
      s.entries.push({ type: "approve", agent: speaker, turn, text: prompt }); trimEntries(s);
      pushNudgeToFocus(label, "要你确认");   // 非焦点时,焦点流冒「… 要你确认 · ^G 去看」(A 通道)
      notify();
    },
    resolveFlowQuestion(label) {
      const s = state.sessions[label]; if (!s) return;
      s.pendingQuestion = null; if (s.status === "awaiting") s.status = "running"; notify();
    },
    endFlow(flowId, { ok = true, summary = null } = {}) {
      for (const l of state.order) {
        const s = state.sessions[l];
        if (s && s.kind === "flow" && s.flowId === flowId) {
          s.status = ok ? "done" : "failed"; s.isStreaming = false; s.pendingQuestion = null;
        }
      }
      if (summary) { state.system.push(summary); trimSystem(); }
      notify();
    },
    dropFlow(flowId) {
      const drop = state.order.filter((l) => { const s = state.sessions[l]; return s && s.kind === "flow" && s.flowId === flowId; });
      for (const l of drop) delete state.sessions[l];
      state.order = state.order.filter((l) => !drop.includes(l));
      if (drop.includes(state.focusLabel)) state.focusLabel = state.order[state.order.length - 1] ?? null;
      notify();
    },
  };
}

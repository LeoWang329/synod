// src/ui/tui/app.mjs — TUI 根组件:布局 + 键盘 + Ctrl-C + 焦点回调 + store 订阅。
import { useState, useEffect, useRef } from "react";
import { Box, useInput } from "ink";
import { html } from "./html.mjs";
import { AgentRail } from "./components/AgentRail.mjs";
import { FocusPane } from "./components/FocusPane.mjs";
import { InputBar } from "./components/InputBar.mjs";
import { SystemStrip } from "./components/SystemStrip.mjs";
import { StatusBar } from "./components/StatusBar.mjs";
import { computeHints } from "./hints.mjs";

export function App({ store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt, rows }) {
  const [, force] = useState(0);
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  const st = store.getState();
  const [selIdx, setSelIdx] = useState(-1);
  useEffect(() => { setSelIdx(-1); }, [st.focusLabel]);
  const hints = computeHints(value, hintsCtx);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onInterrupt(); return; }
    if (key.tab) { onCycle(); return; }
    if (key.return) {
      const line = valueRef.current.trim();
      // 选中了工具卡且输入框为空 → Enter 展开/收起选中卡(等同 Ctrl-E),不当作发送。
      if (!line && selIdx >= 0) {
        const st2 = store.getState();
        const ent = st2.sessions[st2.focusLabel]?.entries || [];
        if (ent[selIdx]?.type === "tool") { store.toggleEntry(st2.focusLabel, selIdx); return; }
      }
      valueRef.current = "";
      setValue("");
      if (line) {
        const r = dispatch(line, { source: "human" });
        if (r && r.exit) onInterrupt();
      }
      return;
    }
    if (key.backspace || key.delete) {
      const next = valueRef.current.slice(0, -1);
      valueRef.current = next;
      setValue(next);
      return;
    }
    if (key.ctrl && input === "o") { dispatch("/open", { source: "human" }); return; }
    if (key.ctrl && input === "w" && st.focusLabel) { dispatch(`/close ${st.focusLabel}`, { source: "human" }); return; }
    if (key.ctrl && input === "g") { const t = store.firstAwaiting(); if (t) onSelect(t); return; }   // 跳到"待你"的后台 agent
    if (key.ctrl && input === "e") {
      const st2 = store.getState();
      const ent = (st2.sessions[st2.focusLabel]?.entries) || [];
      let idx = (selIdx >= 0 && ent[selIdx]?.type === "tool") ? selIdx
        : (() => { for (let i = ent.length - 1; i >= 0; i--) if (ent[i].type === "tool") return i; return -1; })();
      if (idx >= 0) store.toggleEntry(st2.focusLabel, idx);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const st2 = store.getState();
      const ent = (st2.sessions[st2.focusLabel]?.entries) || [];
      const tools = ent.map((e, i) => e.type === "tool" ? i : -1).filter((i) => i >= 0);
      if (tools.length) {
        const cur = tools.indexOf(selIdx);
        const next = key.upArrow ? (cur <= 0 ? tools.length - 1 : cur - 1) : (cur < 0 || cur >= tools.length - 1 ? 0 : cur + 1);
        setSelIdx(tools[next]);
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const next = valueRef.current + input;
      valueRef.current = next;
      setValue(next);
    }
  });

  const agents = st.order.length;
  const awaiting = Object.values(st.sessions).filter((s) => s.status === "awaiting").length;
  const fa = st.sessions[st.focusLabel];
  const approve = !!(fa && fa.kind === "flow" && fa.pendingQuestion);
  // 纵向布局:上半 body(焦点区 | agent 栏)flexGrow 撑满;竖线只在 body 内(rail borderLeft),
  // 到输入框上方即止——不贯穿输入。输入框/状态栏是 column 直接子项 → 横向通栏(左到右)。
  // height=${rows}(终端行高)→ 占满整屏,focus 区 flexGrow 把输入/状态压到最底端。
  return html`<${Box} flexDirection="column" width="100%" height=${rows}>
    <${Box} flexGrow=${1}>
      <${FocusPane} label=${st.focusLabel} sess=${st.sessions[st.focusLabel]} selectedIndex=${selIdx} />
      <${AgentRail} sessions=${st.sessions} order=${st.order} focusLabel=${st.focusLabel} />
    <//>
    <${SystemStrip} messages=${st.system} />
    <${InputBar} focusLabel=${st.focusLabel} value=${value} hints=${hints} approve=${approve} />
    <${StatusBar} agents=${agents} awaiting=${awaiting} mesh=${mesh} />
  <//>`;
}

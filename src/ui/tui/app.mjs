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

export function App({ store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt }) {
  const [, force] = useState(0);
  const [value, setValue] = useState("");
  // valueRef stays current across re-renders so the useInput callback
  // (which closes over a stale copy of `value`) always reads the latest text.
  const valueRef = useRef("");
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  const st = store.getState();
  const hints = computeHints(value, hintsCtx);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onInterrupt(); return; }
    if (key.tab) { onCycle(); return; }
    if (key.return) {
      const line = valueRef.current.trim();
      valueRef.current = "";
      setValue("");
      if (line) {
        const r = dispatch(line, { source: "human" });
        if (r && r.exit) onInterrupt();   // /exit /quit → 触发优雅退出(同 Ctrl-C 收尾链)
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
    if (input && !key.ctrl && !key.meta) {
      const next = valueRef.current + input;
      valueRef.current = next;
      setValue(next);
    }
  });

  const running = Object.values(st.sessions).filter((s) => s.status === "running").length;
  return html`<${Box} flexDirection="column" width="100%">
    <${Box} flexGrow=${1}>
      <${FocusPane} label=${st.focusLabel} sess=${st.sessions[st.focusLabel]} fence=${st.fences[st.focusLabel] || null} relays=${st.relays} />
      <${AgentRail} sessions=${st.sessions} order=${st.order} focusLabel=${st.focusLabel} relays=${st.relays} />
    <//>
    <${SystemStrip} messages=${st.system} />
    <${InputBar} focusLabel=${st.focusLabel} value=${value} hints=${hints} />
    <${StatusBar} running=${running} mesh=${mesh} />
  <//>`;
}

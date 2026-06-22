// src/ui/tui/app.mjs — TUI 根组件:布局 + 键盘 + Ctrl-C + 焦点回调 + store 订阅。
import { useState, useEffect, useRef } from "react";
import { Box, useInput } from "ink";
import { html } from "./html.mjs";
import { AgentRail } from "./components/AgentRail.mjs";
import { FocusPane } from "./components/FocusPane.mjs";
import { InputBar } from "./components/InputBar.mjs";
import { SystemStrip } from "./components/SystemStrip.mjs";
import { StatusBar } from "./components/StatusBar.mjs";
import { computeHints, applyHint } from "./hints.mjs";
import { scrollReducer, effectiveScroll, scrollbar } from "./scroll.mjs";

export function App({ store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt, rows }) {
  const [, force] = useState(0);
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  const st = store.getState();
  const [selIdx, setSelIdx] = useState(-1);
  // 焦点区滚动:scrollState={scroll,stick} 由 App 拥有;dims={viewportH,contentH} 由 FocusPane 实测/估算上报。
  // 切会话归位到「跟随最新」(stick)。dims 仅在变化时 setState,避免 onMeasure↔re-render 自循环。
  const [scrollState, setScrollState] = useState({ scroll: 0, stick: true });
  const scrollRef = useRef({ scroll: 0, stick: true });
  const setScroll = (s) => { scrollRef.current = s; setScrollState(s); };
  const [dims, setDims] = useState({ viewportH: 0, contentH: 0 });
  const dimsRef = useRef(dims);
  const onMeasure = (d) => {
    if (dimsRef.current.viewportH === d.viewportH && dimsRef.current.contentH === d.contentH) return;
    dimsRef.current = d; setDims(d);
  };
  useEffect(() => { setSelIdx(-1); setScroll({ scroll: 0, stick: true }); }, [st.focusLabel]);
  const hints = computeHints(value, hintsCtx);
  // hint 菜单选中态:菜单打开时(items 非空)接管 ↑↓/Tab。ref 与 state 双写——Tab 补全要读最新值
  // (与 valueRef 同理,避免同一 tick 内 ↓ 后 Tab 读到旧 selIdx)。输入/退格归 0(列表会随键入收窄)。
  const [hintSel, setHintSel] = useState(0);
  const hintSelRef = useRef(0);
  const setHint = (n) => { hintSelRef.current = n; setHintSel(n); };
  const hintN = hints.items.length;
  const hintCur = hintN ? Math.min(hintSel, hintN - 1) : 0;

  useInput((input, key) => {
    if (key.ctrl && input === "c") { onInterrupt(); return; }
    // 菜单打开:Tab 补全高亮项(替换行尾 token),↑↓ 在候选间移动——都不再下落到轮换/工具卡。
    if (hintN && key.tab) {
      const sel = Math.min(hintSelRef.current, hintN - 1);
      const next = applyHint(valueRef.current, hints.items[sel].value);
      valueRef.current = next; setValue(next); setHint(0);
      return;
    }
    if (hintN && (key.upArrow || key.downArrow)) {
      const c = Math.min(hintSelRef.current, hintN - 1);
      setHint(key.upArrow ? (c <= 0 ? hintN - 1 : c - 1) : (c >= hintN - 1 ? 0 : c + 1));
      return;
    }
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
      setHint(0);
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
    // 焦点区滚动(菜单未打开时):↑↓ 行、PgUp/PgDn 页、Esc 回到最新。dims 走 ref 读最新实测值。
    if (key.upArrow) { setScroll(scrollReducer(scrollRef.current, "lineUp", dimsRef.current)); return; }
    if (key.downArrow) { setScroll(scrollReducer(scrollRef.current, "lineDown", dimsRef.current)); return; }
    if (key.pageUp) { setScroll(scrollReducer(scrollRef.current, "pageUp", dimsRef.current)); return; }
    if (key.pageDown) { setScroll(scrollReducer(scrollRef.current, "pageDown", dimsRef.current)); return; }
    if (key.escape) { setScroll(scrollReducer(scrollRef.current, "bottom", dimsRef.current)); return; }
    if (input && !key.ctrl && !key.meta) {
      const next = valueRef.current + input;
      valueRef.current = next;
      setValue(next);
      setHint(0);
    }
  });

  const agents = st.order.length;
  const awaiting = Object.values(st.sessions).filter((s) => s.status === "awaiting").length;
  const fa = st.sessions[st.focusLabel];
  const approve = !!(fa && fa.kind === "flow" && fa.pendingQuestion);
  const scrollOffset = effectiveScroll(scrollState, dims);
  const scrollBar = scrollbar(dims.viewportH, dims.contentH, scrollState);
  // 纵向布局:上半 body(焦点区 | agent 栏)flexGrow 撑满;竖线只在 body 内(rail borderLeft),
  // 到输入框上方即止——不贯穿输入。输入框/状态栏是 column 直接子项 → 横向通栏(左到右)。
  // height=${rows}(终端行高)→ 占满整屏,focus 区 flexGrow 把输入/状态压到最底端。
  return html`<${Box} flexDirection="column" width="100%" height=${rows}>
    <${Box} flexGrow=${1}>
      <${FocusPane} label=${st.focusLabel} sess=${st.sessions[st.focusLabel]} selectedIndex=${selIdx}
        offset=${scrollOffset} bar=${scrollBar} onMeasure=${onMeasure} />
      <${AgentRail} sessions=${st.sessions} order=${st.order} focusLabel=${st.focusLabel} />
    <//>
    <${SystemStrip} messages=${st.system} />
    <${InputBar} focusLabel=${st.focusLabel} value=${value} hints=${hints} selected=${hintCur} approve=${approve} />
    <${StatusBar} agents=${agents} awaiting=${awaiting} mesh=${mesh} />
  <//>`;
}

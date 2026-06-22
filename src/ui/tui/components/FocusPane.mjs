import { useRef, useEffect } from "react";
import { Box, Text, measureElement } from "ink";
import { html } from "../html.mjs";
import { ToolCard } from "./ToolCard.mjs";
import { theme } from "../theme.mjs";
import { estimateLines } from "../scroll.mjs";

// 右侧滚动条:viewportH 个单元,滑块段用 █(accent),轨道用 │(dim)。bar=null 时给等宽空列,保持视口宽度稳定
// (滚动条出现/消失若改变宽度,会让行数估算抖动,边界内容可能反复触发 overflow → 故占位常驻)。
function Scrollbar({ bar }) {
  if (!bar) return html`<${Box} width=${1} marginLeft=${1} />`;
  const cells = [];
  for (let i = 0; i < bar.viewportH; i++) {
    const on = i >= bar.start && i < bar.start + bar.size;
    cells.push(html`<${Text} key=${i} color=${on ? theme.accent : theme.dim}>${on ? "█" : "│"}<//>`);
  }
  return html`<${Box} width=${1} marginLeft=${1} flexDirection="column">${cells}<//>`;
}

export function FocusPane({ label, sess, selectedIndex = -1, offset = 0, bar = null, onMeasure }) {
  const vpRef = useRef(null);
  if (!sess) return html`<${Box} flexGrow=${1} paddingX=${1}><${Text} color=${theme.dim}>无会话。^O 新开一个。<//><//>`;
  const isFlow = sess.kind === "flow";
  const display = isFlow ? `⑂${sess.flowName}` : label;
  // flow:头部 meta = 参与者花名册;普通会话:agent · model · effort
  const meta = isFlow
    ? (sess.agents || []).join(" · ")
    : [sess.agent, sess.model || "default", sess.effort ? `effort ${sess.effort}` : null].filter(Boolean).join(" · ");
  const entries = Array.isArray(sess.entries) ? sess.entries : [];
  const lastAsstIdx = (() => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "assistant") return i; return -1; })();
  const flowEnded = isFlow && (sess.status === "done" || sess.status === "failed");
  const lastSpeaker = flowEnded ? (entries[lastAsstIdx]?.agent || sess.flowName) : null;
  const dotColor = sess.status === "running" ? theme.accent : sess.status === "awaiting" ? theme.warn : theme.ok;
  const statusText = isFlow ? sess.status : `${sess.status} · turn ${sess.turn}${sess.ms ? ` · ${(sess.ms / 1000).toFixed(1)}s` : ""}`;

  // 量真实视口尺寸上报 App(高度可靠;内容总高用 estimateLines 估,只驱动滚动条/中段定位,顶底锚点精确)。
  useEffect(() => {
    if (!vpRef.current || !onMeasure) return;
    const m = measureElement(vpRef.current);
    // 估算宽度留 2 列余量:user/tool 条目自带 paddingX,用满宽会低估行数 → 偏高估更安全(最新行恒可见,最坏下方留白)。
    onMeasure({ viewportH: m.height, contentH: estimateLines(entries, Math.max(1, (m.width || 80) - 2), { isFlow, flowEnded }) });
  });

  const body = (e, i) => {
    if (e.type === "user") return html`<${Box} key=${i} alignSelf="flex-start" backgroundColor=${theme.border} paddingX=${1}><${Text} color=${theme.you} bold>❯ ${e.text}<//><//>`;
    if (e.type === "tool") return html`<${ToolCard} key=${i} entry=${e} selected=${i === selectedIndex} />`;
    if (e.type === "breadcrumb") return html`<${Text} key=${i} color=${theme.breadcrumb}>· ${e.text}<//>`;
    if (e.type === "nudge") return html`<${Text} key=${i} color=${theme.nudge}>↳ ${e.text} · ^G 去看<//>`;
    if (e.type === "output") return html`<${Box} key=${i} marginTop=${1} flexDirection="column">
      <${Text} color=${theme.breadcrumb}>⊟ flow 输出<//>
      <${Text} color=${theme.dim} wrap="truncate-end">${e.text}<//>
    <//>`;
    if (e.type === "approve") return html`<${Text} key=${i} color=${theme.warn} bold>↳ ${e.text} · 在下面作答<//>`;
    return html`<${Text} key=${i} color=${theme.text}>${e.text}${(sess.isStreaming && i === lastAsstIdx) ? "▌" : ""}<//>`;
  };
  let prevTurn = null;
  const content = entries.length === 0
    ? html`<${Text} color=${theme.dim}>(本会话暂无内容)<//>`
    : entries.map((e, i) => {
        const showHead = isFlow && e.turn != null && e.turn !== prevTurn;
        if (isFlow && e.turn != null) prevTurn = e.turn;
        if (!showHead) return body(e, i);
        return html`<${Box} key=${i} flexDirection="column">
          <${Text} bold color=${theme.dim}>${e.agent}<//>
          ${body(e, i)}
        <//>`;
      });
  // 裁剪:视口 overflow:hidden,内层负 marginTop 行级上移,两端由 overflow 裁。
  // (实测 justify-end 在 flexGrow 布局会多吃 1 行吞掉输入栏 → 弃用;贴底由 offset=maxScroll 表达,顶部 offset=0 精确。)
  // 无线条、无色块:头部一行,空一行后是滚动视口(右贴滚动条)。flow 为群聊:每个发言 turn 起插一行暗色名。
  return html`<${Box} flexDirection="column" flexGrow=${1} paddingX=${1}>
    <${Box}>
      <${Text} color=${dotColor}>● <//><${Text} bold color=${theme.text}>${display}<//><${Text} color=${theme.dim}>  ${meta}<//>
      <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color=${theme.dim}>${statusText}<//><//>
    <//>
    <${Box} flexGrow=${1} flexDirection="row" marginTop=${1}>
      <${Box} flexGrow=${1} overflow="hidden" flexDirection="column" ref=${vpRef}>
        <${Box} flexDirection="column" flexShrink=${0} marginTop=${-offset}>
          ${content}
          ${flowEnded ? html`<${Box} marginTop=${1}><${Text} color=${theme.dim}>— flow 已结束 · 输入消息即可在此处继续与 ${lastSpeaker} 对话 · ^W 关 —<//><//>` : null}
        <//>
      <//>
      <${Scrollbar} bar=${bar} />
    <//>
  <//>`;
}

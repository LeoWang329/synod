// src/ui/tui/components/AgentRail.mjs — 右栏 agent 名单。只用一条左竖线(borderLeft)与焦点区分隔,
// 该列纵向铺满 → 竖线贯穿到底。无色块。每卡恒 3 行内容 + 卡间 1 行间隔 = 4 行步距(鼠标命中按此推算)。
// 选中卡:▎左条 + 标签高亮色(accent)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function AgentRail({ sessions, order, focusLabel }) {
  return html`<${Box} flexDirection="column" width=${22} paddingX=${1}
      borderStyle="single" borderColor=${theme.border} borderTop=${false} borderRight=${false} borderBottom=${false}>
    <${Text} color=${theme.dim}>AGENTS · ${order.length}  ↹/^G<//>
    ${order.map((label) => {
      const s = sessions[label]; const sel = label === focusLabel;
      const name = s.kind === "flow" ? `⑂${s.agent}` : label;
      const dotColor = s.status === "running" ? theme.accent : (s.status === "awaiting" || s.status === "failed") ? theme.warn : theme.ok;
      const dot = s.status === "running" ? "●" : s.status === "failed" ? "✗" : s.status === "awaiting" ? "●" : "✓";
      const statusText = s.status === "running" ? `running${s.ms ? ` · ${(s.ms / 1000).toFixed(1)}s` : ""}`
        : s.status === "awaiting" ? "待你" : s.status === "failed" ? "failed" : s.status === "done" ? "done" : "idle";
      const statusColor = s.status === "running" ? theme.accent : (s.status === "awaiting" || s.status === "failed") ? theme.warn : theme.ok;
      return html`<${Box} key=${label} flexDirection="column" marginTop=${1}>
        <${Text} wrap="truncate-end"><${Text} color=${theme.accent}>${sel ? "▎" : " "}<//><${Text} color=${dotColor}>${dot} <//><${Text} bold=${sel} color=${sel ? theme.accent : theme.text}>${name}  t${s.turn}<//><//>
        <${Text} color=${statusColor} wrap="truncate-end"> ${statusText}<//>
        <${Text} color=${theme.dim} wrap="truncate-end"> ${s.lastLine || " "}<//>
      <//>`;
    })}
  <//>`;
}

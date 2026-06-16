// src/ui/tui/components/AgentRail.mjs — 固定高卡片(每卡恒 3 行内容 + 边框 = 5 行,鼠标命中可推算)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function AgentRail({ sessions, order, focusLabel }) {
  return html`<${Box} flexDirection="column" width=${30} borderStyle="single" borderColor=${theme.border}>
    <${Box} paddingX=${1}><${Text} color=${theme.accent}>AGENTS · ${order.length}  ↹/点击<//><//>
    ${order.map((label) => {
      const s = sessions[label]; const sel = label === focusLabel;
      const dotColor = s.status === "running" ? theme.accent : s.status === "awaiting" ? theme.warn : theme.ok;
      const dot = s.status === "idle" ? "✓" : "●";
      const statusText = s.status === "running" ? `running${s.ms ? ` · ${(s.ms/1000).toFixed(1)}s` : ""}`
        : s.status === "awaiting" ? "待你" : "idle";
      const statusColor = s.status === "running" ? theme.accent : s.status === "awaiting" ? theme.warn : theme.ok;
      return html`<${Box} key=${label} flexDirection="column" paddingX=${1}
          borderStyle="single" borderColor=${sel ? theme.accent : theme.border}>
        <${Text} bold=${sel} color=${sel ? theme.accent : theme.text} wrap="truncate-end">
          <${Text} color=${dotColor}>${dot} <//>${label}  t${s.turn}<//>
        <${Text} color=${statusColor} wrap="truncate-end">${statusText}<//>
        <${Text} color=${theme.dim} wrap="truncate-end">${s.lastLine || " "}<//>
      <//>`;
    })}
  <//>`;
}

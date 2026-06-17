// src/ui/tui/components/AgentRail.mjs — 右栏 agent 名单。只用一条左竖线(borderLeft)与焦点区分隔,
// 该列纵向铺满 → 竖线贯穿到底。无色块。每卡恒 3 行内容 + 卡间 1 行间隔 = 4 行步距(鼠标命中按此推算)。
// flow 卡:一行代表整个 flow(⑂flowName + N agents),其内部 agent 不在此单列。
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
      const isFlow = s.kind === "flow";
      const name = isFlow ? `⑂${s.flowName}` : label;
      const turnTag = isFlow ? "" : `  t${s.turn}`;
      const dotColor = s.status === "running" ? theme.accent : (s.status === "awaiting" || s.status === "failed") ? theme.warn : theme.ok;
      const dot = s.status === "running" ? "●" : s.status === "failed" ? "✗" : s.status === "awaiting" ? "●" : "✓";
      const statusText = s.status === "awaiting" ? "待你"
        : s.status === "failed" ? "failed"
        : s.status === "done" ? "done"
        : s.status === "running" ? (isFlow ? `running · ${(s.agents || []).length} agents` : `running${s.ms ? ` · ${(s.ms / 1000).toFixed(1)}s` : ""}`)
        : "idle";
      const statusColor = s.status === "running" ? theme.accent : (s.status === "awaiting" || s.status === "failed") ? theme.warn : theme.ok;
      return html`<${Box} key=${label} flexDirection="column" marginTop=${1}>
        <${Text} wrap="truncate-end"><${Text} color=${theme.accent}>${sel ? "▎" : " "}<//><${Text} color=${dotColor}>${dot} <//><${Text} bold=${sel} color=${sel ? theme.accent : theme.text}>${name}${turnTag}<//><//>
        <${Text} color=${statusColor} wrap="truncate-end"> ${statusText}<//>
        <${Text} color=${theme.dim} wrap="truncate-end"> ${s.lastLine || " "}<//>
      <//>`;
    })}
  <//>`;
}

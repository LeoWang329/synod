// src/ui/tui/components/AgentRail.mjs — 固定高卡片(每卡恒 5 行内容,鼠标命中可推算)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function AgentRail({ sessions, order, focusLabel, relays }) {
  const outTo = (l) => relays.filter((r) => r.from === l).map((r) => r.to);
  const inFrom = (l) => relays.filter((r) => r.to === l).map((r) => r.from);
  return html`<${Box} flexDirection="column" width=${30} borderStyle="single" borderColor="gray">
    <${Box} paddingX=${1}><${Text} color="magenta">AGENTS · ${order.length}  ↹/点击<//><//>
    ${order.map((label) => {
      const s = sessions[label]; const sel = label === focusLabel;
      const out = outTo(label), inn = inFrom(label);
      return html`<${Box} key=${label} flexDirection="column" paddingX=${1}
          borderStyle="single" borderColor=${sel ? "blue" : "gray"}>
        <${Text} bold=${sel} color=${sel ? "blue" : undefined} wrap="truncate-end">
          ${s.status === "running" ? "● " : "✓ "}${label}  t${s.turn}<//>
        <${Text} color=${s.status === "running" ? "blue" : "green"} wrap="truncate-end">
          ${s.status === "running" ? "running" : "idle"}${s.ms ? ` · ${(s.ms/1000).toFixed(1)}s` : ""}<//>
        <${Text} color="magenta" wrap="truncate-end">${out.length ? "▶ " + out.join(",") : " "}<//>
        <${Text} dimColor wrap="truncate-end">${inn.length ? "◀ " + inn.join(",") : " "}<//>
        <${Text} dimColor wrap="truncate-end">${s.lastLine || " "}<//>
      <//>`;
    })}
  <//>`;
}

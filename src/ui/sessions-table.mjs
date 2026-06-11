// synod/src/ui/sessions-table.mjs — /sessions 表格(§4)。纯函数;colorOn 时着色 label。
import { color, labelColor } from "./ansi.mjs";

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderSessionsTable({ sessions, currentLabel, relays = [], colorOn = false }) {
  const out = [""];
  out.push("   LABEL    BACKEND  MODEL              STATE     TURNS  RELAY");
  for (const s of sessions) {
    const marker = s.label === currentLabel ? "*" : " ";
    const edges = [
      ...relays.filter((r) => r.from === s.label).map((r) => `→ ${r.to}`),
      ...relays.filter((r) => r.to === s.label).map((r) => `← ${r.from}`),
    ].join(" ");
    const labelCell = colorOn
      ? color(labelColor(s.label), pad(s.label, 8))
      : pad(s.label, 8);
    const row =
      ` ${marker} ${labelCell} ${pad(s.agent, 7)} ${pad(s.model || "(default)", 17)} ` +
      `${pad(s.status, 8)} ${pad(String(s.turns), 5)}  ${edges}`;
    out.push(row.replace(/\s+$/, ""));
  }
  out.push("");
  return out.join("\n") + "\n";
}

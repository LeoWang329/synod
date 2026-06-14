// src/ui/tui/components/ToolCard.mjs — 工具调用卡:收起摘要 / 展开 args+diff+output。
import { Box, Text } from "ink";
import { html } from "../html.mjs";

const MAX_OUT_LINES = 12;
const MAX_LINE_CHARS = 200;

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
function argsSummary(args) {
  if (args == null) return "";
  const s = typeof args === "string" ? args : safeStringify(args);
  return s.length > 48 ? s.slice(0, 48) + "…" : s;
}
function clampLines(text, n) {
  const raw = String(text || "").split("\n");
  const capped = raw.map((l) => l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "…" : l);
  if (capped.length <= n) return { body: capped.join("\n"), more: 0 };
  return { body: capped.slice(0, n).join("\n"), more: capped.length - n };
}

export function ToolCard({ entry, selected }) {
  const mark = entry.expanded ? "▾" : "▸";
  const statusColor = entry.status === "running" ? "yellow" : (entry.ok === false ? "red" : "green");
  const statusText = entry.status === "running" ? "running" : (entry.ok === false ? "failed" : "done");
  const head = html`<${Text} wrap="truncate-end" color=${selected ? "blue" : undefined} bold=${selected}>
    ${mark} 🔧 <${Text} bold>${entry.name}<//>${argsSummary(entry.args) ? html`<${Text} dimColor>(${argsSummary(entry.args)})<//>` : null} <${Text} color=${statusColor}>· ${statusText}<//><//>`;
  if (!entry.expanded) return html`<${Box} paddingX=${1}>${head}<//>`;
  const out = clampLines(entry.output, MAX_OUT_LINES);
  return html`<${Box} flexDirection="column" paddingX=${1} borderStyle="round" borderColor=${selected ? "blue" : "gray"}>
    ${head}
    ${entry.args != null ? html`<${Text} dimColor wrap="truncate-end">args: ${typeof entry.args === "string" ? entry.args : safeStringify(entry.args)}<//>` : null}
    ${entry.diff ? html`<${Box} flexDirection="column"><${Text} color="cyan">diff:<//><${Text}>${entry.diff}<//><//>` : null}
    ${entry.output ? html`<${Box} flexDirection="column"><${Text} dimColor>output:<//><${Text}>${out.body}<//>${out.more ? html`<${Text} dimColor>… (+${out.more} 行)<//>` : null}<//>` : null}
  <//>`;
}

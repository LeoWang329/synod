// src/ui/tui/components/SystemStrip.mjs — 渲染来自捕获流/错误的系统消息(最近 3 条)。
import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function SystemStrip({ messages }) {
  const recent = (messages || []).slice(-3);
  if (recent.length === 0) return html`<${Box}/>`;
  return html`<${Box} flexDirection="column" paddingX=${1}>
    ${recent.map((m, i) => html`<${Text} key=${i} dimColor wrap="truncate-end">· ${m}<//>`)}
  <//>`;
}

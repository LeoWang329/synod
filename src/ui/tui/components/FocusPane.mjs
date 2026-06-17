import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { ToolCard } from "./ToolCard.mjs";
import { theme } from "../theme.mjs";
export function FocusPane({ label, sess, selectedIndex = -1 }) {
  if (!sess) return html`<${Box} flexGrow=${1} paddingX=${1}><${Text} color=${theme.dim}>无会话。^O 新开一个。<//><//>`;
  const meta = [sess.agent, sess.model || "default", sess.effort ? `effort ${sess.effort}` : null].filter(Boolean).join(" · ");
  const display = sess.kind === "flow" ? `⑂${sess.agent}` : label;
  const entries = Array.isArray(sess.entries) ? sess.entries : [];
  const lastAsstIdx = (() => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "assistant") return i; return -1; })();
  const dotColor = sess.status === "running" ? theme.accent : sess.status === "awaiting" ? theme.warn : theme.ok;
  const statusText = `${sess.status} · turn ${sess.turn}${sess.ms ? ` · ${(sess.ms / 1000).toFixed(1)}s` : ""}`;
  // 无线条、无色块:头部一行,空一行后是对话流。
  return html`<${Box} flexDirection="column" flexGrow=${1} paddingX=${1}>
    <${Box}>
      <${Text} color=${dotColor}>● <//><${Text} bold color=${theme.text}>${display}<//><${Text} color=${theme.dim}>  ${meta}<//>
      <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color=${theme.dim}>${statusText}<//><//>
    <//>
    <${Box} flexGrow=${1} flexDirection="column" marginTop=${1}>
      ${entries.length === 0 ? html`<${Text} color=${theme.dim}>(本会话暂无内容)<//>` : entries.map((e, i) => {
        if (e.type === "user") return html`<${Box} key=${i} alignSelf="flex-start" backgroundColor=${theme.border} paddingX=${1}><${Text} color=${theme.you} bold>❯ ${e.text}<//><//>`;
        if (e.type === "tool") return html`<${ToolCard} key=${i} entry=${e} selected=${i === selectedIndex} />`;
        if (e.type === "breadcrumb") return html`<${Text} key=${i} color=${theme.breadcrumb}>· ${e.text}<//>`;
        if (e.type === "nudge") return html`<${Text} key=${i} color=${theme.nudge}>↳ ${e.text} · ^G 去看<//>`;
        if (e.type === "output") return html`<${Text} key=${i} color=${theme.dim} wrap="truncate-end">${e.text}<//>`;
        if (e.type === "approve") return html`<${Text} key=${i} color=${theme.warn} bold>↳ ${e.text} · 在下面作答<//>`;
        return html`<${Text} key=${i} color=${theme.text}>${e.text}${(sess.isStreaming && i === lastAsstIdx) ? "▌" : ""}<//>`;
      })}
    <//>
  <//>`;
}

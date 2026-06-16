import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { ToolCard } from "./ToolCard.mjs";
import { theme } from "../theme.mjs";
export function FocusPane({ label, sess, selectedIndex = -1 }) {
  if (!sess) return html`<${Box} flexGrow=${1} paddingX=${1}><${Text} color=${theme.dim}>无会话。^O 新开一个。<//><//>`;
  const meta = [sess.agent, sess.model || "default", sess.effort ? `effort ${sess.effort}` : null].filter(Boolean).join(" · ");
  const entries = Array.isArray(sess.entries) ? sess.entries : [];
  const lastAsstIdx = (() => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "assistant") return i; return -1; })();
  const headColor = sess.status === "running" ? theme.accent : sess.status === "awaiting" ? theme.warn : theme.ok;
  const body = html`<${Box} flexGrow=${1} flexDirection="column" paddingX=${1}>
    ${entries.length === 0 ? html`<${Text} color=${theme.dim}>(本会话暂无内容)<//>` : entries.map((e, i) => {
      if (e.type === "user") return html`<${Text} key=${i} color=${theme.you}>❯ ${e.text}<//>`;
      if (e.type === "tool") return html`<${ToolCard} key=${i} entry=${e} selected=${i === selectedIndex} />`;
      if (e.type === "breadcrumb") return html`<${Text} key=${i} color=${theme.breadcrumb}>· ${e.text}<//>`;
      if (e.type === "nudge") return html`<${Text} key=${i} color=${theme.nudge}>↳ ${e.text} · ^G 去看<//>`;
      return html`<${Text} key=${i} color=${theme.text}>${e.text}${(sess.isStreaming && i === lastAsstIdx) ? "▌" : ""}<//>`;
    })}
  <//>`;
  return html`<${Box} flexDirection="column" flexGrow=${1}>
    <${Box} flexDirection="column" borderStyle="single" borderColor=${theme.accent} paddingX=${1}>
      <${Box}>
        <${Text} color=${headColor}>● <//><${Text} bold color=${theme.accent}>${label}<//>
        <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color=${headColor}>
          ${sess.status} · turn ${sess.turn}${sess.ms ? ` · ${(sess.ms/1000).toFixed(1)}s` : ""}<//><//>
      <//>
      <${Text} color=${theme.dim}>${meta}<//>
    <//>
    ${body}
  <//>`;
}

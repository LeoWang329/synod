import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { ToolCard } from "./ToolCard.mjs";
import { theme } from "../theme.mjs";
export function FocusPane({ label, sess, selectedIndex = -1 }) {
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
  // 无线条、无色块:头部一行,空一行后是对话流(flow 为群聊:每个发言 turn 起插一行暗色名;
  // 按 turn 而非发言人名变化分段——同 model 的两次 agent() 调用也各成一段。无 turn 的条目如 nudge 不触发头)。
  return html`<${Box} flexDirection="column" flexGrow=${1} paddingX=${1}>
    <${Box}>
      <${Text} color=${dotColor}>● <//><${Text} bold color=${theme.text}>${display}<//><${Text} color=${theme.dim}>  ${meta}<//>
      <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color=${theme.dim}>${statusText}<//><//>
    <//>
    <${Box} flexGrow=${1} flexDirection="column" marginTop=${1}>
      ${entries.length === 0 ? html`<${Text} color=${theme.dim}>(本会话暂无内容)<//>` : entries.map((e, i) => {
        const showHead = isFlow && e.turn != null && e.turn !== prevTurn;
        if (isFlow && e.turn != null) prevTurn = e.turn;
        if (!showHead) return body(e, i);
        return html`<${Box} key=${i} flexDirection="column">
          <${Text} bold color=${theme.dim}>${e.agent}<//>
          ${body(e, i)}
        <//>`;
      })}
      ${flowEnded ? html`<${Box} marginTop=${1}><${Text} color=${theme.dim}>— flow 已结束 · 输入消息即可在此处继续与 ${lastSpeaker} 对话 · ^W 关 —<//><//>` : null}
    <//>
  <//>`;
}

import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { CollapsibleStrip } from "./CollapsibleStrip.mjs";
import { ToolCard } from "./ToolCard.mjs";
export function FocusPane({ label, sess, fence, relays, expandC = false, expandD = false, selectedIndex = -1 }) {
  if (!sess) return html`<${Box} flexGrow=${1} paddingX=${1}><${Text} dimColor>无会话。^O 新开一个。<//><//>`;
  const meta = [sess.agent, sess.model || "default", sess.effort ? `effort ${sess.effort}` : null].filter(Boolean).join(" · ");
  const out = relays.filter((r) => r.from === label).map((r) => r.to);
  const inn = relays.filter((r) => r.to === label).map((r) => r.from);
  const cSummary = fence ? `${fence.commands.length} cmds${fence.feedbackSent ? " · 回喂已发" : ""}` : "—";
  const dSummary = `▶ out ${out.join(",") || "—"} · ◀ in ${inn.join(",") || "—"}`;
  const entries = Array.isArray(sess.entries) ? sess.entries : [];
  const lastAsstIdx = (() => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "assistant") return i; return -1; })();
  const body = html`<${Box} flexGrow=${1} flexDirection="column" paddingX=${1}>
    ${entries.length === 0 ? html`<${Text} dimColor>(本会话暂无内容)<//>` : entries.map((e, i) => {
      if (e.type === "user") return html`<${Text} key=${i} color="green">❯ ${e.text}<//>`;
      if (e.type === "tool") return html`<${ToolCard} key=${i} entry=${e} selected=${i === selectedIndex} />`;
      return html`<${Text} key=${i}>${e.text}${(sess.isStreaming && i === lastAsstIdx) ? "▌" : ""}<//>`;
    })}
  <//>`;
  return html`<${Box} flexDirection="column" flexGrow=${1}>
    <${Box} flexDirection="column" borderStyle="single" borderColor="blue" paddingX=${1}>
      <${Box}>
        <${Text} color=${sess.status === "running" ? "blue" : "green"}>● <//><${Text} bold color="blue">${label}<//>
        <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} color="blue">
          ${sess.status} · turn ${sess.turn}${sess.ms ? ` · ${(sess.ms/1000).toFixed(1)}s` : ""}<//><//>
      <//>
      <${Text} dimColor>${meta}<//>
    <//>
    ${body}
    <${CollapsibleStrip} label="C 编排意图" summary=${cSummary} expanded=${expandC} hot=${Boolean(fence && !fence.seen)}
      detail=${fence ? fence.commands.map((c) => `${c.cmd} → ${c.result}`).join("\n") : ""} />
    <${CollapsibleStrip} label="D relay" summary=${dSummary} expanded=${expandD}
      detail=${`out: ${out.join(",") || "—"}\nin: ${inn.join(",") || "—"}`} />
  <//>`;
}

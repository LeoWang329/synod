import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function InputBar({ focusLabel, value, hints }) {
  return html`<${Box} flexDirection="column">
    ${hints && hints.items.length ? html`<${Box} flexDirection="column" paddingX=${1}>
      ${hints.items.slice(0, 6).map((it) => html`<${Box} key=${it.value}>
        <${Text} color=${theme.tool}>${it.value}<//>${it.desc ? html`<${Text} color=${theme.dim}>  ${it.desc}<//>` : null}
      <//>`)}
    <//>` : null}
    <${Box} borderStyle="single" borderColor=${theme.borderBright} borderLeft=${false} borderRight=${false} paddingX=${1}>
      <${Text} color=${theme.accent} bold>[${focusLabel || "—"}] ❯ <//><${Text} color=${theme.text}>${value}▌<//>
    <//>
  <//>`;
}

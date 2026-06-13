import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function InputBar({ focusLabel, value, hints }) {
  return html`<${Box} flexDirection="column">
    ${hints && hints.items.length ? html`<${Box} flexDirection="column" paddingX=${1}>
      ${hints.items.slice(0, 6).map((it) => html`<${Box} key=${it.value}>
        <${Text} color="cyan">${it.value}<//>${it.desc ? html`<${Text} dimColor>  ${it.desc}<//>` : null}
      <//>`)}
    <//>` : null}
    <${Box} borderStyle="single" borderColor="blue" paddingX=${1}>
      <${Text} color="green" bold>[${focusLabel || "—"}] ❯ <//><${Text}>${value}▌<//>
    <//>
  <//>`;
}

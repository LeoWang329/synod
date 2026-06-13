import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function CollapsibleStrip({ label, summary, expanded, detail, hot }) {
  return html`<${Box} flexDirection="column" borderStyle="single" borderColor="gray" paddingX=${1}>
    <${Box}>
      <${Text}>${expanded ? "▾" : "▸"} <${Text} bold>${label}<//>${hot ? html`<${Text} color="yellow"> ●<//>` : null}<//>
      <${Box} flexGrow=${1} justifyContent="flex-end"><${Text} dimColor>${summary}<//><//>
    <//>
    ${expanded ? html`<${Text}>${detail}<//>` : null}
  <//>`;
}

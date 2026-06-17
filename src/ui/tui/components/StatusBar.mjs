import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
export function StatusBar({ agents, awaiting, mesh }) {
  return html`<${Box} justifyContent="space-between" paddingX=${1}>
    <${Text} color=${theme.dim}>↹ 切  ^O 开  ^W 关  ↑↓ 选  ^E 展开  / 命令  ^C 中断  ^G 去看  ? 帮助<//>
    <${Text} color=${theme.warn}>${agents} agents · ${awaiting} 待你 · mesh ${mesh ? "on" : "off"}<//>
  <//>`;
}

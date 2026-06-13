import { Box, Text } from "ink";
import { html } from "../html.mjs";
export function StatusBar({ running, mesh }) {
  return html`<${Box} justifyContent="space-between" paddingX=${1}>
    <${Text} dimColor>↹ 切焦点  ^O 开  ^W 关  / 命令  ^C 退出<//>
    <${Text} color="blue">● ${running} running · mesh ${mesh ? "on" : "off"}<//>
  <//>`;
}

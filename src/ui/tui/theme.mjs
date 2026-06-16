// src/ui/tui/theme.mjs — Catppuccin Mocha 配色:语义角色 → #hex。换主题只改这里。
// Ink <Text color> / <Box borderColor> 接受 #hex(truecolor 直出,旧终端自动降到最近 ANSI)。
export const theme = {
  bg: "#1e1e2e", bg2: "#181825",
  border: "#313244", borderBright: "#45475a",
  text: "#cdd6f4", dim: "#6c7086",
  accent: "#89b4fa",      // label·焦点·提示符·光标
  you: "#a6e3a1",         // 用户输入标记
  tool: "#94e2d5",        // 工具卡 / 提示候选
  ok: "#a6e3a1",          // 成功 / idle / done
  warn: "#fab387",        // 待你 / 计数 / 高亮
  breadcrumb: "#7f849c",  // 编排面包屑(压低)
  nudge: "#cba6f7",       // 后台冒泡 ↳
};

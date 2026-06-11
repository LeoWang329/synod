// synod/src/ui/prompt.mjs — 主持人模式提示符:模式徽标 + 当前会话 + 忙闲(§1)。
// 非 TTY 恒退化为 "> "(与现状一致,不破 e2e 的 "> " 探测)。徽标色:主持人=青(36)。
import { color, enabled } from "./ansi.mjs";

/** 据当前 sm 状态渲染一行提示符字符串(含尾随空格)。 */
export function renderPrompt({ sm, stdout, env = process.env }) {
  if (!enabled(stdout, env)) return "> ";   // 非 TTY 或 NO_COLOR → 恒 "> "(硬约束2)
  const paint = (s) => color(36, s);

  const cur = sm.currentLabel;
  if (!cur) return `${paint("synod")} ❯ `;

  let running = 0;
  for (const [, info] of sm._sessions) {
    if (info.session && info.session.status === "running") running += 1;
  }
  const curRunning = sm._sessions.get(cur)?.session?.status === "running";
  const others = running - (curRunning ? 1 : 0);

  let inner = cur;
  if (curRunning) inner += " ⠧";            // 当前忙:静态忙标(不做定时器动画,§1)
  if (others > 0) inner += ` ${others} running`;
  return `${paint(`[${inner}]`)} ❯ `;
}

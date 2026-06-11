// synod/src/ui/decorations.mjs — 多路输出的装饰行渲染(§2.2 turn 边界线 / §2.3 relay 横幅)。
// 纯函数;仅在 enabled(stdout) 为真(TTY)时被调用 → 总是着色输出。
import { color, labelColor } from "./ansi.mjs";

/** [label] ── done · Xs ────────── (dim 暗色;§2.2)。 */
export function turnBoundary(label, secs) {
  const prefix = color(labelColor(label), `[${label}]`);
  const body = color(2, `── done · ${secs}s ${"─".repeat(10)}`);
  return `${prefix} ${body}\n`;
}

/** [to] ◀─ relay from <from> (Nk chars) (§2.3 转发可视化)。 */
export function relayBanner(to, from, chars) {
  const k = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`;
  const prefix = color(labelColor(to), `[${to}]`);
  const body = color(2, `◀─ relay from ${from} (${k} chars)`);
  return `${prefix} ${body}\n`;
}

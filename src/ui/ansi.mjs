// synod/src/ui/ansi.mjs — 零依赖手写 ANSI。所有 UI 模块经此出字,禁裸写 \x1b[。
//
// 门控语义(§8.1 / 硬约束 2):enabled(stream, env) = stream.isTTY && !NO_COLOR。
// 非 TTY / 管道 / CI / NO_COLOR → false → 调用方一律走纯文本路径,零序列。
// Windows:Node 在 Win10+ / Windows Terminal 自动启用 VT 处理,isTTY 为真即可着色;
// 旧 conhost 不解析也只静默吞掉 SGR,非 TTY(含 Windows 管道)则根本不出序列。

// 8 色调色板(§2.1):绿/黄/蓝/品红/青/亮绿/亮黄/亮品红。
const PALETTE = [32, 33, 34, 35, 36, 92, 93, 95];

/** stream 可着色?TTY 且未设 NO_COLOR(空串视为未设)。 */
export function enabled(stream, env = process.env) {
  return Boolean(stream && stream.isTTY) && !env.NO_COLOR;
}

/** 用 SGR code 包裹 s 并 reset。调用前自行判 enabled()。 */
export function color(code, s) {
  return `\x1b[${code}m${s}\x1b[0m`;
}

/** label → 固定 SGR code(同 label 永远同色,8 色循环)。 */
export function labelColor(label) {
  let h = 0;
  for (let i = 0; i < label.length; i += 1) {
    h = (Math.imul(h, 31) + label.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** 去除 SGR 序列(测试断言「strip 后等于纯文本路径」用)。 */
export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

export const PALETTE_CODES = PALETTE;

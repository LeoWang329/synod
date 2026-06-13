// src/ui/tui/mouse.mjs — 手搓鼠标:SGR 上报开关、缓冲解析、区域注册 + 命中。
// 只开 1000(按键)+1006(SGR 坐标,支持 >223 列);不开 1002,避免拖动 motion 噪声。
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

// \x1b[<B;X;Y(M|m):M=按下/滚动,m=释放。B bit0-1=按钮,bit5(32)=motion,>=64=滚轮。
const SGR_G = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** 从输入缓冲提取所有完整鼠标事件,返回 { events, rest }(rest=尾部未完成片段)。 */
export function drainMouse(buf) {
  const events = [];
  let lastEnd = 0;
  SGR_G.lastIndex = 0;
  let m;
  while ((m = SGR_G.exec(buf)) !== null) {
    const b = Number(m[1]);
    events.push({
      x: Number(m[2]), y: Number(m[3]),
      button: b & 3, press: m[4] === "M",
      motion: (b & 32) !== 0, wheel: b >= 64 ? ((b & 1) ? 1 : -1) : 0,
    });
    lastEnd = SGR_G.lastIndex;
  }
  // 残段:最后一个 ESC 起、未被完整匹配的尾巴(可能是被截断的序列)。
  const tailEsc = buf.lastIndexOf("\x1b", buf.length);
  const rest = tailEsc >= lastEnd ? buf.slice(tailEsc) : "";
  return { events, rest };
}

export function isLeftClick(ev) {
  return Boolean(ev && ev.press && !ev.motion && ev.wheel === 0 && ev.button === 0);
}

export class RegionRegistry {
  constructor() { this.map = new Map(); }
  set(id, rect) { this.map.set(id, rect); }
  clear() { this.map.clear(); }
  hit(x, y) {
    for (const [id, r] of this.map) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return id;
    }
    return null;
  }
}

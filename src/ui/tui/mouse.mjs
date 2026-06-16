// src/ui/tui/mouse.mjs — 手搓鼠标:SGR 上报开关、缓冲解析、区域注册 + 命中。
// 只开 1000(按键)+1006(SGR 坐标,支持 >223 列);不开 1002,避免拖动 motion 噪声。
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

// \x1b[<B;X;Y(M|m):M=按下/滚动,m=释放。B bit0-1=按钮,bit5(32)=motion,>=64=滚轮。
const SGR_G = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// 末尾「尚未完整的鼠标序列前缀」:\x1b / \x1b[ / \x1b[< / \x1b[<12;3 …(还没收到收尾的 M|m)。
// 只匹配真正能长成鼠标序列的前缀——\x1b[A 这类方向键不在内,故会被透传而非误吞。
const MOUSE_PARTIAL_TAIL = /\x1b(?:\[(?:<[0-9;]*)?)?$/;

/**
 * 从输入缓冲分离鼠标与键盘:返回 { events, passthrough, rest }。
 *  - events:本次提取到的完整鼠标事件。
 *  - passthrough:剥掉鼠标序列后剩下的「键盘字节」,按原序拼回 → 应转交 Ink。
 *  - rest:尾部尚未完整的鼠标序列前缀,留待与下一块拼接(键盘残段不在此,直接透传)。
 *
 * 关键:Ink 与本模块共享同一条 stdin,Node 流会把每个 chunk 广播给所有监听者——
 * 本模块无法「吃掉」字节让 Ink 看不到。所以由本模块独占读取真 stdin,把 passthrough
 * 单独喂给 Ink 的代理流;鼠标字节因此永不进入 Ink 的 useInput(否则会被当文本插入输入框)。
 */
export function drainMouse(buf) {
  const events = [];
  let passthrough = "";
  let lastEnd = 0;
  SGR_G.lastIndex = 0;
  let m;
  while ((m = SGR_G.exec(buf)) !== null) {
    passthrough += buf.slice(lastEnd, m.index);   // 两个鼠标事件之间的键盘字节
    const b = Number(m[1]);
    events.push({
      x: Number(m[2]), y: Number(m[3]),
      button: b & 3, press: m[4] === "M",
      motion: (b & 32) !== 0, wheel: b >= 64 ? ((b & 1) ? 1 : -1) : 0,
    });
    lastEnd = SGR_G.lastIndex;
  }
  // 尾巴:只有「能长成鼠标序列的前缀」才留作 rest 等待拼接;其余(键盘转义/普通文本)透传。
  const tail = buf.slice(lastEnd);
  const pm = tail.match(MOUSE_PARTIAL_TAIL);
  let rest = "";
  if (pm) {
    rest = tail.slice(pm.index);
    passthrough += tail.slice(0, pm.index);
  } else {
    passthrough += tail;
  }
  return { events, passthrough, rest };
}

/**
 * 有状态的 stdin 拆分器:跨 chunk 缓冲未完整的鼠标前缀,逐块返回 { events, passthrough }。
 * mbuf 只承载「鼠标前缀残段」(始终以 ESC 起),已透传的键盘字节不会再回到 mbuf,故无重复透传。
 */
export function createStdinSplitter() {
  let mbuf = "";
  return function feed(chunkStr) {
    mbuf += chunkStr;
    const { events, passthrough, rest } = drainMouse(mbuf);
    mbuf = rest.length < 64 ? rest : "";   // 防御:异常超长残段丢弃,避免 mbuf 无限增长
    return { events, passthrough };
  };
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

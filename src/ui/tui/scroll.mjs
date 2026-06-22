// src/ui/tui/scroll.mjs — 焦点区滚动的纯逻辑(无 Ink 依赖,可单测)。
//
// 为什么独立成纯函数:Ink 的 overflow 裁剪在 ink-testing-library 里渲染不准(把 N 行压成隔行采样),
// smoke 的帧捕获又是累积式 —— 视觉裁剪两者都测不准。故把「滚动状态机 + 行数估算 + 滚动条几何」全部
// 抽到这里做确定性单测,视口的真实裁剪交给真终端(负 marginTop / justify-end 在真 Ink 上正确,已 probe 验证)。
//
// 两个锚点天然精确,与估算无关:scroll=0(marginTop 0)= 精确顶部;stick(justify-end 底对齐)= 精确底部。
// estimateLines 只影响中间滚动位置与滚动条粗细 —— 估不准也绝不会「看不全」。

export function maxScrollOf(contentH, viewportH) {
  return Math.max(0, (contentH || 0) - (viewportH || 0));
}

// 滚动状态机。state = { scroll, stick }(stick=跟随最新,渲染走 justify-end 精确底对齐)。
// 内容放得下(max<=0)时恒为 stick。lineDown/pageDown 触底自动恢复 stick;up/top 离开 stick。
export function scrollReducer(state, action, { contentH = 0, viewportH = 0 } = {}) {
  const max = maxScrollOf(contentH, viewportH);
  if (max <= 0) return { scroll: 0, stick: true };
  const eff = state.stick ? max : Math.min(Math.max(state.scroll || 0, 0), max);
  const page = Math.max(1, (viewportH || 1) - 1);
  if (action === "bottom") return { scroll: 0, stick: true };
  let ns = eff;
  if (action === "lineUp") ns = eff - 1;
  else if (action === "lineDown") ns = eff + 1;
  else if (action === "pageUp") ns = eff - page;
  else if (action === "pageDown") ns = eff + page;
  else if (action === "top") ns = 0;
  ns = Math.min(Math.max(ns, 0), max);
  return ns >= max ? { scroll: 0, stick: true } : { scroll: ns, stick: false };   // stick 态规范化为 scroll:0
}

// 当前实际行偏移(stick → 贴底 = max)。供滚动条与渲染偏移取用。
export function effectiveScroll(state, { contentH = 0, viewportH = 0 } = {}) {
  const max = maxScrollOf(contentH, viewportH);
  return state.stick ? max : Math.min(Math.max(state.scroll || 0, 0), max);
}

// 滚动条滑块几何:thumb 高 ∝ 视口/内容,位置 ∝ 偏移/max。内容放得下时返回 null(不画条)。
export function scrollbar(viewportH, contentH, state) {
  const max = maxScrollOf(contentH, viewportH);
  if (max <= 0 || !viewportH) return null;
  const eff = state.stick ? max : Math.min(Math.max(state.scroll || 0, 0), max);
  const size = Math.min(viewportH, Math.max(1, Math.round((viewportH * viewportH) / contentH)));
  const start = Math.min(Math.max(Math.round((eff / max) * (viewportH - size)), 0), viewportH - size);
  return { size, start, viewportH };
}

// 终端列宽(CJK 全角计 2,组合/零宽计 0)。够估算用,不追求 string-width 全表精度。
export function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 0x200b || (c >= 0x0300 && c <= 0x036f)) continue;   // 零宽 / 组合记号
    w += isWide(c) ? 2 : 1;
  }
  return w;
}
function isWide(c) {
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd);
}
const wrapCount = (text, width) =>
  String(text ?? "").split("\n").reduce((n, seg) => n + Math.max(1, Math.ceil(strWidth(seg) / Math.max(1, width))), 0);
const lineCount = (text) => String(text ?? "").split("\n").length;

// 展开 tool 卡的行数(对齐 ToolCard.mjs:圆角边框上下 2 + head 1 + args + diff + output;output 截至 12 行)。
function expandedToolLines(e) {
  let n = 2 + 1;                                  // border(2) + head(1)
  if (e.args != null) n += 1;
  if (e.diff) n += 1 + lineCount(e.diff);
  if (e.output) { const ol = lineCount(e.output); n += 1 + Math.min(ol, 12) + (ol > 12 ? 1 : 0); }
  return n;
}
function entryLines(e, width) {
  switch (e.type) {
    case "tool": return e.expanded ? expandedToolLines(e) : 1;
    case "output": return 3;                       // marginTop(1) + 「⊟ flow 输出」(1) + 截断正文(1)
    case "user": return wrapCount(`❯ ${e.text}`, width);
    case "breadcrumb": return wrapCount(`· ${e.text}`, width);
    case "nudge": return wrapCount(`↳ ${e.text} · ^G 去看`, width);
    case "approve": return wrapCount(`↳ ${e.text} · 在下面作答`, width);
    default: return wrapCount(e.text, width);      // assistant / 其它文本
  }
}

// 估算可见内容总行数(含 flow 每个发言 turn 起的暗色名头一行,与 flowEnded 提示二行)。
// 与 FocusPane 渲染保持手工对齐 —— 仅驱动滚动条粗细与中段定位,顶/底锚点精确不依赖它。
export function estimateLines(entries, width, { isFlow = false, flowEnded = false } = {}) {
  const es = Array.isArray(entries) ? entries : [];
  let total = 0, prevTurn = null;
  for (const e of es) {
    if (isFlow && e.turn != null && e.turn !== prevTurn) { total += 1; prevTurn = e.turn; }
    total += entryLines(e, width);
  }
  if (flowEnded) total += 2;                        // 「— flow 已结束 … —」marginTop(1) + 一行
  return total;
}

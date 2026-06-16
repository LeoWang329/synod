// src/ui/tui/index.mjs — 启动/拆除全屏 TUI。Ink 动态 import(核心零依赖路径不触发)。
import { PassThrough } from "node:stream";
import { MOUSE_ON, MOUSE_OFF, createStdinSplitter, isLeftClick, RegionRegistry } from "./mouse.mjs";

export const ENTER_ALT = "\x1b[?1049h";
export const EXIT_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// Ink 用 readable/read() 读输入(不是 data 事件),并要求 isTTY/setRawMode/setEncoding/ref/unref。
// 这个代理流只承载「键盘字节」:本模块独占读真 stdin、剥离鼠标后写入它;Ink 从它读 → 鼠标字节
// 永不进入 useInput(否则会被当普通文本插入输入框,即「动鼠标输入框冒字符」的根因)。
// setRawMode 转发到真 stdin;isTTY 如实映射(非 TTY 时 Ink 仍照常报 raw 不支持,与改动前一致)。
export function createInkStdin(realStdin) {
  const proxy = new PassThrough();
  proxy.isTTY = Boolean(realStdin.isTTY);
  proxy.setRawMode = (mode) => { realStdin.setRawMode?.(mode); return proxy; };
  if (typeof proxy.ref !== "function") proxy.ref = () => proxy;
  if (typeof proxy.unref !== "function") proxy.unref = () => proxy;
  return proxy;
}

export function buildTeardown(stdout) {
  let done = false;
  return function teardown() {
    if (done) return; done = true;
    try { stdout.write(MOUSE_OFF + SHOW_CURSOR + EXIT_ALT); } catch {}
  };
}

// 右栏 agent 卡矩形(1-based)。右栏宽 30 贴右;rail 顶边框 1 行 + header 1 行 → 首卡从第 3 行起;
// 每卡 borderStyle 占 7 行(见 AgentRail 固定高说明)。纯函数,便于单测。
export function computeRailRegions(order, cols) {
  const x = (cols || 100) - 30 + 1;     // 1-based 左边界
  const regs = {};
  order.forEach((label, i) => { regs[`agent:${label}`] = { x, y: 3 + i * 7, w: 30, h: 7 }; });
  return regs;
}

export async function startTui({ store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt, stdin = process.stdin, stdout = process.stdout }) {
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { App } = await import("./app.mjs");
  const { registerEventAdapter } = await import("./events.mjs");
  const { ompAdapter } = await import("./adapters.omp.mjs");
  const { codexAdapter } = await import("./adapters.codex.mjs");
  registerEventAdapter("omp", ompAdapter);
  registerEventAdapter("codex", codexAdapter);

  stdout.write(ENTER_ALT + HIDE_CURSOR + MOUSE_ON);
  const teardown = buildTeardown(stdout);

  const regions = new RegionRegistry();
  const relayout = () => {
    regions.clear();
    const regs = computeRailRegions(store.getState().order, stdout.columns);
    for (const [id, r] of Object.entries(regs)) regions.set(id, r);
  };
  relayout();
  const unsub = store.subscribe(relayout);
  const onResize = () => relayout();
  stdout.on?.("resize", onResize);

  // stdin 解复用:本模块独占读真 stdin → 拆出鼠标事件(命中右栏卡 → onSelect)与键盘 passthrough;
  // 键盘字节写入 inkStdin 代理流交给 Ink。鼠标 SGR 序列就此被剥离,不会泄漏成输入框文本。
  const inkStdin = createInkStdin(stdin);
  const split = createStdinSplitter();
  function onData(chunk) {
    const { events, passthrough } = split(chunk.toString("utf8"));
    if (passthrough) inkStdin.write(passthrough);
    for (const ev of events) {
      if (!isLeftClick(ev)) continue;
      const id = regions.hit(ev.x, ev.y);
      if (id && id.startsWith("agent:")) onSelect(id.slice("agent:".length));
    }
  }
  stdin.on("data", onData);

  const instance = render(
    React.createElement(App, { store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt }),
    { stdout, stdin: inkStdin, exitOnCtrlC: false },
  );

  const cleanup = () => { stdin.off?.("data", onData); stdout.off?.("resize", onResize); unsub(); teardown(); try { inkStdin.end(); } catch {} };
  instance.waitUntilExit().then(cleanup, cleanup);
  return {
    waitUntilExit: instance.waitUntilExit.bind(instance),
    unmount: instance.unmount.bind(instance),
    teardown: cleanup,
  };
}

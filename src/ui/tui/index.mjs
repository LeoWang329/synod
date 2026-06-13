// src/ui/tui/index.mjs — 启动/拆除全屏 TUI。Ink 动态 import(核心零依赖路径不触发)。
import { MOUSE_ON, MOUSE_OFF, drainMouse, isLeftClick, RegionRegistry } from "./mouse.mjs";

export const ENTER_ALT = "\x1b[?1049h";
export const EXIT_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

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

  // 缓冲式鼠标:累积 stdin,循环提取完整 SGR 事件,只对左键 click 命中右栏卡 → onSelect。
  let mbuf = "";
  function onData(chunk) {
    mbuf += chunk.toString("utf8");
    const { events, rest } = drainMouse(mbuf);
    mbuf = rest.length < 64 ? rest : "";   // 防御:异常超长残段丢弃
    for (const ev of events) {
      if (!isLeftClick(ev)) continue;
      const id = regions.hit(ev.x, ev.y);
      if (id && id.startsWith("agent:")) onSelect(id.slice("agent:".length));
    }
  }
  stdin.on("data", onData);

  const instance = render(
    React.createElement(App, { store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt }),
    { stdout, stdin, exitOnCtrlC: false },
  );

  const cleanup = () => { stdin.off?.("data", onData); stdout.off?.("resize", onResize); unsub(); teardown(); };
  instance.waitUntilExit().then(cleanup, cleanup);
  return {
    waitUntilExit: instance.waitUntilExit.bind(instance),
    unmount: instance.unmount.bind(instance),
    teardown: cleanup,
  };
}

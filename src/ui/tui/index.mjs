// src/ui/tui/index.mjs — 启动/拆除全屏 TUI。Ink 动态 import(核心零依赖路径不触发)。
//
// 不开鼠标捕获:终端把鼠标整个留给用户 → 左键拖选/复制原生可用(开捕获会让终端把拖动交给
// 程序、关掉原生选区,即「没法复制」的根因)。代价是失去「点右栏卡切 agent」——切 agent 改走
// 键盘(Tab 轮换 / Ctrl-G 跳到刚跑完的后台 agent)。因此本模块也不再需要拆分 stdin:Ink 直接
// 读真 stdin(原先的 stdin 代理/拆分只为剥离鼠标字节,无鼠标即无须存在)。

export const ENTER_ALT = "\x1b[?1049h";
export const EXIT_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// 本 TUI 自己从不开鼠标上报;启动/拆除各关一次,清掉可能从上一个程序继承来的鼠标模式,
// 免得残留的 SGR 序列泄漏成输入框字符。
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

export function buildTeardown(stdout) {
  let done = false;
  return function teardown() {
    if (done) return; done = true;
    try { stdout.write(MOUSE_OFF + SHOW_CURSOR + EXIT_ALT); } catch {}
  };
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

  stdout.write(ENTER_ALT + HIDE_CURSOR + MOUSE_OFF);
  const teardown = buildTeardown(stdout);

  const renderEl = () => React.createElement(App, { store, dispatch, hintsCtx, mesh, onSelect, onCycle, onInterrupt, rows: stdout.rows });
  const instance = render(renderEl(), { stdout, stdin, exitOnCtrlC: false });

  // 终端尺寸变化:用新行高重渲(把输入压回最底端)。
  const onResize = () => { try { instance.rerender(renderEl()); } catch {} };
  stdout.on?.("resize", onResize);

  const cleanup = () => { stdout.off?.("resize", onResize); teardown(); };
  instance.waitUntilExit().then(cleanup, cleanup);
  return {
    waitUntilExit: instance.waitUntilExit.bind(instance),
    unmount: instance.unmount.bind(instance),
    teardown: cleanup,
  };
}

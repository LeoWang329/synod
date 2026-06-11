// synod/src/notify.mjs — config 通知钩子(§4.13)+ 终端铃/标题。headless-safe(钩子非 TTY 也触发;BEL/OSC0 仅 TTY)。
import { spawn } from "node:child_process";

const HOOK_TIMEOUT_MS = 15_000;

export function createNotifier({ config, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const hooks = config?.hooks ?? {};
  const ttyOn = Boolean(stdout && stdout.isTTY);

  function fire(event, ctx = {}) {
    const cmd = hooks[event];
    if (!cmd) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      let child;
      try {
        child = spawn(cmd, {
          shell: true, windowsHide: true, stdio: "ignore",
          env: {
            ...env,
            SYNOD_EVENT: event,
            SYNOD_RUN_ID: ctx.runId ?? "",
            SYNOD_SUMMARY: ctx.summary ?? "",
            SYNOD_EXIT_CODE: ctx.exitCode != null ? String(ctx.exitCode) : "",
          },
        });
      } catch (err) {
        stderr.write(`synod: hook ${event} failed to start: ${err.message}\n`);
        return finish();
      }
      child.unref();   // 不因 hook 子进程拖住事件循环
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, HOOK_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      child.on("error", (err) => {
        stderr.write(`synod: hook ${event} error: ${err.message}\n`);
        clearTimeout(timer);
        finish();
      });
      child.on("close", (code) => {
        if (code !== 0) stderr.write(`synod: hook ${event} exited ${code}\n`);
        clearTimeout(timer);
        finish();
      });
    });
  }

  function bell() { if (ttyOn) stdout.write("\x07"); }
  function title(s) { if (ttyOn) stdout.write(`\x1b]0;${s}\x07`); }

  return { fire, bell, title };
}

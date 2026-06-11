// synod/src/input-router.mjs — 进程内唯一 readline 路由器(§4.8 stdin 单一所有权)。
//
// 修 P1-8(REPL /flow + approve 双 readline 抢 stdin):整个进程只建一个
// readline.Interface;REPL dispatch 经 onLine() 注册默认路由,approve()/question()
// 经 claim() 临时独占下一行(期间默认路由暂停),resolve 后自动归还。
// raw-mode(TTY)下 Ctrl-C 不产生进程 SIGINT 而由 readline 接管,故暴露 onSigint()
// 转发 rl 'SIGINT'(P1-28 的退出矩阵接回此处)。
import readline from "node:readline";

export function createInputRouter({ stdin, stdout }) {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY ?? false,
  });

  let _lineHandler = null;     // 默认路由
  let _claim = null;           // { resolve, reject, onAbort, signal } | null

  rl.on("line", (line) => {
    if (_claim) {
      const c = _claim;
      _claim = null;
      if (c.signal) c.signal.removeEventListener("abort", c.onAbort);
      c.resolve(line);
      return;
    }
    if (_lineHandler) _lineHandler(line);
  });

  function onLine(fn) {
    _lineHandler = fn;
    return () => { if (_lineHandler === fn) _lineHandler = null; };
  }

  function claim({ prompt, signal } = {}) {
    if (_claim) throw new Error("input already claimed (a question is already pending)");
    if (prompt != null) stdout.write(String(prompt));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (_claim && _claim.reject === reject) _claim = null;
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      _claim = { resolve, reject, onAbort, signal };
    });
  }

  function release() {
    if (_claim) {
      const c = _claim;
      _claim = null;
      if (c.signal) c.signal.removeEventListener("abort", c.onAbort);
      c.reject(Object.assign(new Error("Released"), { name: "AbortError" }));
    }
  }

  function onSigint(fn) {
    rl.on("SIGINT", fn);
    return () => rl.removeListener("SIGINT", fn);
  }

  return {
    rl,
    onLine,
    claim,
    release,
    onSigint,
    pause() { rl.pause(); },
    resume() { rl.resume(); },
    close() { try { rl.close(); } catch {} },
  };
}

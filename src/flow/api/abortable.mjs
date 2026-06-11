// synod/src/flow/api/abortable.mjs — 协作取消小工具(agent/agentLoop 共用)。
// race(promise, signal):signal abort 时立即 reject AbortError 并跑 onAbort
// (通常 = session.close() 杀进程);否则透传 promise 的结果。

export function abortError() {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

export function raceAbort(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    try { onAbort?.(); } catch {}
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbortEvt = () => {
      cleanup();
      try { onAbort?.(); } catch {}
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbortEvt);
    signal.addEventListener("abort", onAbortEvt, { once: true });
    promise.then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); },
    );
  });
}

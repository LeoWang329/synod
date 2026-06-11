/**
 * 进程内"当前 run 的 runtime"上下文 —— AsyncLocalStorage(P1-29)。
 *
 * 旧实现是模块级单例,只支持串行单 run;并发 /flow 会互相覆盖全局变量
 * (第二个 run 抹掉第一个的 runtime → "No active flow runtime" 或会话泄漏)。
 * 改用 node:async_hooks 的 AsyncLocalStorage:每个 run 在自己的异步上下文里
 * 跑,getCurrentRuntime() 读的是本上下文的 store,互不串扰。零三方依赖。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** 在 rt 的上下文里运行 fn(runner 调用)。退出自动恢复上一层上下文。 */
export function runWithRuntime(rt, fn) {
  return als.run(rt, fn);
}

/** 取当前上下文的 runtime;run 外调用抛错(原语只能在 run() 内用)。 */
export function getCurrentRuntime() {
  const rt = als.getStore();
  if (!rt) {
    throw new Error(
      "No active flow runtime — primitives must be called inside run()",
    );
  }
  return rt;
}

/** 不抛版本:无活动 runtime 返回 null。 */
export function getCurrentRuntimeRaw() {
  return als.getStore() ?? null;
}

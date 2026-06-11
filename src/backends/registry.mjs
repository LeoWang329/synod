// synod/src/backends/registry.mjs — backend adapter 注册表。
//
// adapter 契约:{ name, doctor(): {available, version}, open(opts): Promise<Session> }
// Session 契约(与 OmpSession 公共面一致,fake-backend.mjs 的文档为准):
//   EventEmitter('delta'|'status'|'event'|'error') +
//   send(msg,{wait,timeout_ms}) / result() / abort() / close() / summary()
//
// 列表必须惰性取(backendNames() 调用时求值):config 注册发生在内置
// 注册之后,模块加载时快照必然过期。

const _backends = new Map();

export function registerBackend(adapter) {
  if (!adapter || typeof adapter.name !== "string" || !adapter.name) {
    throw new Error("registerBackend: adapter.name is required (non-empty string)");
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(adapter.name)) {
    throw new Error(`registerBackend: invalid name "${adapter.name}" (letters/digits/_/- only)`);
  }
  if (typeof adapter.open !== "function") {
    throw new Error(`registerBackend: adapter "${adapter.name}" must implement open()`);
  }
  if (typeof adapter.doctor !== "function") {
    throw new Error(`registerBackend: adapter "${adapter.name}" must implement doctor()`);
  }
  if (_backends.has(adapter.name)) {
    throw new Error(`registerBackend: backend "${adapter.name}" already registered`);
  }
  _backends.set(adapter.name, adapter);
}

export function getBackend(name) { return _backends.get(name) ?? null; }
export function backendNames() { return [..._backends.keys()]; }
export function _unregisterForTests(name) { _backends.delete(name); }

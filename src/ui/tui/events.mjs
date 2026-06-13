// src/ui/tui/events.mjs — 规范化事件 + 适配器注册表(仿 backends/registry.mjs)。
// 适配器签名:normalize({ channel, payload, agent }) → 规范事件 | null
//   channel ∈ "delta" | "status" | "event" | "error";返回 null = UI 不渲染。
export function defaultAdapter({ channel, payload }) {
  if (channel === "delta" && typeof payload === "string") return { kind: "message.delta", text: payload };
  if (channel === "status" && payload && typeof payload === "object")
    return { kind: "status", status: payload.status, isStreaming: Boolean(payload.isStreaming) };
  return null; // P1:event 原始流暂不消费(P2 由 omp/codex 适配器接管)
}
const _adapters = new Map();
export function registerEventAdapter(agent, normalize) { _adapters.set(agent, normalize); }
export function getEventAdapter(agent) { return _adapters.get(agent) || defaultAdapter; }

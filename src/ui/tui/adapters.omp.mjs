// src/ui/tui/adapters.omp.mjs — omp 事件适配器(注册到 events 注册表)。
// toolevent 走完整(未截断)工具消息;delta/status 同默认。
function ompText(result) {
  const parts = (result && Array.isArray(result.content) ? result.content : [])
    .map((c) => (c && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean);
  return parts.join("\n");
}
export function ompAdapter({ channel, payload }) {
  if (channel === "delta" && typeof payload === "string") return { kind: "message.delta", text: payload };
  if (channel === "status" && payload && typeof payload === "object")
    return { kind: "status", status: payload.status, isStreaming: Boolean(payload.isStreaming) };
  if (channel === "toolevent" && payload && typeof payload === "object") {
    if (payload.type === "tool_execution_start")
      return { kind: "tool.start", id: payload.toolCallId, name: payload.toolName, args: payload.args ?? null, intent: payload.intent ?? null };
    if (payload.type === "tool_execution_end")
      return { kind: "tool.end", id: payload.toolCallId, ok: payload.error == null && payload.isError !== true, output: ompText(payload.result), diff: payload.diff ?? null };
  }
  return null; // event(压缩流)P2 不消费
}

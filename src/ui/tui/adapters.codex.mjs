// src/ui/tui/adapters.codex.mjs — codex 事件适配器。
// codex 工具 item 是「一次性完成」,故规范成 tool.end(带 name/args 供 store 直接成卡)。
function joinTexts(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((c) => (c && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean).join("\n");
}
function codexOutput(item) {
  if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) return item.aggregatedOutput; // commandExecution
  const fromResult = joinTexts(item.result && item.result.content);                                      // mcpToolCall
  if (fromResult) return fromResult;
  const fromContentItems = joinTexts(item.contentItems);                                                 // dynamicToolCall
  if (fromContentItems) return fromContentItems;
  if (typeof item.output === "string") return item.output;
  if (typeof item.text === "string") return item.text;
  return "";
}
function codexDiff(item) {
  if (Array.isArray(item.changes))
    return item.changes.map((c) => (c && c.diff) ? c.diff : `${c?.path ?? ""}`).filter(Boolean).join("\n");
  if (typeof item.diff === "string") return item.diff;
  return null;
}
export function codexAdapter({ channel, payload }) {
  if (channel === "delta" && typeof payload === "string") return { kind: "message.delta", text: payload };
  if (channel === "status" && payload && typeof payload === "object")
    return { kind: "status", status: payload.status, isStreaming: Boolean(payload.isStreaming) };
  if (channel === "toolevent" && payload && payload.type === "tool.item" && payload.item) {
    const item = payload.item;
    const out = codexOutput(item);
    return {
      // id 优先 item.id/callId;都无时返回 null——store 对 null id 不 upsert、直接追加一张已完成卡。
      kind: "tool.end", id: item.id ?? item.callId ?? null, name: item.type,
      args: item.command ?? item.arguments ?? item.query ?? item.prompt ?? null,
      ok: item.status ? item.status === "completed" : true,
      output: out, diff: codexDiff(item),
    };
  }
  return null;
}

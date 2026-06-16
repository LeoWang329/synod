// src/ui/tui/breadcrumbs.mjs — 把 fence 命令(cmd,result)翻成一句人能读的面包屑。
// 纯函数、可单测;措辞可后续微调,映射不中则回退原始 "cmd → result"。
export function fenceBreadcrumb(cmd, result) {
  const c = String(cmd || "").trim();
  const r = String(result || "").trim();
  if (c.startsWith("/open")) {
    const m = r.match(/session\s+(\S+)/);
    if (m) return `开了 ${m[1]}`;
    return r.startsWith("ok") ? "开了新会话" : `开会话失败: ${r}`;
  }
  if (c.startsWith("/relay")) {
    const m = c.match(/\/relay\s+(\S+)/);
    return m ? `连了 relay ${m[1]}` : "建了 relay";
  }
  if (c.startsWith("@")) {
    const m = c.match(/^@(\S+)/);
    return m ? `给 ${m[1]} 派了活` : "派了活";
  }
  return `${c} → ${r}`;
}

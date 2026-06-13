// src/ui/tui/hints.mjs — TUI 输入提示(/ 与 @;$ 识别但本期无行为)。纯函数。
const SLASH = [
  ["/open", "新开会话 [+profile] [--agent/--model/--effort/--write/--mesh]"],
  ["/use", "切换当前会话 <label>"], ["/close", "关闭会话 <label>"], ["/sessions", "列出会话"],
  ["/relay", "建立转发 <from>-><to>"], ["/unrelay", "解除转发 <from>-><to>"], ["/relays", "列出转发规则"],
  ["/forward", "一次性转发 <from>-><to> [备注]"], ["/flow", "运行工作流 [<name> [输入]]"],
  ["/resume", "恢复中断的 flow <runId>"], ["/status", "总览"], ["/help", "帮助 [命令]"], ["/exit", "退出"],
];
const OPEN_OPTS = ["--agent", "--model", "--effort", "--write", "--mesh", "--no-mesh"];

export function computeHints(line, ctx) {
  const labels = ctx.labels();
  if (/^\/\S*$/.test(line)) {
    // 注意:`/` 单独输入时每个命令都以 `/` 开头 → filter 已列全部;非匹配前缀(如 `/zz`)应返回空,
    // 不能回退倒出全表(codex 评审:旧 `items.length ? items : 全部` 会让 /zz 误列 13 条)。
    const items = SLASH.filter(([c]) => c.startsWith(line)).map(([value, desc]) => ({ value, desc }));
    return { kind: "slash", items };
  }
  if (/^@\S*$/.test(line)) {
    const cands = ["@all", ...labels.map((l) => "@" + l)];
    return { kind: "target", items: cands.filter((c) => c.startsWith(line)).map((value) => ({ value, desc: "" })) };
  }
  if (/^\$/.test(line)) return { kind: "shell", items: [] };
  const parts = line.split(/\s+/), cmd = parts[0];
  const word = /\s$/.test(line) ? "" : parts[parts.length - 1];
  const mk = (arr) => ({ items: arr.map((value) => ({ value, desc: "" })) });
  if (cmd === "/use" || cmd === "/close") return { kind: "arg", ...mk(labels.filter((l) => l.startsWith(word))) };
  if (cmd === "/open") {
    if (parts[parts.length - 2] === "--agent") return { kind: "arg", ...mk(ctx.backends().filter((n) => n.startsWith(word))) };
    return { kind: "arg", ...mk([...ctx.profiles().map((p) => "+" + p), ...OPEN_OPTS].filter((c) => c.startsWith(word))) };
  }
  if (cmd === "/relay" || cmd === "/unrelay" || cmd === "/forward") {
    const arrow = word.indexOf("->");
    if (arrow === -1) return { kind: "arg", ...mk(labels.filter((l) => l.startsWith(word)).map((l) => l + "->")) };
    const left = word.slice(0, arrow + 2), right = word.slice(arrow + 2);
    return { kind: "arg", ...mk(labels.filter((l) => l.startsWith(right)).map((l) => left + l)) };
  }
  if (cmd === "/flow" && parts.length <= 2) return { kind: "arg", ...mk(ctx.flows.filter((n) => n.startsWith(word))) };
  return { kind: "none", items: [] };
}

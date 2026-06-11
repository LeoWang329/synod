// synod/src/ui/help.mjs — REPL /help 分组帮助(§3.2)。纯文本(命令是用户主动敲的,不着色)。

export const HELP_TEXT = [
  "会话(主持人模式)",
  "  /open [+profile] [--agent A] [--model M] [--effort E] [--write] [--mesh|--no-mesh]",
  "  /use <label>      /close <label>      /sessions",
  "消息",
  "  <text> → 当前会话      @<label> <text> → 定向      @all <text> → 广播",
  "转发",
  "  /relay a->b      /unrelay a->b      /relays",
  "工作流",
  "  /flow             列出可用 flow",
  "  /flow <name> [input]",
  "团队(阶段 2)",
  '  /team <name> "<task>"      /team status      /done',
  "其他",
  "  /status      /help [cmd]      /exit (Ctrl-D)      Ctrl-C 中断",
  "",
].join("\n");

const DETAILS = {
  open:
    "/open [+profile] [--agent A] [--model M] [--effort E] [--write] [--mesh|--no-mesh]\n" +
    "  开新会话。+profile 套用 synod.config.mjs 的 agent 档案;内联 flag 覆盖档案字段。\n" +
    "  例:/open +coder --model MiniMax-M3\n",
  use: "/use <label>\n  切换当前会话(后续无前缀消息发往它)。\n",
  close: "/close <label>\n  关闭会话并解除其全部 relay 绑定。\n",
  sessions: "/sessions\n  表格列出全部会话(当前以 * 标注;RELAY 列示出/入边)。\n",
  relay: "/relay <from>-><to>\n  把 from 每个 turn 的完整输出转发给 to。\n",
  unrelay: "/unrelay <from>-><to>\n  移除一条转发规则。\n",
  flow: "/flow [<name> [input]]\n  省略 name 列出可用 flow;带 name 运行(进度视图 + 头尾横幅)。\n",
  status: "/status\n  一行总览:会话数 / 在跑数 / 活跃 relay 数 / 当前会话 / flow。\n",
};

/** 单命令详情(允许带或不带前导 /);未知 → 提示回 /help。 */
export function helpForCommand(topic) {
  const key = String(topic).replace(/^\//, "");
  return DETAILS[key] ?? `no help for "${topic}". Try /help.\n`;
}

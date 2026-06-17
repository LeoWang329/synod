// src/ui/tui/flow-continue.mjs — flow 结束后续聊的构造(纯函数,可单测)。
// flow 内部会话在 run() 返回时已释放,无法接管真线程;续聊 = 用最后发言 turn 的真 agent+model
// 新开一个真 smTui 会话,把刚才群聊的可见 transcript 作为首轮上下文喂进去。cli.mjs 负责 open/enqueue/聚焦。

function buildTranscript(card, maxEntries) {
  const es = (Array.isArray(card.entries) ? card.entries : []).slice(-maxEntries);
  const lines = [];
  for (const e of es) {
    if (e.type === "assistant") lines.push(`${e.agent || "agent"}: ${e.text}`);
    else if (e.type === "output") lines.push(`[输出] ${e.text}`);
    else if (e.type === "approve") lines.push(`[确认] ${e.text}`);
    else if (e.type === "user") lines.push(`你: ${e.text}`);
  }
  return lines.join("\n");
}

// card:store 里的 flow 卡(含 flowName/entries/lastAgent/lastModel);line:用户的追问。
// 返回 { agent, model, seed }——agent/model 用于 smTui.open,seed 是喂给后端的首轮 prompt。
export function buildContinuation(card, line, { defaultAgent = null, maxEntries = 60 } = {}) {
  const agent = card.lastAgent || defaultAgent;
  const model = card.lastModel || null;
  const transcript = buildTranscript(card, maxEntries);
  const seed =
    `以下是刚才 flow「${card.flowName || "flow"}」的对话记录:\n\n${transcript}\n\n` +
    `请基于以上继续。用户追问:\n${line}`;
  return { agent, model, seed };
}

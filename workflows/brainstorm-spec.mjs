/**
 * workflows/brainstorm-spec.mjs — codex 自适应提问 + 人作答,两把钥匙判定结束。
 *
 * 钥匙①(agent 提议) = agent 吐 <<<SPEC>>> 记号(其后是设计稿草稿)。
 * 钥匙②(人拍板)     = 草稿经 approve,人 accept 才真结束。
 * 刹车              = 到 maxTurns / 人在 ask 里打 /spec → 命令 agent 立即产出草稿收尾。
 *
 * JS 不"懂"头脑风暴结束没——只查:agent 吐记号了吗 / 人 accept 了吗 / 到上限了吗。
 * flow 名 = brainstorm-spec。写之前读 docs/FLOW_AUTHORING.md。
 */
import { agent, ask, approve } from "synod/flow";

export const meta = {
  description: "codex 头脑风暴自适应提问 + 人作答,产出 spec 设计稿",
  // inputs: { topic, maxTurns? }
};

const SENTINEL = "<<<SPEC>>>";

const SKILL_HINT =
  "你是资深工程师,正在和用户头脑风暴一个软件设计。一次只问一个问题,逐步澄清目的/约束/成功标准。";

function askPrompt(transcript, force) {
  if (force) {
    return `${SKILL_HINT}\n已知对话:\n${transcript}\n\n` +
      `现在停止提问,基于以上对话直接产出完整设计稿。第一行输出 ${SENTINEL},其后是设计稿正文。`;
  }
  return `${SKILL_HINT}\n已知对话:\n${transcript}\n\n` +
    `若还有不清楚的,只问下一个澄清问题(不要解释)。\n` +
    `若已问够、能写设计稿了,第一行输出 ${SENTINEL},其后是完整设计稿正文。`;
}

export async function run(ctx, input) {
  const topic = typeof input === "string" ? input : (input?.topic ?? "");
  const maxTurns = input?.maxTurns ?? 20;
  let transcript = `主题: ${topic}`;
  let force = false;

  for (let turn = 1; turn <= maxTurns + 1; turn++) {
    if (turn > maxTurns) force = true;   // 到上限那一轮强制收尾

    const out = await agent(ctx, {
      agent: "codex", reuse: true,
      prompt: askPrompt(transcript, force),
    });

    // 钥匙①:agent 提议记号。
    if (out.includes(SENTINEL)) {
      const draft = out.slice(out.indexOf(SENTINEL) + SENTINEL.length).trim();
      const decision = await approve(ctx, { content: draft });
      if (decision.accepted) return { specText: draft };              // 钥匙②:人拍板
      if (decision.aborted) return { specText: draft, aborted: true };
      transcript += `\n[人对设计稿的反馈] ${decision.feedback}`;       // 没过,接着聊
      force = false;
      continue;
    }

    // 还在提问:取人答(ask 不分类,/spec 原样回来)。
    const answer = await ask(ctx, { question: out, prompt: "你的回答(/spec 收尾, 空行跳过): " });
    if (answer === null) return { specText: transcript, aborted: true };  // abort
    if (answer.trim() === "/spec") { force = true; continue; }            // 刹车:强制收尾
    transcript += `\nQ: ${out}\nA: ${answer}`;
  }

  return { specText: transcript };   // 兜底(force 那轮通常已出记号)
}

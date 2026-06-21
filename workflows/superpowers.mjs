/**
 * workflows/superpowers.mjs — 父 flow:串 brainstorm→spec→plan→execute→review。
 *
 * 子流程间用**返回值**交接(spec 文本→plan 文本→开发结果)。gates 开关控制接缝人审。
 * 注:brainstorm 的提问对话(ask)与 codex 评审 + 测试**永远在**,gates 只关人审 approve。
 * flow 名 = superpowers。写之前读 docs/FLOW_AUTHORING.md。
 */
import { runWorkflow, approve } from "synod/flow";

export const meta = {
  description: "Superpowers 开发链:头脑风暴→spec→计划→subagent开发→review",
  // inputs: { topic, gates?('none'|'final'|'all'), testCmd?, maxTurns? }
};

/** gate(stage, gates) — 该接缝是否需要人审。stage ∈ spec|plan|dev|final。 */
export function gate(stage, gates) {
  if (gates === "all") return true;
  if (gates === "final") return stage === "final";
  return false; // "none"
}

export async function run(ctx, input) {
  const gates = input?.gates ?? "none";
  const testCmd = input?.testCmd ?? "npm test";

  // ① 头脑风暴 → spec
  const bs = await runWorkflow(ctx, "brainstorm-spec", { topic: input?.topic, maxTurns: input?.maxTurns });
  if (bs.aborted) return { status: "aborted", at: "brainstorm" };
  if (gate("spec", gates)) {
    const d = await approve(ctx, { content: bs.specText });
    if (d.aborted) return { status: "aborted", at: "spec-gate" };
  }

  // ② 写计划
  const plan = await runWorkflow(ctx, "spec-to-plan", { specText: bs.specText });
  if (gate("plan", gates)) {
    const d = await approve(ctx, { content: plan.planText });
    if (d.aborted) return { status: "aborted", at: "plan-gate" };
  }

  // ③ subagent 驱动开发(自动刹车:某 task 写不过 → halted)
  const dev = await runWorkflow(ctx, "execute-plan", { planText: plan.planText, testCmd, gates });
  if (!dev.done) return { status: "halted", at: dev.failedTask, completed: dev.completed };
  if (gate("dev", gates)) await approve(ctx, { content: `开发完成 tasks: ${dev.completed.join(", ")}` });

  // ④ 最终 review
  const rev = await runWorkflow(ctx, "final-review", { testCmd });
  if (gate("final", gates)) await approve(ctx, { content: rev.report });

  return { status: "done", specText: bs.specText, planText: plan.planText, completed: dev.completed, review: rev };
}

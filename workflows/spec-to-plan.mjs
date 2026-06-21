/**
 * workflows/spec-to-plan.mjs — codex 由 spec 产出分 task 的 TDD 计划,人在环改稿。
 *
 * 计划段头**必须** `### Task N: 标题`(与 execute-plan 的 parsePlan 契约对齐)——
 * prompt 里强约束;两端漂移会导致 execute-plan 解析不到 task。
 * flow 名 = spec-to-plan。写之前读 docs/FLOW_AUTHORING.md。
 */
import { agent, reviseWithHuman } from "synod/flow";

export const meta = {
  description: "codex 读 spec 产出分 task 的实现计划,人在环改稿定稿",
  // inputs: { specText }
};

export async function run(ctx, input) {
  const specText = typeof input === "string" ? input : (input?.specText ?? "");

  const draft = await agent(ctx, {
    agent: "codex",
    prompt:
      `根据下面的设计 spec,产出一份分 task 的 TDD 实现计划。\n` +
      `**每个 task 必须用恰好这种段头:** \`### Task N: 标题\`(N 为数字),段体写实现要点与验证方式。\n\n` +
      `=== SPEC ===\n${specText}`,
  });

  const planText = await reviseWithHuman(ctx, draft, { agent: "codex" });
  return { planText };
}

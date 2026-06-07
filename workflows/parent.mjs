/**
 * workflows/parent.mjs — FA5: Parent flow that calls a child workflow.
 *
 * Calls bash first for a root-level log entry (so e2e can verify
 * root entries lack parentRunId), then invokes child-echo via runWorkflow.
 */
import { bash, runWorkflow } from "synod/flow";

export const meta = {
  description: "Parent: calls child workflow and returns its result",
};

export async function run(ctx, input) {
  // Root-level primitive — log entry will have NO parentRunId
  await bash(ctx, "echo root-primitive");

  const childResult = await runWorkflow(ctx, "child-echo", "hello from parent");
  return { fromChild: childResult };
}

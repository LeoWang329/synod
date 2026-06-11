// test/cli.inputrouter.integration.test.mjs — P1-8: under the REPL, a /flow that
// calls approve() must consume the human's line via the SHARED InputRouter, not a
// second readline.  "accept" goes to approve only — it never leaks to the live
// session, and the flow's accepted decision shows up in stdout.
//
// 偏差(对计划 Step1 的最小适配,见 Task 报告):cli 的 /flow 默认从 *包* 的
// workflows/ 解析,而本用例的 flow 落在 tmp 工程里。故 (1) 给 cli.main 注入
// workflowsRoot 指向工程 workflows/(production 默认仍是包内 dir);(2) 像
// cli.custom-backend 用例那样把 synod 软链进工程 node_modules,让 flow 的
// `import "synod/flow"` 在 tmp 工程外也可解析。断言与计划原样一致。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function collector() {
  const chunks = [];
  return { write(s) { chunks.push(s); return true; }, text: () => chunks.join("") };
}

// 等待断言成立——比固定 sleep 稳:approve 只 claim「下一行」,故必须等它的
// prompt 真正落到 stdout(= router.claim 已挂起)再喂 accept,否则在 node --test
// 进程隔离的冷启动下,accept 会先于 claim 到达 → 泄漏给 REPL 且把后续 /exit 吞掉。
async function waitFor(pred, timeout = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("REPL /flow 带 approve:人输一行只被 approve 消费,不泄漏给当前会话", async () => {
  const home = mkdtempSync(join(tmpdir(), "synod-ir-home-"));
  const proj = mkdtempSync(join(tmpdir(), "synod-ir-proj-"));
  mkdirSync(join(home, ".synod"), { recursive: true });
  mkdirSync(join(proj, "workflows"));
  // 让 flow 文件的 import "synod/flow" 在 tmp 工程里可解析(同 cli.custom-backend 用例)。
  mkdirSync(join(proj, "node_modules"), { recursive: true });
  symlinkSync(PKG_ROOT, join(proj, "node_modules", "synod"), "dir");
  writeFileSync(join(proj, "workflows", "ask.mjs"), `
import { approve } from "synod/flow";
export const meta = { description: "ask once" };
export async function run(ctx) {
  const d = await approve(ctx, { content: "ready?" });
  return { decision: d };
}
`);
  process.chdir(proj);
  const { main } = await import("../src/cli.mjs");
  const stdin = new PassThrough(); stdin.isTTY = false;
  const stdout = collector(); const stderr = collector();
  const done = main({
    argv: ["node", "cli.mjs", "--agent", "omp"],
    stdin, stdout, stderr,
    env: { SYNOD_HOME: home },
    workflowsRoot: join(proj, "workflows"),
    openBackend: async () => {
      const { FakeSession } = await import("./helpers/fake-backend.mjs");
      return new FakeSession({ deltas: ["hi"] });
    },
  });
  stdin.write("/flow ask\n");
  await waitFor(() => stdout.text().includes("(accept / feedback / /abort)"));
  stdin.write("accept\n");                    // 仅 approve 消费;不得作为消息发给会话
  await waitFor(() => /"accepted": true/.test(stdout.text()));
  stdin.write("/exit\n");
  const code = await done;
  assert.equal(code, 0, stderr.text());
  assert.match(stdout.text(), /"accepted": true/);
  // "accept" 不应被当成发给 omp#1 的裸消息回显
  assert.ok(!/\[omp#1\] .*accept/.test(stdout.text()), "approve 的输入不得泄漏给会话");
});

// B2:approve 等待人输入时遇到 Ctrl-D/EOF。readline 'close' 触发,若此刻 flow 卡在
// router.claim,该 claim 永不 settle → onClose `await _pendingFlows` 永挂。修复后:
// onClose 先 abort 活动 flow(run 级 signal → approve 协作取消)+ input-router 'close'
// 兜底 release pending claim。断言:进程不挂死、退出码 0、flow 以 aborted 收口。
test("REPL /flow approve 等待中 stdin EOF:不挂死、退出 0、flow 以 aborted 收口", async () => {
  const home = mkdtempSync(join(tmpdir(), "synod-ir-home-"));
  const proj = mkdtempSync(join(tmpdir(), "synod-ir-proj-"));
  mkdirSync(join(home, ".synod"), { recursive: true });
  mkdirSync(join(proj, "workflows"));
  mkdirSync(join(proj, "node_modules"), { recursive: true });
  symlinkSync(PKG_ROOT, join(proj, "node_modules", "synod"), "dir");
  writeFileSync(join(proj, "workflows", "ask.mjs"), `
import { approve } from "synod/flow";
export const meta = { description: "ask once" };
export async function run(ctx) {
  const d = await approve(ctx, { content: "ready?" });
  return { decision: d };
}
`);
  process.chdir(proj);
  const { main } = await import("../src/cli.mjs");
  const stdin = new PassThrough(); stdin.isTTY = false;
  const stdout = collector(); const stderr = collector();
  const done = main({
    argv: ["node", "cli.mjs", "--agent", "omp"],
    stdin, stdout, stderr,
    env: { SYNOD_HOME: home },
    workflowsRoot: join(proj, "workflows"),
    openBackend: async () => {
      const { FakeSession } = await import("./helpers/fake-backend.mjs");
      return new FakeSession({ deltas: ["hi"] });
    },
  });
  stdin.write("/flow ask\n");
  await waitFor(() => stdout.text().includes("(accept / feedback / /abort)"));
  // approve 正卡在 router.claim;此刻 EOF(Ctrl-D)——修复前会死锁在 onClose。
  stdin.end();
  const code = await done;                    // 若死锁,这里 hang 到 node --test 超时
  assert.equal(code, 0, stderr.text());
  // flow 以 aborted 收口(approve 的 abort 路径返回 { aborted: true }),其结果被打印。
  assert.match(stdout.text(), /"aborted": true/);
  // EOF 没有任何人输入,绝不可有内容被当成裸消息回显给会话。
  assert.ok(!/\[omp#1\] /.test(stdout.text()), "EOF 期间不得泄漏输入给会话");
});

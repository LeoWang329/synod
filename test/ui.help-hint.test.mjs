import test from "node:test";
import assert from "node:assert/strict";
import { createReplDispatch } from "../src/repl-dispatch.mjs";
import { createSessionManager, NO_SESSION_HINT } from "../src/session-manager.mjs";
import { HELP_TEXT, helpForCommand } from "../src/ui/help.mjs";

function cap() { return { buf: "", write(s) { this.buf += s; } }; }

test("/help 分組打印(会話/消息/転送/ワークフロー/その他)", () => {
  const stdout = cap();
  const dispatch = createReplDispatch({
    sm: { _sessions: new Map() }, registry: {}, stdout, stderr: cap(), defaultAgent: "omp",
  });
  const r = dispatch("/help", { source: "human" });
  assert.equal(r.redraw, true);
  for (const head of ["会话(主持人模式)", "消息", "转发", "工作流", "其他"]) {
    assert.ok(stdout.buf.includes(head), `缺分组标题 ${head}`);
  }
  assert.ok(stdout.buf.includes("/close <label>"));
  assert.ok(stdout.buf.includes("/status"));
});

test("/help open → 单命令详情", () => {
  const stdout = cap();
  const dispatch = createReplDispatch({
    sm: { _sessions: new Map() }, registry: {}, stdout, stderr: cap(), defaultAgent: "omp",
  });
  dispatch("/help open", { source: "human" });
  assert.ok(stdout.buf.includes("/open"));
  assert.match(stdout.buf, /profile|--agent/);
});

test("helpForCommand 未知命令 → 提示 /help", () => {
  assert.match(helpForCommand("nope"), /no help for "nope"/);
  assert.ok(HELP_TEXT.includes("工作流"));
});

test("No session 错误追加下一步 hint(§3.3)", () => {
  const stderr = cap();
  const sm = createSessionManager({
    openBackend: async () => {}, stdout: cap(), stderr,
    report: {}, cwd: process.cwd(), defaults: {}, onIdle: () => {},
  });
  sm.enqueue({ target: "omp#9", msg: "x" });
  assert.ok(stderr.buf.includes('No session "omp#9"'));
  assert.ok(stderr.buf.includes(NO_SESSION_HINT.trim()));
});

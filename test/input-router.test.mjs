// test/input-router.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInputRouter } from "../src/input-router.mjs";

function setup() {
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const out = [];
  const stdout = { write: (s) => { out.push(s); return true; } };
  const router = createInputRouter({ stdin, stdout });
  return { stdin, stdout, out, router };
}

test("onLine 收默认路由的行;claim 期间默认路由暂停", async () => {
  const { stdin, router } = setup();
  const lines = [];
  router.onLine((l) => lines.push(l));
  stdin.write("hello\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(lines, ["hello"]);

  const claimed = router.claim({ prompt: "> " });
  stdin.write("answer\n");                    // 这一行归 claim,不进 onLine
  assert.equal(await claimed, "answer");
  assert.deepEqual(lines, ["hello"], "claim 期间默认路由必须暂停");

  stdin.write("world\n");                     // claim 归还后恢复默认路由
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(lines, ["hello", "world"]);
});

test("claim 时写 prompt 到 stdout", async () => {
  const { stdin, out, router } = setup();
  const claimed = router.claim({ prompt: "PROMPT> " });
  assert.ok(out.join("").includes("PROMPT> "));
  stdin.write("x\n");
  await claimed;
});

test("并发 claim 抛错(单一所有权)", async () => {
  const { router } = setup();
  router.claim({ prompt: "a" });
  assert.throws(() => router.claim({ prompt: "b" }), /already pending|already claimed/i);
});

test("claim 接 signal:abort → reject AbortError 并归还默认路由", async () => {
  const { stdin, router } = setup();
  const lines = [];
  router.onLine((l) => lines.push(l));
  const ac = new AbortController();
  const claimed = router.claim({ prompt: "> ", signal: ac.signal });
  ac.abort();
  await assert.rejects(claimed, (e) => e.name === "AbortError");
  stdin.write("back\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(lines, ["back"], "abort 后默认路由恢复");
});

test("onSigint 转发 rl SIGINT", async () => {
  const { router } = setup();
  let hit = 0;
  router.onSigint(() => { hit++; });
  router.rl.emit("SIGINT");
  assert.equal(hit, 1);
});

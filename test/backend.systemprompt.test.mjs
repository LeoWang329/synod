import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { openBackend } from "../src/backend.mjs";
import { makeFakeOmpProc } from "./helpers/fake-backend.mjs";
import { MESH_INSTRUCTIONS } from "../src/mesh-instructions.mjs";

test("omp:systemPrompt 注入 --append-system-prompt;与 mesh 共存时 MESH 在前合并", async () => {
  let argvSeen;
  const spawnImpl = (cmd, args) => { argvSeen = args; return makeFakeOmpProc(); };
  const s1 = await openBackend({
    agent: "omp", cwd: process.cwd(), spawnImpl, systemPrompt: "你是 coder",
  });
  s1.close();
  assert.ok(argvSeen.includes("--append-system-prompt=你是 coder"));

  const s2 = await openBackend({
    agent: "omp", cwd: process.cwd(), spawnImpl, mesh: true, systemPrompt: "你是 coder",
  });
  s2.close();
  const flag = argvSeen.find((a) => a.startsWith("--append-system-prompt="));
  assert.equal(flag, `--append-system-prompt=${MESH_INSTRUCTIONS}\n\n你是 coder`);

  const s3 = await openBackend({ agent: "omp", cwd: process.cwd(), spawnImpl });
  s3.close();
  assert.ok(!argvSeen.some((a) => a.startsWith("--append-system-prompt=")), "未设置时不注入");
});

// 最小 codex app-server fake:应答 initialize + thread/start,记录收到的请求。
function makeFakeCodexProc(requests) {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, enc, cb) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        requests.push(msg);
        if (msg.method === "initialize") {
          stdout.push(JSON.stringify({ id: msg.id, result: {} }) + "\n");
        } else if (msg.method === "thread/start") {
          stdout.push(JSON.stringify({ id: msg.id, result: { thread: { id: "t1" } } }) + "\n");
        }
      }
      cb();
    },
  });
  const proc = new EventEmitter();
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new Readable({ read() {} });
  // pid 必须为 null:fake 非真实 ChildProcess,close() 会走 terminateProcessTree;
  // 伪造一个 90001 这类可能命中真实进程的 pid 会触发误杀(见 fake-backend.mjs 注释
  // 与 commit 304e846)。null 让 kill/pid 记录全部 no-op,且不影响 start 完成。
  proc.pid = null;
  proc.exitCode = null;
  return proc;
}

test("codex:systemPrompt 进 thread/start 的 developerInstructions(mesh 在前合并)", async () => {
  const requests = [];
  const session = await openBackend({
    agent: "codex", cwd: process.cwd(),
    spawnImpl: () => makeFakeCodexProc(requests),
    mesh: true, systemPrompt: "你是 reviewer",
  });
  session.close();
  const ts = requests.find((r) => r.method === "thread/start");
  assert.equal(ts.params.developerInstructions, `${MESH_INSTRUCTIONS}\n\n你是 reviewer`);
});

// test/config.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "../src/config.mjs";
import { registerConfigBackends } from "../src/config.mjs";
import { getBackend, backendNames, _unregisterForTests } from "../src/backends/registry.mjs";

function makeDirs() {
  const home = mkdtempSync(join(tmpdir(), "synod-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "synod-proj-"));
  mkdirSync(join(home, ".synod"), { recursive: true });
  return { home, cwd };
}

test("两层都缺省 → 空配置", async () => {
  const { home, cwd } = makeDirs();
  const cfg = await loadConfig({ cwd, home });
  assert.deepEqual(cfg.agents, {});
  assert.deepEqual(cfg.backends, {});
  assert.deepEqual(cfg.sources, []);
});

test("项目层覆盖全局层(同名 agent),不同名合并", async () => {
  const { home, cwd } = makeDirs();
  writeFileSync(join(home, ".synod", "config.mjs"), `export default {
    agents: { planner: { backend: "omp", model: "global-model" },
              reviewer: { backend: "codex" } },
  };`);
  writeFileSync(join(cwd, "synod.config.mjs"), `export default {
    agents: { planner: { backend: "omp", model: "project-model", effort: "xhigh" } },
  };`);
  const cfg = await loadConfig({ cwd, home });
  assert.equal(cfg.agents.planner.model, "project-model");
  assert.equal(cfg.agents.reviewer.backend, "codex");
  assert.equal(cfg.sources.length, 2);
});

test("校验:agent 缺 backend / backends 坏 type → 抛带文件路径的错", async () => {
  // 两个子用例各用独立目录:同进程内重写同一路径会命中 ESM 模块缓存
  // (生产中两层配置路径必然不同,不会撞缓存——故 loadLayer 保持可缓存)。
  const a = makeDirs();
  writeFileSync(join(a.cwd, "synod.config.mjs"),
    `export default { agents: { bad: { model: "x" } } };`);
  await assert.rejects(loadConfig({ cwd: a.cwd, home: a.home }), /agents\.bad.*backend.*synod\.config\.mjs/s);

  const b = makeDirs();
  writeFileSync(join(b.cwd, "synod.config.mjs"),
    `export default { backends: { b: { type: "magic" } } };`);
  await assert.rejects(loadConfig({ cwd: b.cwd, home: b.home }), /backends\.b.*type/s);
});

test("type:module 的 path 相对声明它的 config 文件解析", async () => {
  const { home, cwd } = makeDirs();
  writeFileSync(join(cwd, "synod.config.mjs"), `export default {
    backends: { my: { type: "module", path: "./adapters/my.mjs" } },
  };`);
  const cfg = await loadConfig({ cwd, home });
  assert.equal(cfg.backends.my.path, join(cwd, "adapters", "my.mjs"));
});

test("resolveProfile:profile → openBackend 参数(role→systemPrompt)", async () => {
  const { home, cwd } = makeDirs();
  writeFileSync(join(cwd, "synod.config.mjs"), `export default {
    agents: { coder: { backend: "omp", model: "m1", effort: "high",
                       write: true, mesh: false, role: "你是 coder" } },
  };`);
  const cfg = await loadConfig({ cwd, home });
  assert.deepEqual(resolveProfile(cfg, "coder"), {
    agent: "omp", model: "m1", effort: "high",
    write: true, mesh: false, systemPrompt: "你是 coder",
  });
  assert.equal(resolveProfile(cfg, "ghost"), null);
});

test("type:cli 深度校验:坏 args/promptVia/timeoutMs → 抛带文件路径的错", async () => {
  const a = makeDirs();
  writeFileSync(join(a.cwd, "synod.config.mjs"),
    `export default { backends: { b: { type: "cli", bin: "x", args: ["ok", 5] } } };`);
  await assert.rejects(loadConfig({ cwd: a.cwd, home: a.home }), /backends\.b\.args.*array of strings.*synod\.config\.mjs/s);

  const b = makeDirs();
  writeFileSync(join(b.cwd, "synod.config.mjs"),
    `export default { backends: { b: { type: "cli", bin: "x", promptVia: "env" } } };`);
  await assert.rejects(loadConfig({ cwd: b.cwd, home: b.home }), /backends\.b\.promptVia.*"arg" or "stdin"/s);

  const c = makeDirs();
  writeFileSync(join(c.cwd, "synod.config.mjs"),
    `export default { backends: { b: { type: "cli", bin: "x", timeoutMs: -1 } } };`);
  await assert.rejects(loadConfig({ cwd: c.cwd, home: c.home }), /backends\.b\.timeoutMs.*positive number/s);
});

test("type:cli 合法可选字段 → 通过", async () => {
  const { home, cwd } = makeDirs();
  writeFileSync(join(cwd, "synod.config.mjs"),
    `export default { backends: { good: { type: "cli", bin: "x", args: ["a", "b"], promptVia: "stdin", modelFlag: "--model", versionArgs: ["-v"], timeoutMs: 5000 } } };`);
  const cfg = await loadConfig({ cwd, home });
  assert.equal(cfg.backends.good.promptVia, "stdin");
  assert.equal(cfg.backends.good.timeoutMs, 5000);
});

test("agent write/mesh 非 boolean → 抛错;defaults 浅合并(后层覆盖)", async () => {
  const a = makeDirs();
  writeFileSync(join(a.cwd, "synod.config.mjs"),
    `export default { agents: { x: { backend: "omp", write: "yes" } } };`);
  await assert.rejects(loadConfig({ cwd: a.cwd, home: a.home }), /agents\.x\.write must be a boolean/s);

  const { home, cwd } = makeDirs();
  writeFileSync(join(home, ".synod", "config.mjs"),
    `export default { defaults: { model: "g", effort: "low" } };`);
  writeFileSync(join(cwd, "synod.config.mjs"),
    `export default { defaults: { model: "p" } };`);
  const cfg = await loadConfig({ cwd, home });
  assert.equal(cfg.defaults.model, "p", "项目层覆盖全局层");
  assert.equal(cfg.defaults.effort, "low", "未覆盖的保留");
});

test("registerConfigBackends:type:cli 注册 generic 适配器;与内置同名拒绝", async () => {
  const cfg = {
    backends: {
      "t6-echo": { type: "cli", bin: process.execPath, args: ["-e", "console.log('v1')"], promptVia: "arg" },
    },
  };
  await registerConfigBackends(cfg);
  assert.ok(backendNames().includes("t6-echo"));
  assert.equal(typeof getBackend("t6-echo").open, "function");
  _unregisterForTests("t6-echo");

  await assert.rejects(
    registerConfigBackends({ backends: { omp: { type: "cli", bin: "x" } } }),
    /already registered/,
  );
});

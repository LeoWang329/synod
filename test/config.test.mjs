// test/config.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "../src/config.mjs";

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

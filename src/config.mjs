// synod/src/config.mjs — 层叠配置:内置 → ~/.synod/config.mjs → ./synod.config.mjs。
// 后层覆盖前层(按顶层键浅合并:agents/backends/defaults 逐条目覆盖)。
// 配置就是 JS(可写常量/函数复用);加载即校验,错误带文件路径,fail fast。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerBackend, getBackend as _getBackend } from "./backends/registry.mjs";
import { makeGenericCliAdapter } from "./backends/generic-cli.mjs";

function fail(file, msg) {
  throw new Error(`config error: ${msg} (in ${file})`);
}

function validateLayer(cfg, file) {
  if (!cfg || typeof cfg !== "object") fail(file, "default export must be an object");
  for (const [name, p] of Object.entries(cfg.agents ?? {})) {
    if (!p || typeof p !== "object") fail(file, `agents.${name} must be an object`);
    if (typeof p.backend !== "string" || !p.backend) {
      fail(file, `agents.${name}: "backend" is required (non-empty string)`);
    }
    for (const k of ["model", "effort", "role"]) {
      if (p[k] !== undefined && (typeof p[k] !== "string" || !p[k])) {
        fail(file, `agents.${name}.${k} must be a non-empty string`);
      }
    }
    for (const k of ["write", "mesh"]) {
      if (p[k] !== undefined && typeof p[k] !== "boolean") {
        fail(file, `agents.${name}.${k} must be a boolean`);
      }
    }
  }
  for (const [name, b] of Object.entries(cfg.backends ?? {})) {
    if (!b || typeof b !== "object") fail(file, `backends.${name} must be an object`);
    if (b.type === "cli") {
      if (typeof b.bin !== "string" || !b.bin) fail(file, `backends.${name}: "bin" is required`);
      if (b.args !== undefined && (!Array.isArray(b.args) || b.args.some((a) => typeof a !== "string"))) {
        fail(file, `backends.${name}.args must be an array of strings`);
      }
      if (b.versionArgs !== undefined && (!Array.isArray(b.versionArgs) || b.versionArgs.some((a) => typeof a !== "string"))) {
        fail(file, `backends.${name}.versionArgs must be an array of strings`);
      }
      if (b.promptVia !== undefined && b.promptVia !== "arg" && b.promptVia !== "stdin") {
        fail(file, `backends.${name}.promptVia must be "arg" or "stdin", got "${b.promptVia}"`);
      }
      if (b.modelFlag !== undefined && (typeof b.modelFlag !== "string" || !b.modelFlag)) {
        fail(file, `backends.${name}.modelFlag must be a non-empty string`);
      }
      if (b.timeoutMs !== undefined && (typeof b.timeoutMs !== "number" || !Number.isFinite(b.timeoutMs) || b.timeoutMs <= 0)) {
        fail(file, `backends.${name}.timeoutMs must be a positive number`);
      }
    } else if (b.type === "module") {
      if (typeof b.path !== "string" || !b.path) fail(file, `backends.${name}: "path" is required`);
    } else {
      fail(file, `backends.${name}: type must be "cli" or "module", got "${b.type}"`);
    }
  }
}

async function loadLayer(file) {
  if (!fs.existsSync(file)) return null;
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    // import 抛的 SyntaxError 只把文件名埋在 stack 里;cli 只打 message,分不清哪层。
    throw new Error(`config error: failed to load — ${err.message} (in ${file})`, { cause: err });
  }
  const cfg = mod.default;
  validateLayer(cfg, file);
  return cfg;
}

export async function loadConfig({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const files = [
    path.join(home, ".synod", "config.mjs"),
    path.join(cwd, "synod.config.mjs"),
  ];
  const merged = { agents: {}, backends: {}, defaults: {}, sources: [] };
  for (const file of files) {
    const cfg = await loadLayer(file);
    if (!cfg) continue;
    merged.sources.push(file);
    Object.assign(merged.agents, cfg.agents ?? {});
    const dir = path.dirname(file);
    for (const [name, b] of Object.entries(cfg.backends ?? {})) {
      if (b.type === "module") {
        merged.backends[name] = { ...b, path: path.resolve(dir, b.path) };
      } else if (b.type === "cli" && /[\\/]/.test(b.bin)) {
        // 含路径分隔符的相对/绝对 bin 锚到声明它的 config 层目录;裸命令名留给 PATH。
        merged.backends[name] = { ...b, bin: path.resolve(dir, b.bin) };
      } else {
        merged.backends[name] = { ...b };
      }
    }
    Object.assign(merged.defaults, cfg.defaults ?? {});
  }
  return merged;
}

/** profile 名 → openBackend 参数形(role → systemPrompt);未知名返回 null。 */
export function resolveProfile(config, name) {
  const p = config?.agents?.[name];
  if (!p) return null;
  return {
    agent: p.backend,
    model: p.model,
    effort: p.effort,
    write: p.write,
    mesh: p.mesh,
    systemPrompt: p.role,
  };
}

/** 把 config.backends 注册进 adapter 注册表(在内置注册之后调用)。 */
export async function registerConfigBackends(config) {
  for (const [name, spec] of Object.entries(config.backends ?? {})) {
    if (_getBackend(name)) {
      throw new Error(`config error: backend "${name}" already registered (built-in or duplicate)`);
    }
    if (spec.type === "cli") {
      registerBackend(makeGenericCliAdapter(name, spec));
    } else {
      const mod = await import(pathToFileURL(spec.path).href);
      const adapter = mod.default;
      if (!adapter || adapter.name !== name) {
        throw new Error(
          `config error: backend module ${spec.path} must default-export an adapter with name "${name}"`,
        );
      }
      registerBackend(adapter);
    }
  }
}

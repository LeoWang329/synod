// synod/src/flow/api/resolve-opts.mjs — flow 原语共用的 profile 合并。
// profile 取自 config.agents;内联字段覆盖 profile;role → systemPrompt。
export function makeResolveOpts(config) {
  return function resolveOpts(opts) {
    if (!opts.profile) return opts;
    const p = config?.agents?.[opts.profile];
    if (!p) throw new Error(`unknown profile "${opts.profile}"`);
    const merged = {
      agent: p.backend, model: p.model, effort: p.effort,
      write: p.write, mesh: p.mesh, systemPrompt: p.role,
    };
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && k !== "profile") merged[k] = v;
    }
    return merged;
  };
}

// synod/src/ui/flow-view.mjs — /flow 运行视图(§5):头尾横幅 + 结果块 + turns/sessions/耗时计数。
// 仅在 progress 开启时使用(REPL /flow 与 --progress)。
import { enabled, color } from "./ansi.mjs";

function rule(label, stdout, env, width = 50) {
  const text = `── ${label} `;
  const dashes = "─".repeat(Math.max(3, width - text.length));
  const line = text + dashes;
  return (enabled(stdout, env) ? color(2, line) : line) + "\n";
}

export function createFlowView({ stdout, name, clock = () => Date.now(), env = process.env }) {
  const startedAt = clock();
  let turns = 0;
  let sessions = 0;
  return {
    banner() {
      stdout.write(rule(`flow ${name}`, stdout, env));
    },
    countingSink(inner) {
      return {
        emit(event) {
          if (event.type === "opening") sessions += 1;
          if (event.type === "start") turns += 1;
          if (inner) inner.emit(event);
        },
      };
    },
    result(value) {
      stdout.write(rule("result", stdout, env));
      if (value !== undefined) stdout.write(JSON.stringify(value, null, 2) + "\n");
      const secs = ((clock() - startedAt) / 1000).toFixed(1);
      stdout.write(rule(`done · ${turns} turns · ${sessions} sessions · ${secs}s`, stdout, env));
    },
    failed() {
      stdout.write(rule("failed", stdout, env));
    },
  };
}

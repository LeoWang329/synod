// synod/src/ui/history.mjs — REPL 历史持久化(§3.4)。~/.synod/history,上限默认 1000,启动加载。
import fs from "node:fs";
import path from "node:path";

export function historyPath(home) {
  return path.join(home, ".synod", "history");
}

export function loadHistory(file, max = 1000) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-max).reverse();
  } catch {
    return [];
  }
}

export function appendHistory(file, line) {
  if (!line || !line.trim()) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* best-effort */
  }
}

// synod/src/ui/completer.mjs — readline tab 补全(§3.1)。纯函数 → 可单测。
const COMMANDS = [
  "/open", "/use", "/close", "/sessions", "/relay", "/unrelay", "/relays",
  "/flow", "/status", "/help", "/exit", "/quit",
];
const OPEN_OPTS = ["--agent", "--model", "--effort", "--write", "--mesh", "--no-mesh"];

export function makeCompleter({ sm, config = { agents: {} }, flows = [], backendNames = () => [] }) {
  const labels = () => [...sm._sessions.keys()];

  return function completer(line) {
    if (/^\/\S*$/.test(line)) {
      const hits = COMMANDS.filter((c) => c.startsWith(line));
      return [hits.length ? hits : COMMANDS, line];
    }
    if (/^@\S*$/.test(line)) {
      const cands = ["@all", ...labels().map((l) => "@" + l)];
      return [cands.filter((c) => c.startsWith(line)), line];
    }

    const parts = line.split(/\s+/);
    const cmd = parts[0];
    const endsSpace = /\s$/.test(line);
    const word = endsSpace ? "" : parts[parts.length - 1];

    if (cmd === "/use" || cmd === "/close") {
      return [labels().filter((l) => l.startsWith(word)), word];
    }

    if (cmd === "/open") {
      const prev = parts[parts.length - 2];
      if (prev === "--agent") {
        return [backendNames().filter((n) => n.startsWith(word)), word];
      }
      const cands = [
        ...Object.keys(config.agents ?? {}).map((p) => "+" + p),
        ...OPEN_OPTS,
      ];
      return [cands.filter((c) => c.startsWith(word)), word];
    }

    if (cmd === "/relay" || cmd === "/unrelay") {
      const arrow = word.indexOf("->");
      if (arrow === -1) {
        return [labels().filter((l) => l.startsWith(word)).map((l) => l + "->"), word];
      }
      const left = word.slice(0, arrow + 2);
      const rightPartial = word.slice(arrow + 2);
      return [labels().filter((l) => l.startsWith(rightPartial)).map((l) => left + l), word];
    }

    if (cmd === "/flow" && parts.length <= 2) {
      return [flows.map((f) => f.name).filter((n) => n.startsWith(word)), word];
    }

    return [[], line];
  };
}

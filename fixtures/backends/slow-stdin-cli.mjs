// fixtures/backends/slow-stdin-cli.mjs — 读完整个 stdin 再回显(配合大 prompt 测背压)。
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => { process.stdout.write("ok:" + s.length); process.exit(0); });

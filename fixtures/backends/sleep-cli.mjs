// fixtures/backends/sleep-cli.mjs — 挂住 10s(测 timeout / close 杀进程)。
setTimeout(() => console.log("done"), 10_000);

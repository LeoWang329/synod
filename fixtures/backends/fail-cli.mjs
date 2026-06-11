// fixtures/backends/fail-cli.mjs — 写 stderr 并以 2 退出(测失败路径)。
console.error("boom: bad things");
process.exit(2);

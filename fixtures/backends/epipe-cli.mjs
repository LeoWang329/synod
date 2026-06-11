// fixtures/backends/epipe-cli.mjs — promptVia:"stdin" 的 CLI 在读完 prompt 前就退出,
// 制造写端 EPIPE(无 stdin error 监听则崩宿主)。
process.stdin.resume();
setTimeout(() => process.exit(1), 20);   // 不读 stdin、很快退出

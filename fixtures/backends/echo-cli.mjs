// fixtures/backends/echo-cli.mjs — argv 模式回显;无参时读 stdin 回显。
const arg = process.argv[2];
if (arg !== undefined) {
  console.log("echo: " + arg);
} else {
  let s = "";
  process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => console.log("echo-stdin: " + s.trim()));
}

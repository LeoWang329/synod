// src/ui/tui/capture.mjs — 把 sm/dispatch/relay 的流写入按行转成 UI 系统消息。
// session-manager / dispatch 只用到流的 .write(string);最小鸭子类型即可。
export function makeCaptureStream(onLine) {
  let buf = "";
  return {
    write(chunk) {
      buf += String(chunk);
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const line of parts) if (line.length) onLine(line);
      return true;
    },
  };
}

import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { html } from "../html.mjs";
import { theme } from "../theme.mjs";
const VISIBLE = 6;
const BLINK_MS = 530;   // 贴近终端原生光标节奏(~1Hz 开/关)
export function InputBar({ focusLabel, value, hints, selected = 0, approve }) {
  // 自绘光标的闪烁:定时翻转 ▌/空格(等宽,不抖动)。硬件光标已被 HIDE_CURSOR 藏掉,故走自绘。
  // interval 必须 unref——否则单进程跑全套测试时会吊住事件循环不退出;真 TUI 里 Ink 的 stdin 监听维持存活,照闪。
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((o) => !o), BLINK_MS);
    t.unref?.();
    return () => clearInterval(t);
  }, []);
  const cursor = on ? "▌" : " ";
  const items = hints && hints.items ? hints.items : [];
  // 选中项始终在 6 行窗口内:超出窗口时把窗口下滚,让 selected 贴在底部可见。
  const sel = items.length ? Math.max(0, Math.min(selected, items.length - 1)) : 0;
  const start = sel < VISIBLE ? 0 : sel - VISIBLE + 1;
  const win = items.slice(start, start + VISIBLE);
  return html`<${Box} flexDirection="column">
    ${items.length ? html`<${Box} flexDirection="column" paddingX=${1}>
      ${win.map((it, i) => {
        const on = start + i === sel;   // ❯ 标记 + 高亮选中项(无色测试渲染器也能凭 ❯ 断言)
        return html`<${Box} key=${it.value}>
          <${Text} color=${on ? theme.accent : theme.tool} bold=${on}>${on ? "❯ " : "  "}${it.value}<//>${it.desc ? html`<${Text} color=${theme.dim}>  ${it.desc}<//>` : null}
        <//>`;
      })}
      <${Text} color=${theme.dim}>  ↑↓ 选择 · Tab 补全${items.length > VISIBLE ? ` · ${sel + 1}/${items.length}` : ""}<//>
    <//>` : null}
    <${Box} borderStyle="single" borderColor=${theme.borderBright} borderLeft=${false} borderRight=${false} paddingX=${1}>
      <${Text} color=${theme.accent} bold>[${focusLabel || "—"}] ${approve ? "approve " : ""}❯ <//><${Text} color=${theme.text}>${value}${cursor}<//>
    <//>
  <//>`;
}

# agent-bridge 使用错误记录(1C-a 会话)

> 用户要求:遇到 agent-bridge 工具使用错误记录于此,便于后期调试。
> 每条记录:时间 / 调用的工具 + 参数要点 / 报错原文 / 处置。

## 结论:本会话 agent-bridge 工具调用全部成功,**零工具错误**。

环境:agent-bridge 0.8.4 / omp 15.9.1 / codex-cli 0.137.0 / Node v26。

调用清单(均成功):
- `doctor` ×2 — 正常返回可用性。
- `open_session`(omp+deepseek 探活)— 返回 "TEST-PASSED",借此确认 minimax 余额耗尽、deepseek 正常。
- `open_session`(omp 默认模型探活)— 返回 `text:null`(MiniMax-M3 余额耗尽,触发 auto_retry),据此切 deepseek。
- `open_session`(codex 审查 ×2 / omp+deepseek 审查 ×2)— 三轮三方复审,均正常返回结构化报告。
- `wait` / `result` / `status` / `close_session` — 全部正常。

## 唯一"异常"(非 agent-bridge 工具错误)
- **minimax(MiniMax-M3)默认模型返回空字符串**:这是模型账号**余额不足**,不是 agent-bridge 工具的使用错误。
  处置:按用户指令把 e2e 的 omp 调用切到 `deepseek/deepseek-v4-pro`(经 `SYNOD_OMP_MODEL`/`SYNOD_FLOW_MODEL` 注入),codex 评审不受影响。

(若后续出现真正的 agent-bridge 工具使用错误,在此追加条目。)

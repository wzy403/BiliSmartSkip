# 额外 300 个视频：失败元数据的内容审核补采

本目录仅保存内容审核采集资料，不包含算法输出、弹幕、社区标签或内容审核结论。

- 原始输入：`eval/data/danmaku-audit-20261001/new-public.jsonl`，保持不变。
- `recover-metadata.cjs`：复用 `eval/collect-public.cjs` 的 `initialState()` 公共页面解析器；不调用同时采集弹幕的 `collect()`。只尝试原始输入中 metadata 为 failed/error 的记录。
- `metadata-recovery-sandbox-attempt.json`：默认网络沙箱尝试结果；DNS 错误不能证明视频不可用。
- `metadata-recovery-summary.json`：获网络许可后的公开页面重试结果。每条保留原始 BV/CID、输入行号、输入行 SHA-256、请求地址、观察时间、响应 SHA-256 及具体问题。
- `recovered-for-subtitles.jsonl`：只有目标 BV 和原始 CID 均能核实的记录才进入此文件，供后续字幕采集；空文件表示未恢复任何输入。

如果视频的当前分 P 列表不含原始 CID，记录实际分 P 的 CID、时长、名称，但不把当前分 P 替换为原始待审核视频。公共页缺失元数据也不推断视频无广告。以上问题均须作为待核实原因处理，不计入已完成审核。

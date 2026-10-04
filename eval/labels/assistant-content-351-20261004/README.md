# 可复用的全文字幕内容参考

用户要求撤销上一轮算法优化，保留内容审核和测试资料。这里的 250 份记录、原始字幕、manifest 和 freeze 已原样恢复，哈希未变；生产运行代码仍为 2.1.0。旧算法报告、候选输出和中间实验没有恢复。

- `records/`：250 个视频的字幕全文判断、广告原始起止、应跳/应保留决定、原文证据和不确定范围。
- `review-index.md`：351 个视频的索引；101 个资料不足，不当作无广告。
- `manifest.json`、`freeze.json`：原始内容参考与输入的哈希。manifest 中的 `baseline` 仅为历史来源，新的评估器不会用它选择对照算法。
- `source-bundles.json`、`../../fixtures/`：可在其他 checkout 还原的压缩语料，不依赖临时备份目录。
- 原 48 份审核保存在 `../assistant-content-20261004/`，已包含在这 250 个中，不能重复计数。用户更正保存在 `../human/`。
- 新增 300 个视频只保留原始输入，没有逐个审核广告范围，不能直接计入标记正确率。

这些是助手根据完整字幕做的内容参考，不是逐帧视听核验。字幕空隙、未审内容与不确定决定始终未知。需要核实争议时保留来源并单独版本化修订，不能迎合算法改标签。原作者验证分组已被使用，不能称为新的未见验证。

## 恢复并比较发布版本

在 test-branch 根目录运行：

```sh
node eval/restore-content-inputs.cjs
node eval/audit-full-content.cjs check
node eval/compare-release-markings.cjs /Users/woshiyingyan/.codex/worktrees/danmaku-optimization/BiliSmartSkip/scr
```

最后一个命令重新执行 v2.0.1、固定的 2.1.0 提交和指定目录代码。省略源码目录时使用当前 checkout 的 scr/。输出默认写到被 Git 忽略的 eval/output/release-markings.json；第二个位置参数可指定输出文件。数据来自内容参考，检测输入只包含原始视频资料，不含标签。

## 统一的标记判定

主要统计全部标记，不区分自动与手动确认。一个原始标记与一个应跳广告对应，起止各相差不超过 5 秒并实际相交即合格；不附加 90% 门槛，不合并碎片或重复记功。额外标入广告边界 5 秒容差以外的已知应保留内容，计作误标正文/保留内容。其他已知但不合格的标记记作部分广告或边界问题，未知单列。

正确率与误标率均以所有标记为分母；“整段没跳完”不是“误跳正文”。另统计有应跳广告且所有广告均有合格标记的视频数，避免用少报标记换取表面正确率。

旧 audit-content-review.cjs 的按秒计分工具保留供诊断，不能把它的完整覆盖或秒数精确率当成上述标记正确率。audit-full-content.cjs 默认对照已改为固定 2.1.0，不会回放旧优化提交。

```sh
node --test eval/audit-content-review.test.cjs eval/audit-full-content.test.cjs eval/compare-release-markings.test.cjs
```

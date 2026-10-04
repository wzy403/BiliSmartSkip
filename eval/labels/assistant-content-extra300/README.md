# 新增 300 个视频的助手内容参考

快照状态：**partial**。已完成 **188/300**；完成项中有应跳广告 **174**、没有应跳广告 **14**；仍待核实 **112**。

这些数据是助手依据注明证据进行的内容参考，不是用户人工标签，也不是全视频视听核验结果。只做内容审核与广告范围标注，未修改检测算法、未评估算法准确率，未启动旧 HTML 服务。

原始新增输入为 `eval/data/danmaku-audit-20261001/new-public.jsonl`，SHA-256：`47313ea513bc15b8b1219dd27319aa17b88d1de811697fb0439f562e0f924fa5`。初始300个视频全部无字幕；当前补采后有字幕209个、仍无字幕91个。有字幕仅代表可以开始阅读，只有真实阅读全文并解决关键判断的 reviewed 项计入完成。

初始输入具有300个唯一BV、300个唯一CID；格式、时长、重复和与原351/旧250记录重叠核验见 initial-audit.json。旧250份内容参考没有被覆盖或重复计数；原始输入保持不变。所有新增资料仅保存在 test-branch，脚本不提交、不推送。

## 审核标准

审核者只读取去除预测、弹幕和社区广告参考的 sources/，连续完整阅读字幕并保存 readCoverage。广告性质与跳过决定分别判断；题目主题中的产品体验、知识说明和必要商业内容可以 ad/keep。广告段包含确认属于推广的铺垫、商品介绍和收尾，没有按未来5秒评价容差缩短标签。字幕空白保持未知，正文区间只断言实际字幕覆盖内容。

首次输入结构检查时，仅负责元数据审计的助手意外见到第1个视频的一小段弹幕；该助手没有参与该视频的内容标注。实际内容审核者使用隔离后的盲审来源，此事未用于广告判断。

有补充选定画面观察的记录：BV11QRrBcEp7（1条观察，reviewed）、BV12u2WB4EfP（4条观察，reviewed）、BV172hdz7EAF（13条观察，reviewed）、BV1byMc66Eyk（16条观察，reviewed）、BV1cYe4zLE55（212条观察，reviewed）、BV1daSeYXEoL（13条观察，reviewed）、BV1EZiRYJEFy（1条观察，reviewed）、BV1FSr8BdEz8（3条观察，reviewed）、BV1gUQtYvEFC（93条观察，reviewed）、BV1JJUsB4E21（35条观察，reviewed）、BV1KHxazUEeG（3条观察，reviewed）、BV1M1421t7fr（78条观察，reviewed）、BV1mx411M75v（24条观察，reviewed）、BV1nRCcB2EHX（1条观察，reviewed）、BV1omoHYzEST（2条观察，reviewed）、BV1oXA8zuEXL（2条观察，reviewed）、BV1PpCYYJEXU（2条观察，reviewed）、BV1rsPqzvEW1（7条观察，needs-verification）、BV1RxfnBwEd9（17条观察，reviewed）、BV1T8qcBGE8W（20条观察，reviewed）、BV1U5PjzQEPd（2条观察，reviewed）、BV1UGN3zrEVy（17条观察，reviewed）、BV1VimuBiELP（4条观察，reviewed）、BV1y3L26LEQj（5条观察，reviewed）、BV1yp2JYQEEe（2份帧索引，reviewed）、BV1zw4m1e7F8（3份帧索引，reviewed）、BV1Zw4m1k7mZ（1份帧索引，reviewed）。证据可以来自浏览器画面或已下载原片的选定解码帧，具体时间、观察者与限制见各记录的 visualObservations / secondaryReview。帧索引数量不是实际逐帧观看数量；选定画面观察不等于逐帧查看或完整视听。

acquisition/media/ 中若保存公开原片、提取帧或媒体检查摘要，原片仅用于本地内容审核，不作为对外发布素材。实际证据帧和已完成媒体的文件哈希纳入 freeze；临时 .part 文件及仍在下载的摘要不冻结。提帧只代表查看注明的画面，不能据此声称听过音频或逐帧核验。

自动字幕可能存在错识、翻译或缺口；具体未决边界、资料缺失和应跳争议保存到逐视频 limitations / pendingReasons 与 pending.md。无字幕不等于无广告，needs-source、needs-review、needs-verification均不计入完成。

## 文件

- records/：每视频判断、摘要、完整阅读覆盖、广告与跳过决定、字幕原文证据和边界不确定性。
- sources/：用于盲审的视频身份、标题、简介、字幕及必要采集信息，按记录中的哈希固定。
- acquisition/：采集检查点和不含登录凭据的必要诊断资料；仅用于证据来源，不供内容审核反向照抄标签。
- initial-audit.json：原输入整文件与逐行原始字节哈希、身份/重复/重叠检查，以及初始分支和旧记录哈希。
- manifest.json、freeze.json：全部300个视频的状态、计数、来源和文件哈希；partial明确表示审核尚未全部完成。
- validation-report.json、pending.md：结构/时间/证据校验结果及逐项未完原因。

- normal-range-corrections.json：正文区间与实际字幕覆盖求交的规范修正日志，保存修改前后范围与哈希；广告判断和复核状态不因该修正改变。
- reviewed-gap-audit.json：已完成记录中较长字幕空白且没有登记视觉补充的提示清单；这是资料完整性提醒，不是广告判定。

## 复核与复现

在 test-branch 的项目根目录运行：

```sh
node eval/labels/assistant-content-extra300/validate.cjs
```

该命令只做身份、哈希、结构、证据原文、时间范围、重复/冲突和计数检查，不执行算法，也不证明人工式内容理解已完成。freeze.json固定的原始输入可用项目既有还原工具恢复；已保存的补采字幕和盲审文本可离线复核，不依赖重新登录或临时字幕链接。未保存原始媒体的选定画面观察仅有观察记录，重新进行视听核验仍需取得对应视频资料。

停稳补采和标注写入后，运行 finalize.cjs 重新生成本清单与哈希快照；后续文件变化会使旧freeze失效，应明确重新版本化。QR图片、临时日志和任何登录凭据不纳入freeze，也不应提交到Git。

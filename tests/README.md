# 数据获取、Issue #14 与多段跳过回归

**2026-11-12 更新**：检测管线已改为多证据融合（见 [评测说明](../eval/README.md)）。下列测试随之调整，旧行为的断言凡是有意改变的都在测试里写明了原因：

- `ad-signals.test.cjs`（新）：弹幕写法解析、到达确认、广告反应、目的地聚类、起点取法、自动/手动条件、词表打分。
- `subtitle-blocks.test.cjs`（原 `subtitle-local.test.cjs`）：字幕口播段——普通词不成段、链接话术要挨着可买可领的东西、单句鸣谢不算、片尾短回扣、换行拼接。
- `regression.test.cjs`、`optimization-regression.test.cjs`、`early-timestamp.test.cjs`、`label-confidence.test.cjs`、`multiple-segments.test.cjs`：按新策略更新。主要变化：没有任何佐证的单条“空降 X:XX”改为手动提示；字幕覆盖且毫无商业内容的单条指路不再提示；普通时间引用和否定指令不再生成提示；片尾广告与多段标注全部保留；跨来源取舍函数改名为 `reconcileSegments`。
- `skipper-ui.test.cjs`：新增“广告直到片尾时不重播”。
- 已删除 `heatmap-pipeline.test.cjs`、`heatmap-verifier.test.cjs`（对应的生产模块已移除）。
- `../eval/train-pitch-model.test.cjs`（新）：词表训练的确定性、序列化、与基准的一致性、validation 不进训练。

两个原用户案例（`BV1r1421r7am`、自然植入的拼多多促销）仍然通过，未改断言。

运行时必须把 `BILISMARTSKIP_SOURCE_DIR` 指向算法分支的 `scr`；本分支自带的 `scr/` 是旧版本，只用于 DEBUG 默认值检查。

以下为此前的说明。

当前完整回归包含算法优化和热度辅助验证，请使用 [空间整理与当前运行命令](../eval/CLEANUP-NOTES.txt) 导出 `fix/improve-detction-rate` 的源码后执行。原片、字幕采集中间检查点不参与这些测试。下文旧 `.codex` 路径已停用。

`test-branch` 长期保持 `scr/constants.js` 中的 `DEBUG = true`，合并 `master` 更新时保留此分支设置。测试默认使用该设置，并单独验证显式关闭 DEBUG 时不输出检测与跳过日志。

在 `test-branch` 的仓库根目录运行全套生产回归，不需要 npm install 或 package.json：

```sh
node --test tests/*.test.cjs
```

基础生产测试使用同一版本的 `scr/`、本目录的测试文件、`harness.cjs` 和 `fixtures.cjs`。新增优化回归还使用 `eval/runner.cjs`；均不依赖采集工具、语料下载或生成产物。

算法与回归分支分开时，设置 `BILISMARTSKIP_SOURCE_DIR` 指向待测算法的 `scr`，所有生产脚本测试都使用该目录；发布版回放仍固定读取 Git 提交，不受此环境变量影响。本轮优化保留在 `fix/improve-detction-rate`，测试分支的 `scr` 没有复制新算法。验收命令：

```sh
BILISMARTSKIP_SOURCE_DIR=/Users/woshiyingyan/.codex/worktrees/danmaku-optimization/BiliSmartSkip/scr \
node --test tests/*.test.cjs eval/*.test.cjs eval/*.test.mjs eval/labels/*.test.cjs eval/review/*.test.cjs
```

在其他机器上将路径替换为该算法分支的工作树。`optimization-regression.test.cjs` 使用 `eval/runner.cjs` 加载指定生产源码，并回归两个原用户案例；其中自然植入案例只有完整保存的字幕和三条弹幕子集，不代表完整登录数据。测试覆盖实际 `timeupdate`、手动按钮和 seek，失败不能以检测到关键词代替。

Node 内置 `node:test` / `node:vm` 加载真实的 `constants.js`、`utils.js`、`detectors.js`、`segment-detector.js`、`skipper.js` 和 `content.js`。DOM、视频元素、Chrome storage、时钟和网络响应由最小夹具替代；真实检测、模式切换、`timeupdate`、按钮点击和 seek 代码都会执行。

`api.test.cjs` 和 `page-data.test.cjs` 另外加载真实的 `api.js` 与页面数据脚本，使用模拟响应测试获取流程，不请求真实 B 站接口。

覆盖包括：

- 页面元数据读取、跨域会话、412 回退、分 P 选择与旧 BV 拒绝、弹幕并发和部分失败，以及弹幕全失败时章节／简介检测继续工作。
- Issue #14 的真实字幕缩减夹具，以及 79 秒“免费／搜索”宽词误跳路径。
- 局部字幕商业证据、普通教程链接、否定表述、章节置信度和早期广告时轴。
- 明确跳过指令、中文时间、普通或重复时间引用，以及缺失字幕或弹幕。
- 完整广告边界、多段之间的正文、跨来源冲突降为手动确认，以及短赞助声明和产品主题保留。
- 每段独立的确认要求、切换模式、倒计时、过期按钮、播放器替换和每段只自动跳一次。
- 150 个宽泛字幕组合和 38 个明确时轴组合；这些是合成矩阵，不是实测准确率。

最小合成复现：`weakSubtitles` 在 79 秒出现“免费”、99 秒出现“搜索”，弹幕为空。旧版 `88652cd` 返回 79–103 秒并在自动模式 seek 到 103.05；当前版本不再仅凭这些词生成候选，也不跳转。明确推广但缺少可靠边界的字幕仍可提供手动候选；完整区间模块另行检查赞助结构与边界，不会仅凭零散关键词授权自动跳过。

`issue14-real.test.cjs` 保留原视频 `BV1GxdRBJE6u` 的“种草”（78.54 秒）、“性价比”（152.96 秒）及三条中性字幕。完整字幕在旧版回放得到 78.54–154.72 秒并自动跳到 154.77，当前缩减夹具不生成候选。这支持字幕关键词误判是最可能路径，但不是报告发生当时的浏览器日志。

其他真实输入已裁减后直接写在测试中，并注明 BV 和来源，包括 `BV1a5N4zxEQe` 中历史叙事的“购买”不能延长前方推广、公开弹幕中的短广告／中文零补位，以及 `BV1iH4y1w7i2` 的早期明确广告时轴。它们不是完整人工真值，也不需要保留整份语料。

通过率验证代码路径和保护条件，不能作为真实视频上的误跳率或召回率。这套夹具不模拟浏览器布局、B 站登录／风控、网络协议或视频解码。离线语料评估属于测试分支的独立工具，不随生产扩展安装。

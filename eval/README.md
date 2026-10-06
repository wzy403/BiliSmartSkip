# 独立测试分支：回放、采集与人工审核

`tests/` 和 `eval/` 保存在 `test-branch`，不随生产扩展发布。生产算法位于 `fix/improve-detction-rate`；测试时可临时导出该分支的源码，无需合并分支或挂载工作树。**不要把 `test-branch` 整支合并回 master**。

2026-10-06 已清理回测不使用的原视频、字幕采集中间副本和旧临时报告，保留全部审核记录、最终字幕和证据截图。必留目录、空间说明、当前离线测试/回测命令及原片恢复方法见 [CLEANUP-NOTES.txt](CLEANUP-NOTES.txt)。下面保留历史工具说明；历史 `.codex` 工作树路径已经停用。

## 从 2.1.0 重新优化

按用户要求，只撤销算法补丁，保留内容审核。两批已核对并接入统一基准：旧 250 个＋新增已审核的 188 个，共 438 个无重复视频。新增目录另 112 份未完记录不计分；两处旧助手判断与人工意见冲突已有独立修正，不覆盖原标签。

交接用 [RESTART-PROMPT.txt](RESTART-PROMPT.txt)。先阅读[已接通的 438 视频基准](benchmarks/content-438-v1/README.md)，再运行：

```sh
node eval/restore-content-inputs.cjs
node eval/content-benchmark.cjs check
node eval/compare-release-markings.cjs /Users/woshiyingyan/.codex/worktrees/danmaku-optimization/BiliSmartSkip/scr eval/output/content-438-development.json development
```

这个入口重新执行固定 2.0.1、2.1.0 和指定目录的当前算法。默认用 413 个 development 迭代；方案确定后将末尾 scope 改为 `all`，比较完整 438 个，并在报告中单列 25 个 validation。起止各允许 5 秒偏差，不附加 90% 门槛。未知资料不算无广告。数据接入和发布版基线已完成，新一轮可以直接优化算法。

下方是原有工具的说明；其中按秒计分、内部边界收缩和原始快照对比是不同用途，不能拿来替代上面的标记正确率。当前原有生产回归仍对应 2.1.0；上一轮依赖撤销补丁的专用断言没有恢复。

下列命令均在**测试工作树的仓库根目录**运行；当前算法来自该工作树的 `scr/`。生产发布从运行时分支或主分支打包，`.gitattributes` 的 `export-ignore` 提供额外的归档排除保护，不能替代分支隔离。

离线回放和回归测试只需 Node.js 20+，无 npm 依赖、无网络请求。登录字幕采集另需 Python 3 的 `qrcode`、`Pillow`，仅用于生成本地二维码图片。

## 保留的工具与数据

| 路径 | 用途 |
| --- | --- |
| `evaluate-segments.cjs`、`coverage.cjs` | 冻结基线与当前生产代码的完整区间、实际跳转和已标秒数比较 |
| `runner.cjs`、`../tests/harness.cjs` | 加载真实生产脚本，在播放器替身中执行检测与跳转 |
| `dataset.cjs`、`stats.cjs`、`metrics.cjs` | 语料读取、来源状态、统计和区间运算 |
| `labels/validate.cjs`、`labels/semantics.js` | 标签校验、作者分组及内容/跳过双轴语义 |
| `snapshots/pre-segment-v1/` | 唯一保留的修改前生产快照；加载时验证源码哈希 |
| `labels/human/` | 原始人工 v1 与有迁移依据的双轴 v2，均保留原文件 |
| `labels/assistant-seed-v2.json` | 开发用助手暂定建议，供审核，不是人工真值 |
| `labels/assistant-challenge-v1.json` | 冻结挑战参考，单独统计助手参考一致性 |
| `review/` | 本地审核页的准备、构建、导入与导出，见[审核说明](review/README.md) |
| `collect-public.cjs`、`crawl.mjs`、`qr-login.mjs`、`collect-subtitles.mjs`、`acquisition.mjs` | 公开元数据/弹幕与扫码后的串行字幕采集 |
| `data/combined-351.jsonl`、`data/evidence/` | 本机冻结语料及复核证据 |
| `output/` | 可重新生成的报告、审核页和采集二维码 |

`data/` 和 `output/` 被 Git 忽略，拉取测试分支不会自动取得本机语料或报告。使用已有数据时，从本地备份恢复到相同路径；勿把标签、报告放入待递归读取的语料目录。当前冻结输入含 351 条记录，其中 321 条具备可回放的元数据和弹幕；其余记录保留采集状态，不当作算法漏检。

## 回归与离线回放

```sh
node --test tests/*.test.cjs eval/*.test.cjs eval/*.test.mjs eval/labels/*.test.cjs eval/review/*.test.cjs

# 开发阶段：排除整个 holdout 作者组，默认预热 5 个视频
node eval/evaluate-segments.cjs --scope development --out eval/output/development

# 只回放人工反馈中的视频
node eval/evaluate-segments.cjs --scope human --out eval/output/human

# 算法冻结后，回放全部可用记录；保留集结果单列，不再据此调参
node eval/evaluate-segments.cjs --scope all --out eval/output/current
```

默认使用 `data/combined-351.jsonl`、`labels/human/review-2026-09-30-v2.json`、`labels/assistant-challenge-v1.json` 和 `snapshots/pre-segment-v1/`。其他输入可显式指定：

```sh
node eval/evaluate-segments.cjs \
  --input eval/data/combined-351.jsonl \
  --feedback eval/labels/human/review-2026-09-30-v2.json \
  --challenge eval/labels/assistant-challenge-v1.json \
  --snapshot eval/snapshots/pre-segment-v1 \
  --scope all --warmup 5 --out eval/output/current
```

输出 `report.json`、`per-video.jsonl`、`challenge.json` 和可直接打开的 `results.html`。报告保存语料、标签、生产快照和评估代码哈希。检测失败、静默退回旧路径、自动区间与实际 seek 不匹配均作为评估错误，CLI 返回非零状态，已写出的报告仍可排查。

评估规则：

- 检测输入只含视频身份、标题、时长、简介、章节、字幕和弹幕；人工标签、助手标签及社区参考不会进入 detector。
- 全部候选与实际自动跳转分别统计。一个候选只有在播放器替身中产生对应 seek，才计入实际自动区间。
- 目标是 `skipDecision`：广告可以应保留，内容性质未知也可以明确应保留。只有高置信的 `skip` / `keep` 秒数进入分母；未知时间独立列出，不能算正常或正确。
- precision、recall、F1、accuracy 按已标秒数计算。单段完整度要求一个原始预测覆盖一个原始、边界明确的应跳段至少 90%，不拼接碎片凑完整。边界不确定的明确决定只评分向内各收 5 秒后的范围。
- 人工、助手挑战参考以及 holdout 作者组分开报告。社区参考缺失不能证明没有广告。
- 检测计时不含真实网络；完整回放计时还包括 VM 和播放器替身开销。结果不能代替浏览器实机播放测试。

这批人工样本经过主动选取，也参与过问题诊断与开发；同一批样本上的改善**不是独立泛化准确率，也不是全站准确率**。未经标注的时间和采集失败的视频，不用于推断误跳或漏跳。

## 按需补齐语料

已有完整语料时无需重新采集。公开采集接受自己准备的 JSON 数组，或含 `seeds` / `videos` 数组的对象；每项提供有效 `bvid`，可提供目标分 P 的 `cid`。同一输出目录按 BV 缓存，分 P 任务应分开保存。

```sh
node eval/collect-public.cjs eval/data/seeds.json eval/data/public 100
```

公开采集串行间隔至少 1.2 秒；遇 HTTP 401/403/412/429 停止，失败记录也会缓存。目录中每条视频 JSON 可直接用于离线回放；给字幕爬虫前需合成 JSONL，例如：

```sh
node -e 'const fs=require("node:fs"); const {readDataset}=require("./eval/dataset.cjs"); fs.writeFileSync(process.argv[2],readDataset(process.argv[1]).map(JSON.stringify).join("\n")+"\n")' eval/data/public eval/data/public.jsonl
node eval/crawl.mjs --input eval/data/public.jsonl --out eval/data/public-subtitles.jsonl
```

看到 `qr-ready` 后，用 B 站 App 扫描输出的二维码文件并由本人确认。`--qr`、`--python`、`--qr-module-path` 可指定二维码路径和渲染环境；`node eval/crawl.mjs --help` 显示参数。`collect-subtitles.mjs` 是批量执行核心，登录入口为 `crawl.mjs`，不需要手工粘贴 Cookie。

会话只保存在当前进程内，不读取浏览器 Cookie，不导出 Cookie、字幕签名 URL 或完整播放器响应。字幕请求串行间隔至少 1.5 秒，访问限制、登录失效或风控会暂停；Ctrl+C 取消当前请求并保存进度。输出旁的 `.checkpoints/` 支持重跑恢复，已有字幕保留，元数据/弹幕失败项不请求。输入和输出必须不同；原人工标注、社区参考及其他字段保留。

`empty`、`unsupported`、`login-required` 或采集错误只说明数据获取状态，不是“无广告”。默认复用已完成状态；确认环境变化后可用 `--retry-unavailable` 主动重试。旧播放器接口仍可能不返回网页上可见的字幕，采集器不会绕过访问限制。

标注版本与计分含义见[标签说明](labels/README.md)；准备和继续人工审核见[审核页说明](review/README.md)。

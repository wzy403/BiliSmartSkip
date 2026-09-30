# 本地人工审核

审核页只在本机读取数据、保存进度和导出反馈，不上传数据，也不改变扩展的跳过策略。所有命令在测试分支仓库根目录执行，只需 Node.js。

## 继续已有审核

已有审核包原样保存在 `eval/data/review-bundle.json`，原审核页保存在 `eval/output/review.html`。日常续标直接打开原页面：

```sh
node eval/review/serve.cjs --file eval/output/review.html
```

使用原来的浏览器及配置文件打开 `http://127.0.0.1:8765/`。进度存在该浏览器的 localStorage，按审核包数据与模型版本哈希区分。保持原 bundle 和相同网址、端口；改用 `localhost`、其他端口、其他浏览器或文件模式，不会自动读取原站点的进度。移动 HTML 的磁盘路径不会改变同一 localhost 地址的存储。

需要更新页面代码时，仍用保存的原 bundle 重建：

```sh
node eval/review/build.cjs --input eval/data/review-bundle.json --out eval/output/review.html
```

不要为日常续标重新生成审核包或修改其中的预测、字幕和版本字段；新包会使用不同的进度命名空间。原包中的历史实验对照可以继续查看，不要求重新训练或安装模型工具。独立 HTML 也可直接打开，但建议用上述固定地址续标，并定期导出反馈备份。

## 核对与保存

1. 搜索标题、BV 或 UP 主，按分组或“预标注待确认”筛选。点击候选区间载入编辑，再用“去 B 站看起点 / 看终点附近”核对视频。
2. 编辑起止时间（分:秒，也支持直接输入秒数）。点击字幕设起点，Shift + 点击设终点；默认显示区间前后 15 秒，可切换全部字幕。
3. 分别选择内容性质（广告／非广告／不确定）及把握，再点击“确认跳过”“确认保留”或“留为待定”。广告内容也可以保留，例如简短赞助声明或视频主题中的商品介绍。只有点击确认的范围才是人工反馈，未查看部分始终未知。
4. 一个视频可以保存多个范围，支持编辑、删除和撤销。高置信度且边界明确的助手应跳建议可勾选后批量确认；勾选框不是保存状态，已保存范围会单独显示。
5. 本轮需要核对的范围处理好后，点击“本条核对完成”。它只记录进度，不要求覆盖全片；修改范围会取消完成，撤销会恢复先前状态，也可主动重新打开。

快捷键：J / K 切换视频，N 下一条未完成，Alt + Enter 确认跳过当前范围。接近整片的“确认保留”要求另行勾选已完整检查，不能把未检出视频一键标为全片正常。

点击“导出人工反馈”会请求下载 JSON，并显示可查看／复制的同一份文本。若未下载，复制保存为 `.json` 即可。它是点击时的快照，继续审核后应重新导出。

“导入人工反馈”会核验 BV、CID、时长和版本，并与已有范围合并；冲突的跳过／保留范围会使整次导入失败。确需导入另一版本时，显式勾选允许跨版本导入，身份和时长仍须匹配。助手预标注不能作为人工反馈导入。旧反馈兼容原有跳过决定，不会凭旧“正常”标签推断内容性质。

## 仅在新增审核批次时生成新包

`prepare.cjs` 把语料、离线回放结果和助手提案整理成新审核包。`--input` 与 `--out` 必填，输出已存在时拒绝覆盖；它不会更改原审核包或读取浏览器进度。

```sh
node eval/review/prepare.cjs --input /path/to/new-corpus.jsonl --results eval/output/segment-v1/per-video.jsonl --labels eval/labels/assistant-seed-v2.json --out eval/data/new-review-bundle.json
node eval/review/build.cjs --input eval/data/new-review-bundle.json --out eval/output/new-review.html
```

`--results` 默认 `eval/output/segment-v1/per-video.jsonl`，`--labels` 默认 `eval/labels/assistant-seed-v2.json`。结果必须对应要审核的语料；`before` 放入 `conservative` 对照，`current` 放入 `pipeline` 对照。页面展示包内保存的候选、实际来源和自动跳转信息，候选不等于自动跳过。助手建议保持助手身份，不能把结果文件中的人工范围转成助手预标注。

新包可通过“导入审核数据”打开，或生成独立页面。只有明确要审核新数据时才使用此流程；如需沿用已经确认的范围，先导出原反馈，再在新包中显式导入，而不是修改原包以套用旧进度。

## 反馈与自检

导出格式为 `schemaVersion: 1, kind: "human-review"`，带数据与模型哈希。每个区间保留 `origin: "human"`、起止、备注、内容性质及把握（`contentType/contentConfidence`）、跳过决定及把握（`skipDecision/skipConfidence`）。旧兼容字段 `label/confidence` 从跳过决定派生。`reviewedRanges` 只统计明确的跳过／保留范围，待定和空隙不计覆盖；`reviewComplete` 单独记录本条是否核对完成，不改变标签或未覆盖区域。

```sh
node --test eval/review/review.test.cjs
```

服务器只绑定 `127.0.0.1`，只读提供指定 HTML，没有写入接口或目录浏览。标题、字幕和备注按纯文本呈现；JSON 导入不执行其中的 HTML 或 JavaScript。

#!/usr/bin/env node
'use strict';
// Finalizes actual saved decisions only. Partial reviews stay partial; this does
// not infer labels, read community annotations, or evaluate any detection code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const base = __dirname, root = path.resolve(base, '../../..');
const rel = file => path.relative(root, file).split(path.sep).join('/');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => cp.execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const markdown = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const initialPath = path.join(base, 'initial-audit.json');
if (git('branch', '--show-current') !== 'test-branch') throw Error('Finalization is permitted only on test-branch.');
const initial = read(initialPath);
const inputPath = path.resolve(root, initial.source);
if (hash(fs.readFileSync(inputPath)) !== initial.sourceSha256) throw Error('Original input changed.');
const protectedRefs = {};
for (const name of ['master', 'fix/improve-detction-rate']) {
  const ref = `refs/heads/${name}`, current = git('rev-parse', ref);
  if (current !== initial.git.refs[ref]) throw Error(`Protected ref changed: ${name}`);
  protectedRefs[ref] = current;
}
const validation = cp.spawnSync(process.execPath, [path.join(base, 'validate.cjs')], {cwd: root, stdio: 'inherit'});
if (validation.status !== 0) throw Error('Validation failed; no new manifest or freeze has been written.');
const reportPath = path.join(base, 'validation-report.json');
const report = read(reportPath);
if (!report.valid || report.counts.expected !== 300 || report.counts.recordFiles !== 300 || report.counts.missingRecords !== 0) throw Error('Cannot finalize an invalid/incomplete record inventory. Pending content review is allowed, missing bookkeeping is not.');
const validatedHashes = new Map(report.files.map(entry => [entry.path, entry.sha256]));
const indexPath = path.join(base, 'source-index.json');
const index = read(indexPath), indexed = new Map(index.records.map(row => [row.bvid, row]));
const snapshots = new Map();
function snapshot(file, role) {
  const bytes = fs.readFileSync(file), sha256 = hash(bytes), key = rel(file);
  if (validatedHashes.has(key) && validatedHashes.get(key) !== sha256) throw Error(`File changed since validation: ${key}`);
  if (snapshots.has(key) && snapshots.get(key).sha256 !== sha256) throw Error(`Concurrent change detected: ${key}`);
  const entry = {path: key, sha256, bytes: bytes.length, role};
  snapshots.set(key, entry);
  return entry;
}
snapshot(inputPath, 'immutable-original-input');
snapshot(initialPath, 'initial-identity-and-ref-audit');
snapshot(reportPath, 'validation');
snapshot(indexPath, 'blind-source-index');
const rows = [];
const acquisitionReferences = new Map();
const visualReviewVideos = [];
for (const original of initial.records) {
  const recordPath = path.join(base, 'records', `${original.bvid}.json`);
  const top = read(recordPath), record = top.record, idx = indexed.get(original.bvid);
  const recordEntry = snapshot(recordPath, 'per-video-assistant-reference');
  const sourcePath = path.resolve(root, top.source.transcriptFile);
  const sourceEntry = snapshot(sourcePath, 'blind-subtitle-source');
  if (sourceEntry.sha256 !== top.source.transcriptSha256 || !idx || idx.transcriptSha256 !== sourceEntry.sha256) throw Error(`Source index/record hash disagreement: ${original.bvid}`);
  const source = read(sourcePath);
  if (source.bvid !== original.bvid || source.cid !== original.cid || record.cid !== original.cid) throw Error(`Identity mismatch: ${original.bvid}`);
  if (top.source.acquisitionFile) {
    const acqPath = path.resolve(root, top.source.acquisitionFile);
    if (!fs.existsSync(acqPath) || hash(fs.readFileSync(acqPath)) !== top.source.acquisitionSha256) throw Error(`Acquisition evidence missing or changed: ${original.bvid}`);
    acquisitionReferences.set(acqPath, top.source.acquisitionSha256);
  }
  // Reviewers retain their declared observation structure; normalize only the
  // manifest inventory, without inventing additional viewing or changing labels.
  const visualBlocks = [];
  const addVisual = (value, declaredVisual = false) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) addVisual(item, declaredVisual); return; }
    const hasEvidence = value.frameIndexes || value.frameManifests || value.frameManifest || value.framesManifest
      || value.mediaFile || value.media || value.identityEvidence
      || (value.file && (value.observation || value.time !== undefined))
      || (typeof value.modality === 'string' && /browser|visual|frames/.test(value.modality));
    if (declaredVisual || hasEvidence) visualBlocks.push(value);
    for (const key of ['visualObservations', 'visualReview', 'visualEvidence']) addVisual(value[key], true);
    if (declaredVisual) addVisual(value.observations, true);
  };
  for (const container of [top, record]) {
    for (const key of ['visualObservations', 'visualReview', 'visualEvidence']) addVisual(container[key], true);
    addVisual(container.secondaryReview);
  }
  for (const segment of record.segments || []) addVisual(segment.visualEvidence, true);
  if (visualBlocks.length) {
    const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.length))];
    const frameIndexes = unique(visualBlocks.flatMap(value => [
      ...(Array.isArray(value.frameIndexes) ? value.frameIndexes : []),
      ...(Array.isArray(value.frameManifests) ? value.frameManifests : []), value.frameManifest, value.framesManifest,
    ]));
    visualReviewVideos.push({
      bvid:original.bvid,
      observations:visualBlocks.filter(value => value.observation || value.time !== undefined).length || null,
      frameIndexCount:frameIndexes.length, frameIndexes,
      mediaFiles:unique(visualBlocks.map(value => value.mediaFile || value.media?.file)),
      mediaReferences:unique(visualBlocks.map(value => typeof value.media === 'string' ? value.media : value.identityEvidence)),
      declaredFramesActuallyViewed:visualBlocks.flatMap(value => Number.isFinite(value.framesActuallyViewed ?? value.framesViewed) ? [value.framesActuallyViewed ?? value.framesViewed] : []),
      methods:unique(visualBlocks.map(value => value.method)),
      modality:top.modality, reviewStatus:record.reviewStatus,
    });
  }
  const segs = record.segments || [];
  rows.push({
    inputLine: original.inputLine, inputLineSha256: original.inputLineSha256,
    bvid: original.bvid, cid: original.cid, duration: record.duration,
    reviewStatus: record.reviewStatus, reviewer: top.reviewer, modality: top.modality,
    fullTranscriptRead: record.fullTranscriptRead, readCoverage: record.readCoverage ?? top.readCoverage ?? null,
    adPresence: record.adPresence,
    advertisementSegmentCount: segs.filter(s => s.contentType === 'ad').length,
    skippableAdvertisementSegmentCount: segs.filter(s => s.contentType === 'ad' && s.skipDecision === 'skip').length,
    retainedCommercialSegmentCount: segs.filter(s => s.contentType === 'ad' && s.skipDecision === 'keep').length,
    unresolvedSegmentCount: segs.filter(s => s.contentType === 'uncertain' || s.skipDecision === 'uncertain').length,
    completedWithSkippableAdvertisement: record.reviewStatus === 'reviewed' && segs.some(s => s.contentType === 'ad' && s.skipDecision === 'skip'),
    completedWithoutSkippableAdvertisement: record.reviewStatus === 'reviewed' && !segs.some(s => s.contentType === 'ad' && s.skipDecision === 'skip'),
    subtitleRows: Array.isArray(source.subtitles) ? source.subtitles.length : 0,
    metadataStatus: source.acquisition?.metadata ?? null,
    subtitleStatus: source.acquisition?.subtitles ?? null,
    subtitleReason: source.acquisition?.subtitleReason ?? null,
    sourceUrl: top.source.sourceUrl ?? null,
    inputSha256: top.source.inputSha256,
    transcriptFile: sourceEntry.path, transcriptSha256: sourceEntry.sha256,
    recordFile: recordEntry.path, recordSha256: recordEntry.sha256,
    acquisitionFile: top.source.acquisitionFile ?? null, acquisitionSha256: top.source.acquisitionSha256 ?? null,
    pendingReasons: record.reviewStatus === 'reviewed' ? [] : (record.pendingReasons || []),
  });
}
const byStatus = rows.reduce((out, row) => {out[row.reviewStatus]=(out[row.reviewStatus] || 0)+1;return out;}, {});
const status = report.counts.completed === 300 && report.counts.pending === 0 ? 'complete' : 'partial';
const generatedAt = new Date().toISOString();
const availability = {
  initialWithSubtitles: initial.summary.subtitleAvailableCount,
  currentWithSubtitles: rows.filter(row => row.subtitleRows > 0).length,
  currentWithoutSubtitles: rows.filter(row => row.subtitleRows === 0).length,
  currentMetadataUnavailable: rows.filter(row => row.metadataStatus !== 'available').length,
  statusCounts: byStatus,
};
const manifest = {
  kind:'assistant-extra300-content-review-manifest', generatedAt, status,
  source:initial.source, sourceSha256:initial.sourceSha256, expectedVideoCount:300,
  labelProvenance:'Assistant content reference based on declared sources and modalities; not user-authored human labels and not blanket audiovisual verification.',
  scope:'Content review and advertisement/skip labeling only. No algorithm changes or accuracy evaluation.',
  completedCounts:report.counts, availability, visualReviewVideos,
  git:{branch:'test-branch',head:git('rev-parse','HEAD'),protectedRefs},
  blindReviewPolicy:'Content reviewers used sources/ and read complete available transcripts before judgment; no algorithm predictions, danmaku jump times, or community ad labels were consulted.',
  originalCorpusExcluded:{original351Count:initial.comparisonSources.original351Count,oldReviewCount:initial.comparisonSources.oldReviewCount,newInputOverlapCount:initial.summary.overlapsOriginal351.length},
  records:rows,
};
const pendingRows = rows.filter(row => row.reviewStatus !== 'reviewed');
const pendingText = [
  '# 待审核与待核实清单', '',
  `本次已完成 ${report.counts.completed}/300；仍待核实 ${report.counts.pending}。本清单中的视频均不计入完成或“没有应跳广告”。`, '',
  '| 输入行 | BV / CID | 状态 | 字幕条数 | 具体原因 |',
  '| --- | --- | --- | ---: | --- |',
  ...pendingRows.map(row => `| ${row.inputLine} | ${row.bvid} / ${row.cid} | ${row.reviewStatus} | ${row.subtitleRows} | ${markdown(row.pendingReasons.join('；'))} |`),
  ...(pendingRows.length ? [] : ['| — | — | 无待核实项 | — | 全部参考记录已完成所声明的内容审核。 |']),
  '', '来源缺失、接口异常、身份待核实与内容争议按逐视频原因保存；采集或校验成功不能替代实际阅读全文。', '',
].join('\n');
const visualNote = visualReviewVideos.length
  ? `有补充选定画面观察的记录：${visualReviewVideos.map(row=>`${row.bvid}（${row.observations === null ? `${row.frameIndexCount}份帧索引` : `${row.observations}条观察`}，${row.reviewStatus}）`).join('、')}。证据可以来自浏览器画面或已下载原片的选定解码帧，具体时间、观察者与限制见各记录的 visualObservations / secondaryReview。帧索引数量不是实际逐帧观看数量；选定画面观察不等于逐帧查看或完整视听。`
  : '本快照没有已登记的补充视听观察。';
const readme = [
  '# 新增 300 个视频的助手内容参考', '',
  `快照状态：**${status}**。已完成 **${report.counts.completed}/300**；完成项中有应跳广告 **${report.counts.withSkippableAd}**、没有应跳广告 **${report.counts.withoutSkippableAd}**；仍待核实 **${report.counts.pending}**。`, '',
  '这些数据是助手依据注明证据进行的内容参考，不是用户人工标签，也不是全视频视听核验结果。只做内容审核与广告范围标注，未修改检测算法、未评估算法准确率，未启动旧 HTML 服务。', '',
  `原始新增输入为 \`${initial.source}\`，SHA-256：\`${initial.sourceSha256}\`。初始300个视频全部无字幕；当前补采后有字幕${availability.currentWithSubtitles}个、仍无字幕${availability.currentWithoutSubtitles}个。有字幕仅代表可以开始阅读，只有真实阅读全文并解决关键判断的 reviewed 项计入完成。`, '',
  '初始输入具有300个唯一BV、300个唯一CID；格式、时长、重复和与原351/旧250记录重叠核验见 initial-audit.json。旧250份内容参考没有被覆盖或重复计数；原始输入保持不变。所有新增资料仅保存在 test-branch，脚本不提交、不推送。', '',
  '## 审核标准', '',
  '审核者只读取去除预测、弹幕和社区广告参考的 sources/，连续完整阅读字幕并保存 readCoverage。广告性质与跳过决定分别判断；题目主题中的产品体验、知识说明和必要商业内容可以 ad/keep。广告段包含确认属于推广的铺垫、商品介绍和收尾，没有按未来5秒评价容差缩短标签。字幕空白保持未知，正文区间只断言实际字幕覆盖内容。', '',
  '首次输入结构检查时，仅负责元数据审计的助手意外见到第1个视频的一小段弹幕；该助手没有参与该视频的内容标注。实际内容审核者使用隔离后的盲审来源，此事未用于广告判断。', '',
  visualNote, '',
  'acquisition/media/ 中若保存公开原片、提取帧或媒体检查摘要，原片仅用于本地内容审核，不作为对外发布素材。实际证据帧和已完成媒体的文件哈希纳入 freeze；临时 .part 文件及仍在下载的摘要不冻结。提帧只代表查看注明的画面，不能据此声称听过音频或逐帧核验。', '',
  '自动字幕可能存在错识、翻译或缺口；具体未决边界、资料缺失和应跳争议保存到逐视频 limitations / pendingReasons 与 pending.md。无字幕不等于无广告，needs-source、needs-review、needs-verification均不计入完成。', '',
  '## 文件', '',
  '- records/：每视频判断、摘要、完整阅读覆盖、广告与跳过决定、字幕原文证据和边界不确定性。',
  '- sources/：用于盲审的视频身份、标题、简介、字幕及必要采集信息，按记录中的哈希固定。',
  '- acquisition/：采集检查点和不含登录凭据的必要诊断资料；仅用于证据来源，不供内容审核反向照抄标签。',
  '- initial-audit.json：原输入整文件与逐行原始字节哈希、身份/重复/重叠检查，以及初始分支和旧记录哈希。',
  '- manifest.json、freeze.json：全部300个视频的状态、计数、来源和文件哈希；partial明确表示审核尚未全部完成。',
  '- validation-report.json、pending.md：结构/时间/证据校验结果及逐项未完原因。', '',
  '- normal-range-corrections.json：正文区间与实际字幕覆盖求交的规范修正日志，保存修改前后范围与哈希；广告判断和复核状态不因该修正改变。',
  '- reviewed-gap-audit.json：已完成记录中较长字幕空白且没有登记视觉补充的提示清单；这是资料完整性提醒，不是广告判定。', '',
  '## 复核与复现', '',
  '在 test-branch 的项目根目录运行：', '',
  '```sh',
  'node eval/labels/assistant-content-extra300/validate.cjs',
  '```', '',
  '该命令只做身份、哈希、结构、证据原文、时间范围、重复/冲突和计数检查，不执行算法，也不证明人工式内容理解已完成。freeze.json固定的原始输入可用项目既有还原工具恢复；已保存的补采字幕和盲审文本可离线复核，不依赖重新登录或临时字幕链接。未保存原始媒体的选定画面观察仅有观察记录，重新进行视听核验仍需取得对应视频资料。', '',
  '停稳补采和标注写入后，运行 finalize.cjs 重新生成本清单与哈希快照；后续文件变化会使旧freeze失效，应明确重新版本化。QR图片、临时日志和任何登录凭据不纳入freeze，也不应提交到Git。', '',
].join('\n');
const generatedFiles = [
  [path.join(base,'manifest.json'),jsonBytes(manifest)],
  [path.join(base,'pending.md'),Buffer.from(pendingText)],
  [path.join(base,'README.md'),Buffer.from(readme)],
];
// Only hashes and filenames are exposed below. Never print raw acquisition data.
const excluded = [];
const sensitiveName = /(?:^|[\/._-])(?:qr|qrcode|login|cookie|cookies|credential|credentials|session-state|auth-state)(?:[\/._-]|$)/i;
const sensitiveKeys = /"(?:SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|refresh_token|access_token|qrcode_key|cookie|cookies|authorization|cookieHeader)"\s*:/i;
const signedCredentialQuery = /[?&](?:auth_key|access_token|refresh_token|qrcode_key|sessdata)=/i;
const temporaryDownload = /\.(?:part|tmp|temp|download|ytdl)(?:$|\.)/i;
const mediaExtension = /\.(?:mp4|webm|mkv|mov|m4a|mp3|wav|png|jpe?g|webp|gif)$/i;
function hasOngoingMediaStatus(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.status === 'string' && /^(?:running|downloading|in[-_ ]?progress|pending|queued|active)$/i.test(value.status)) return true;
  return Object.values(value).some(child => child && typeof child === 'object' && hasOngoingMediaStatus(child));
}
function collect(directory) {
  const out=[];
  for(const name of fs.readdirSync(directory)) {
    const file=path.join(directory,name), stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()) {excluded.push({path:rel(file),reason:'symbolic link excluded'});continue;}
    if(stat.isDirectory())out.push(...collect(file));else out.push(file);
  }
  return out;
}
const generatedNames=new Set(['manifest.json','freeze.json','README.md','pending.md']);
for(const file of collect(base)) {
  const relative=path.relative(base,file), filename=path.basename(file);
  const isMedia=relative.startsWith(path.join('acquisition','media')+path.sep);
  if(generatedNames.has(relative)||snapshots.has(rel(file)))continue;
  if(temporaryDownload.test(filename)) {excluded.push({path:rel(file),reason:'incomplete temporary download excluded'});continue;}
  if(sensitiveName.test(relative)||!(/\.(json|jsonl|cjs|mjs|py|md)$/i.test(filename)||filename==='.gitignore'||(isMedia&&mediaExtension.test(filename)))) {excluded.push({path:rel(file),reason:'login, temporary, or non-evidence file excluded'});continue;}
  const bytes=fs.readFileSync(file);
  if(isMedia && /\.json$/i.test(filename) && hasOngoingMediaStatus(JSON.parse(bytes.toString('utf8')))) throw Error(`Media summary is still in progress: ${rel(file)}. Wait for completed acquisition before freezing.`);
  // Source code is public workflow, not captured credentials; inspect data only.
  if(/\.(json|jsonl)$/i.test(filename)&&(sensitiveKeys.test(bytes.toString('utf8'))||signedCredentialQuery.test(bytes.toString('utf8')))) {excluded.push({path:rel(file),reason:'potential temporary credential field; excluded without displaying content'});continue;}
  snapshot(file,isMedia?'local-media-evidence':relative.startsWith('acquisition'+path.sep)?'acquisition-evidence':'audit-workflow');
}
for(const [file] of acquisitionReferences) {
  if(!snapshots.has(rel(file)))throw Error(`Referenced acquisition file was excluded from freeze: ${rel(file)}. Save a credential-free provenance copy and update the record before finalizing.`);
}
// Guard against freezing a mixture of records changed during this run.
for(const entry of snapshots.values())if(hash(fs.readFileSync(path.join(root,entry.path)))!==entry.sha256)throw Error(`File changed during finalization: ${entry.path}. Retry after writers finish.`);
for(const [file,bytes]of generatedFiles){fs.writeFileSync(file,bytes);snapshot(file,'generated-review-index');}
const freeze={
  kind:'assistant-extra300-content-reference-freeze',frozenAt:generatedAt,status,
  scope:'Evidence integrity snapshot; assistant reference labels, not user human labels or algorithm evaluation.',
  counts:report.counts,source:initial.source,sourceSha256:initial.sourceSha256,
  manifestSha256:snapshots.get(rel(path.join(base,'manifest.json'))).sha256,
  git:{branch:'test-branch',head:git('rev-parse','HEAD'),protectedRefs},
  files:[...snapshots.values()].sort((a,b)=>a.path.localeCompare(b.path)),
  localMediaFiles:[...snapshots.values()].filter(entry=>entry.role==='local-media-evidence').sort((a,b)=>a.path.localeCompare(b.path)),
  excludedFiles:excluded.sort((a,b)=>a.path.localeCompare(b.path)),
  notes:['QR/login images, temporary logs, and detected credential fields are excluded. No Git staging, commit, or push is performed.','Pending records remain unknown and are excluded from reviewed no-skippable-ad counts.','Do not change these references to fit algorithm predictions; any later correction must be traceable and refrozen.'],
};
fs.writeFileSync(path.join(base,'freeze.json'),jsonBytes(freeze));
console.log(JSON.stringify({status,counts:report.counts,availability,manifest:rel(path.join(base,'manifest.json')),freeze:rel(path.join(base,'freeze.json')),frozenFileCount:freeze.files.length,excludedFileCount:excluded.length},null,2));

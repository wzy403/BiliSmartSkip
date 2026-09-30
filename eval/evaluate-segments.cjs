#!/usr/bin/env node
'use strict';
// Production replay only. Human/challenge labels never enter the detector input.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { readDataset, validateRecord, sourceAvailability } = require('./dataset.cjs');
const { loadProduction, runVideo } = require('./runner.cjs');
const { creatorKey } = require('./metrics.cjs');
const { stats } = require('./stats.cjs');
const { validateLabels, splitOf } = require('./labels/validate.cjs');
const { normalizeSegment } = require('./labels/semantics.js');
const { coverage, aggregateCoverage } = require('./coverage.cjs');
const key = record => `${record.bvid}:${record.cid}`;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const sameRange = (a, b) => Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function detectorInput(record) {
  // Intentionally omit human annotations, community references and evaluation labels.
  return structuredClone({ bvid: record.bvid, cid: record.cid, title: record.title || '', duration: record.duration,
    desc: record.desc || '', chapters: record.chapters || [], subtitles: record.subtitles || [], danmaku: record.danmaku || [] });
}
function normalizeReplay(record, result) {
  const failed = (result.diagnostics || []).find(diagnostic => /complete[- ]segment detection failed/i.test(JSON.stringify(diagnostic)));
  if (failed) throw new Error(`Complete-segment detector fell back after failure: ${JSON.stringify(failed).slice(0, 1500)}`);
  const candidates = result.candidates ?? (result.candidate ? [result.candidate] : []);
  const automaticSegments = result.automaticSegments ?? (result.auto ? [result.auto] : []);
  const seekDestinations = result.seekDestinations;
  if (!Array.isArray(candidates) || !Array.isArray(automaticSegments) || !Array.isArray(seekDestinations)) throw new Error('Runner must return candidate/automatic arrays and actual seekDestinations');
  for (const segment of [...candidates, ...automaticSegments]) {
    if (!finite(segment.start) || !finite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end > record.duration) throw new Error('Invalid production interval');
  }
  if (seekDestinations.some(value => !finite(value))) throw new Error('Invalid seek destination');
  if (seekDestinations.length !== automaticSegments.length) throw new Error('Actual seek count does not match automaticSegments (including repeated seeks)');
  const unused = [...seekDestinations], seenAutomatic = new Set();
  for (const segment of automaticSegments) {
    const identity = `${segment.start}:${segment.end}`;
    if (seenAutomatic.has(identity)) throw new Error('Repeated automatic interval was executed more than once');
    seenAutomatic.add(identity);
    if (!candidates.some(candidate => sameRange(candidate, segment))) throw new Error('Automatic interval is not a detected candidate');
    // The production player seeks to end + 0.05s. Tolerance also permits a
    // future exact-end seek without treating unrelated destinations as evidence.
    const index = unused.findIndex(destination => destination >= segment.end - 0.001 && destination <= segment.end + 0.1);
    if (index < 0) throw new Error('Automatic interval lacks a matching actual seek');
    unused.splice(index, 1);
  }
  return { candidates, automaticSegments, seekDestinations,
    detectionMs: finite(result.detectionMs) && result.detectionMs >= 0 ? result.detectionMs : null };
}
function bestSinglePrediction(truth, candidates) {
  let best = null, covered = 0;
  for (const candidate of candidates) {
    const seconds = overlap(truth, candidate);
    if (seconds > covered) { best = candidate; covered = seconds; }
  }
  const fraction = covered / (truth.end - truth.start);
  return { coveredSeconds: covered, coverage: fraction, complete90: fraction >= 0.9,
    prediction: best, startErrorSeconds: best ? best.start - truth.start : null,
    endErrorSeconds: best ? best.end - truth.end : null };
}
function wholeSegments(labels, before, current) {
  const truths = labels.map(normalizeSegment).filter(segment => segment.skipDecision === 'skip'
    && segment.skipConfidence === 'high' && segment.boundaryConfidence === 'high');
  return truths.map(truth => ({ truth, before: { candidates: bestSinglePrediction(truth, before.candidates),
    automatic: bestSinglePrediction(truth, before.automaticSegments) }, current: {
    candidates: bestSinglePrediction(truth, current.candidates), automatic: bestSinglePrediction(truth, current.automaticSegments) } }));
}
function decisionSignature(replay) {
  return { candidates: replay.candidates.map(segment => [segment.start, segment.end, segment.requiresConfirmation !== false, segment.source || null]),
    automatic: replay.automaticSegments.map(segment => [segment.start, segment.end]), seeks: replay.seekDestinations };
}
function summarizeHuman(rows) {
  const result = {};
  for (const variant of ['before', 'current']) {
    result[variant] = {};
    for (const kind of ['candidates', 'automatic']) {
      const available = rows.filter(row => row[variant]?.metrics?.[kind]);
      const parts = available.flatMap(row => row.wholeSegments);
      result[variant][kind] = { videos: available.length,
        metrics: available.length ? aggregateCoverage(available.map(row => row[variant].metrics[kind])) : null,
        strictWholeSegments: { total: parts.length, complete90: parts.filter(part => part[variant][kind].complete90).length,
          policy: 'Each original human should-skip interval must be >=90% covered by one original predicted interval; adjacent fragments are not merged.' } };
    }
  }
  return result;
}

async function evaluateRecords(records, feedback, productions, { scope = 'development', warmup = 5, runner = runVideo, challenge = null } = {}) {
  if (!['development', 'human', 'all'].includes(scope)) throw new Error('scope must be development, human or all');
  if (!Number.isInteger(warmup) || warmup < 0) throw new Error('warmup must be a nonnegative video count');
  validateLabels(feedback);
  if (feedback.kind !== 'human-review') throw new Error('Only human-review labels may score production accuracy');
  const labels = new Map(feedback.records.map(record => [key(record), record]));
  const corpus = new Map(records.map(record => [key(record), record]));
  for (const label of feedback.records) if (!corpus.has(key(label)) || corpus.get(key(label)).duration !== label.duration) throw new Error(`Human feedback identity/duration mismatch: ${key(label)}`);
  const heldoutCreators = new Set(records.filter(record => splitOf(record, labels.get(key(record))) === 'holdout').map(creatorKey));
  const challengeHasLabels = challenge?.kind === 'assistant-provisional';
  if (challengeHasLabels) {
    validateLabels(challenge);
    const humanCreators = new Set(feedback.records.map(record => creatorKey(corpus.get(key(record)))));
    for (const item of challenge.records) {
      const record = corpus.get(key(item));
      if (!record || (item.duration != null && item.duration !== record.duration)) throw new Error(`Challenge identity/duration mismatch: ${key(item)}`);
      if (humanCreators.has(creatorKey(record))) throw new Error(`Challenge must be separate from human review authors: ${key(item)}`);
      coverage(item.segments, [], record.duration);
    }
  } else if (challenge && challenge.kind !== 'reserved-development-challenge-candidates') throw new Error('Challenge must be an unlabelled reserved pool or assistant-provisional, never human gold');
  const eligible = [], excluded = [], errors = [], rows = [];
  for (const record of records) {
    if (scope === 'human' && !labels.has(key(record))) { excluded.push({ bvid: record.bvid, cid: record.cid, reason: 'outside-human-scope' }); continue; }
    if (scope === 'development' && heldoutCreators.has(creatorKey(record))) { excluded.push({ bvid: record.bvid, cid: record.cid, reason: 'holdout-author-not-replayed' }); continue; }
    try {
      validateRecord(record);
      if (!sourceAvailability(record).replayEligible) throw new Error('metadata/danmaku acquisition incomplete');
      eligible.push(record);
    } catch (error) { excluded.push({ bvid: record.bvid, cid: record.cid, reason: error.message }); }
  }
  const timing = Object.fromEntries(['before', 'current'].map(name => [name, { detection: [], replay: [] }]));
  for (const record of eligible.slice(0, warmup)) for (const [variant, production] of Object.entries(productions)) {
    try { normalizeReplay(record, await runner(detectorInput(record), production)); }
    catch (error) { errors.push({ phase: 'warmup', variant, bvid: record.bvid, cid: record.cid, message: error.message }); }
  }
  for (let index = 0; index < eligible.length; index++) {
    const record = eligible[index], human = labels.get(key(record));
    const row = { bvid: record.bvid, cid: record.cid, title: record.title, creator: creatorKey(record), duration: record.duration,
      cohort: heldoutCreators.has(creatorKey(record)) ? 'heldout' : 'development',
      sources: sourceAvailability(record), inputScale: { subtitles: record.subtitles?.length || 0, danmaku: record.danmaku?.length || 0 },
      humanSegments: human ? human.segments.map(segment => ({ ...normalizeSegment(segment), contentAnnotationExplicit: Object.hasOwn(segment, 'contentType') })) : null };
    let activeVariant = null;
    try {
      // Alternate execution order to avoid always giving one arm the warmer CPU.
      for (const name of index % 2 ? ['current', 'before'] : ['before', 'current']) {
        activeVariant = name;
        const input = detectorInput(record), start = performance.now();
        const replay = await runner(input, productions[name]), replayMs = performance.now() - start;
        row[name] = { ...normalizeReplay(record, replay), replayMs };
        timing[name].replay.push(replayMs);
        if (row[name].detectionMs != null) timing[name].detection.push(row[name].detectionMs);
        if (human) row[name].metrics = { candidates: coverage(human.segments, row[name].candidates, record.duration),
          automatic: coverage(human.segments, row[name].automaticSegments, record.duration) };
      }
      row.changed = JSON.stringify(decisionSignature(row.before)) !== JSON.stringify(decisionSignature(row.current));
      row.wholeSegments = human ? wholeSegments(human.segments, row.before, row.current) : [];
      rows.push(row);
    } catch (error) { errors.push({ phase: 'measured', variant: activeVariant, bvid: record.bvid, cid: record.cid, message: error.message }); }
  }
  const humanRows = rows.filter(row => row.humanSegments), development = humanRows.filter(row => row.cohort === 'development'), heldout = humanRows.filter(row => row.cohort === 'heldout');
  const challengeRows = (challenge?.videos || challenge?.records || []).map(item => {
    const row = rows.find(row => key(row) === key(item));
    const referenceSegments = challengeHasLabels ? item.segments.map(normalizeSegment) : null;
    const variant = name => row ? { candidates: row[name].candidates, automaticSegments: row[name].automaticSegments,
      ...(referenceSegments ? { metrics: { candidates: coverage(referenceSegments, row[name].candidates, row.duration),
        automatic: coverage(referenceSegments, row[name].automaticSegments, row.duration) } } : {}) } : null;
    return { bvid: item.bvid, cid: item.cid, title: item.title || corpus.get(key(item))?.title, selectionReason: item.selectionReason || null,
      status: row ? challengeHasLabels ? 'assistant-reference-replay' : 'unlabelled-replay-only' : 'not-replayed', changed: row?.changed ?? null,
      referenceKind: challengeHasLabels ? 'assistant-provisional' : 'unlabelled', referenceSegments,
      before: variant('before'), current: variant('current'),
      wholeSegments: row && referenceSegments ? wholeSegments(referenceSegments, row.before, row.current) : [],
      exclusion: row ? null : excluded.find(excluded => key(excluded) === key(item))?.reason || 'missing-or-failed',
      accuracy: null };
  });
  return { rows, excluded, errors, challengeRows, summary: { scope, inputVideos: records.length, replayedVideos: rows.length,
    changedVideos: rows.filter(row => row.changed).length, heldoutCreators: [...heldoutCreators].sort(),
    human: { inputVideos: feedback.records.length, replayedVideos: humanRows.length, development: { videos: development.length, ...summarizeHuman(development) },
      heldout: { videos: heldout.length, ...summarizeHuman(heldout) } },
    execution: Object.fromEntries(['before', 'current'].map(name => [name, { candidateCount: rows.reduce((sum, row) => sum + row[name].candidates.length, 0),
      automaticIntervalCount: rows.reduce((sum, row) => sum + row[name].automaticSegments.length, 0),
      actualSeekCount: rows.reduce((sum, row) => sum + row[name].seekDestinations.length, 0),
      multiCandidateVideos: rows.filter(row => row[name].candidates.length > 1).length,
      multiAutomaticVideos: rows.filter(row => row[name].automaticSegments.length > 1).length,
      timing: { detection: stats(timing[name].detection), completeReplay: stats(timing[name].replay) } }])),
    warmupVideosPerVariant: Math.min(warmup, eligible.length), challenge: { videos: challengeRows.length,
      replayedVideos: challengeRows.filter(row => row.status !== 'not-replayed').length,
      changedVideos: challengeRows.filter(row => row.changed).length, accuracy: null,
      referenceKind: challengeHasLabels ? 'assistant-provisional' : 'unlabelled',
      referenceAgreement: challengeHasLabels ? summarizeHuman(challengeRows.filter(row => row.before && row.referenceSegments)) : null,
      note: challengeHasLabels ? 'Separate agreement with frozen assistant-provisional references, not human accuracy; never combined with human metrics'
        : 'Unlabelled challenge pool, no gold labels and no accuracy scoring' } } };
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const num = value => finite(value) ? value.toFixed(2) : '—';
const pct = value => finite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const clock = value => { const ms = Math.round(value * 1000), digits = ms % 10 ? 3 : 2; return `${Math.floor(ms / 60000)}:${(ms % 60000 / 1000).toFixed(digits).padStart(digits + 3, '0')}`; };
function interval(bvid, value) {
  const label = `${clock(value.start)}–${clock(value.end)}`;
  return /^BV[0-9A-Za-z]{10}$/.test(bvid) ? `<a target="_blank" rel="noopener noreferrer" href="https://www.bilibili.com/video/${bvid}/?t=${Math.max(0, Math.floor(value.start))}">${label}</a>` : esc(label);
}
const ranges = (bvid, values) => values?.length ? values.map(value => `<span class="range">${interval(bvid, value)}<small>${esc(value.source || '')}</small></span>`).join('') : '<span class="muted">无区间</span>';
function summaryTable(value, provisional = false) {
  return `<div class="scroll"><table><thead><tr><th>生产方案</th><th>${provisional ? '参考精确率' : '跳过精确率'}</th><th>${provisional ? '参考应跳覆盖' : '应跳时长召回'}</th><th>F1</th><th>${provisional ? '助手参考时间一致率' : '已标时间正确率'}</th><th>${provisional ? '相对参考 keep 超圈秒' : '误圈应保留秒'}</th><th>${provisional ? '相对参考 skip 漏圈秒' : '漏掉应跳秒'}</th><th>未知预测秒</th><th>单段完整 ≥90%</th></tr></thead><tbody>${['automatic', 'candidates'].flatMap(kind => ['before', 'current'].map(name => {
    const result = value[name][kind], m = result.metrics?.skipMetrics;
    return `<tr><th>${name === 'before' ? '冻结旧版' : '当前工作区'} · ${kind === 'automatic' ? '实际自动跳转' : '全部候选'}</th><td>${pct(m?.precision)}</td><td>${pct(m?.recall)}</td><td>${pct(m?.f1)}</td><td>${pct(m?.accuracy)}</td><td>${num(m?.falsePositiveSeconds)}</td><td>${num(m?.falseNegativeSeconds)}</td><td>${num(m?.unknownPredictionSeconds)}</td><td>${result.strictWholeSegments.complete90} / ${result.strictWholeSegments.total}</td></tr>`;
  })).join('')}</tbody></table></div>`;
}
function partCell(bvid, part) {
  return `${part.prediction ? interval(bvid, part.prediction) : '未覆盖'}<small>${pct(part.coverage)} ${part.complete90 ? '✓ 单段完整' : '未达 90%'} · 起点偏差 ${num(part.startErrorSeconds)}s / 终点 ${num(part.endErrorSeconds)}s</small>`;
}
function humanVideo(row) {
  const moreKeep = row.current.metrics.candidates.coveredNormalSeconds > row.before.metrics.candidates.coveredNormalSeconds + 1e-6;
  const improved = row.wholeSegments.some(part => part.current.candidates.complete90 && !part.before.candidates.complete90);
  const incomplete = row.wholeSegments.some(part => !part.current.candidates.complete90);
  return `<details class="video" data-flags="${[row.changed && 'changed', moreKeep && 'more-keep', improved && 'improved', incomplete && 'incomplete', row.current.candidates.length > 1 && 'multiple'].filter(Boolean).join(',')}" data-search="${esc(`${row.bvid} ${row.title}`.toLowerCase())}"><summary>${esc(row.title || row.bvid)}<small>${esc(row.bvid)} · ${row.changed ? '候选或执行已改变' : '未改变'} · ${row.current.candidates.length} 个当前候选 / ${row.current.seekDestinations.length} 次实际跳转</small></summary><div class="detail">
    <h3>人工范围：内容性质与跳过决定分开</h3><p>${row.humanSegments.map(segment => `<span class="range">${interval(row.bvid, segment)} · ${esc({ ad: '广告内容', non_ad: '非广告内容', uncertain: '内容未知' }[segment.contentType])} / <strong>${esc({ skip: '应跳过', keep: '应保留', uncertain: '跳过待确认' }[segment.skipDecision])}</strong><small>${esc(segment.reason || '')}</small></span>`).join('')}</p>
    <h3>生产候选与实际执行</h3><div class="scroll"><table><thead><tr><th>版本</th><th>所有候选</th><th>实际自动区间</th><th>实际跳转位置</th></tr></thead><tbody>${['before', 'current'].map(name => `<tr><th>${name === 'before' ? '冻结旧版' : '当前工作区'}</th><td>${ranges(row.bvid, row[name].candidates)}</td><td>${ranges(row.bvid, row[name].automaticSegments)}</td><td>${esc(row[name].seekDestinations.map(clock).join('、') || '无')}</td></tr>`).join('')}</tbody></table></div>
    <h3>每个完整应跳段的前后对照</h3>${row.wholeSegments.length ? `<div class="scroll"><table><thead><tr><th>人工完整应跳段</th><th>旧版最佳单候选</th><th>当前最佳单候选</th><th>旧版实际自动</th><th>当前实际自动</th></tr></thead><tbody>${row.wholeSegments.map(part => `<tr><th>${interval(row.bvid, part.truth)}</th><td>${partCell(row.bvid, part.before.candidates)}</td><td>${partCell(row.bvid, part.current.candidates)}</td><td>${partCell(row.bvid, part.before.automatic)}</td><td>${partCell(row.bvid, part.current.automatic)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">此视频没有边界明确的应跳段，保留范围仍用于误跳评分。</p>'}</div></details>`;
}
function renderHtml(report, rows, challengeRows) {
  const human = rows.filter(row => row.humanSegments);
  const bytes = name => report.production[name].codeSize;
  const automatic = report.human.development;
  const beforeAuto = automatic.before.automatic.metrics.skipMetrics;
  const currentAuto = automatic.current.automatic.metrics.skipMetrics;
  const highlights = [
    ['应跳广告自动覆盖', pct(beforeAuto.recall), pct(currentAuto.recall)],
    ['自动覆盖至少 90% 的完整段', `${automatic.before.automatic.strictWholeSegments.complete90} / ${automatic.before.automatic.strictWholeSegments.total}`, `${automatic.current.automatic.strictWholeSegments.complete90} / ${automatic.current.automatic.strictWholeSegments.total}`],
    ['误跳已标应保留内容', `${num(beforeAuto.falsePositiveSeconds)} 秒`, `${num(currentAuto.falsePositiveSeconds)} 秒`],
    ['漏跳已标应跳内容', `${num(beforeAuto.falseNegativeSeconds)} 秒`, `${num(currentAuto.falseNegativeSeconds)} 秒`]
  ];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>BiliSmartSkip · 完整区间生产回放</title><style>
  body{margin:0;background:#f2f5f8;color:#22354a;font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}header{background:#17354e;color:white;padding:25px max(20px,calc((100vw - 1240px)/2))}main{max-width:1240px;margin:auto;padding:20px}h1{margin:0;font-size:25px}h2{font-size:19px}h3{font-size:15px}.card,.video{background:white;border:1px solid #d8e1ec;border-radius:9px;padding:18px;margin:15px 0}.notice{background:#fff2d7;padding:12px 16px;border-left:3px solid #dfb15a}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:10px;border-bottom:1px solid #e1e8f0;text-align:left;vertical-align:top}thead{background:#f0f5fa}th{white-space:nowrap}small,.muted{color:#667e93;font-size:11px}small{display:block}.range{display:inline-block;margin:5px 12px 5px 0}a{color:#1e66aa;text-decoration:none}.video{padding:0}.video summary{padding:16px;cursor:pointer;font-weight:600}.detail{padding:0 16px 16px}.filters{display:flex;gap:10px;flex-wrap:wrap}select,input{padding:8px;border:1px solid #c3d2df;border-radius:5px;font:inherit}code{overflow-wrap:anywhere;font-size:11px}.hash{font-family:monospace;word-break:break-all}details>summary{cursor:pointer}[hidden]{display:none!important}</style></head><body><header><h1>完整区间：冻结旧版与当前工作区</h1><p>插件真实代码本地回放与播放器跳转验证 · 只读结果 · 候选不等于自动跳过</p></header><main>
    <p class="notice">当前范围：${esc(report.scope)}。${report.replayedVideos} 个视频完成回放；人工开发评分 ${report.human.development.videos} 个视频、${report.human.development.before.candidates.strictWholeSegments.total} 个完整应跳段。只评分明确 skip / keep 秒数，未知时间独立列出。这批人工样本经过主动选取，不是平台总体准确率。</p>
    <section class="card"><h2>人工明确范围上的前后效果</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0">${highlights.map(([label,before,after]) => `<div style="padding:12px;background:#f0f5fa;border-radius:6px"><div>${label}</div><strong style="font-size:22px;color:#13536c">${after}</strong><small>修改前 ${before}</small></div>`).join('')}</div>${summaryTable(report.human.development)}<p class="muted">精确率、召回率、F1、已标时间正确率均按已知秒数计算。未知预测不算正确或错误。完整度要求一个原始候选覆盖至少 90%，不会把相邻碎片合并成“完整”。内容为广告也可以应保留。</p></section>
    ${report.human.heldout.videos ? `<section class="card"><h2>冻结后保留集 · 单独报告</h2>${summaryTable(report.human.heldout)}<p class="muted">保留集结果不得用于本轮调参。</p></section>` : ''}
    <section class="card"><h2>执行、大小与本机检测时延</h2><div class="scroll"><table><thead><tr><th>版本</th><th>候选 / 实际跳转</th><th>多候选 / 多次自动的视频</th><th>被测脚本 / gzip 字节</th><th>检测 p50 / p95 / 最大 ms</th><th>含 VM 重放 p50 / p95 ms</th></tr></thead><tbody>${['before', 'current'].map(name => { const e = report.execution[name], t = e.timing; return `<tr><th>${name === 'before' ? '冻结旧版' : '当前工作区'}</th><td>${e.candidateCount} / ${e.actualSeekCount}</td><td>${e.multiCandidateVideos} / ${e.multiAutomaticVideos}</td><td>${esc(bytes(name).totalBytes)} / ${esc(bytes(name).gzipBytes)}</td><td>${num(t.detection.p50Ms)} / ${num(t.detection.p95Ms)} / ${num(t.detection.maxMs)}<small>${t.detection.samples} 个有效样本</small></td><td>${num(t.completeReplay.p50Ms)} / ${num(t.completeReplay.p95Ms)}</td></tr>`; }).join('')}</tbody></table></div><p class="muted">各版本预热 ${report.warmupVideosPerVariant} 个视频。检测时间由 getSkipSegments / getSkipSegment 与 attachSkipper 的本地 fixture 调用测量，不含 VM 创建与真实网络；完整重放含 VM / 浏览器替身等开销，不能当纯检测 CPU。实际 seek 数与 automaticSegments 逐一核验。源码哈希与体积只包括 runner 加载的检测/播放脚本，不含 API、popup、manifest 和素材。机器负载和 JIT 会影响时延。</p></section>
    <h2>逐个应跳段检查</h2><div class="filters"><select id="filter"><option value="all">所有人工回放视频</option><option value="changed">候选或执行改变</option><option value="improved">新增单段完整覆盖</option><option value="incomplete">仍有未完整应跳段</option><option value="more-keep">新增应保留内容误圈</option><option value="multiple">当前有多个候选</option></select><input id="search" placeholder="标题 / BV 搜索"><span id="count" class="muted"></span></div>${human.map(humanVideo).join('')}
    <section class="card"><h2>冻结挑战池 · ${report.challenge.referenceKind === 'assistant-provisional' ? '助手暂定参考单独评分' : '未标注诊断'}</h2><p class="notice">${challengeRows.length} 个挑战视频无人工真值，不计人工准确率，也不与上方人工指标合并。${report.challenge.referenceKind === 'assistant-provisional' ? '下表仅表示与冻结助手暂定参考的一致性；未知或不确定范围仍不当负例。' : '没有标签时只展示候选变化。'}此前全语料曾自动回放，不能称原始数据从未被触达；本轮不根据保留集调参。</p>${report.challenge.referenceAgreement ? summaryTable(report.challenge.referenceAgreement, true) : ''}${challengeRows.map(row => `<details><summary>${esc(row.bvid)} · ${esc(row.title || '')} · ${row.status === 'not-replayed' ? '本范围未回放' : row.changed ? '候选改变' : '未改变'}</summary><p>${esc(row.selectionReason || '')}</p>${row.referenceSegments ? `<p>助手暂定参考：${row.referenceSegments.map(segment => `<span class="range">${interval(row.bvid, segment)} ${esc(segment.skipDecision)} / ${esc(segment.skipConfidence)}<small>${esc(segment.reason || '')}</small></span>`).join('')}</p>` : ''}${row.before ? `<p>旧候选：${ranges(row.bvid, row.before.candidates)}</p><p>当前候选：${ranges(row.bvid, row.current.candidates)}</p>` : `<p>${esc(row.exclusion)}</p>`}</details>`).join('')}</section>
    <section class="card"><details><summary>数据、代码与文件大小追溯</summary><p>范围外 / 数据不完整 ${report.excluded.length} 条；失败 ${report.errors.length} 条。未回放条目不代表未检出。</p><table><tbody>${Object.entries(report.inputs).map(([name, value]) => `<tr><th>${esc(name)}</th><td class="hash">${esc(value.sha256 || '')}<small>${esc(value.file || '')}</small></td></tr>`).join('')}${['before', 'current'].map(name => `<tr><th>${name} 生产源码</th><td class="hash">${esc(report.production[name].sourceSha256)}<small>${esc(report.production[name].sourceDir || '当前工作区')}</small>${bytes(name).files.map(file => `<small>${esc(file.filename)}: ${esc(file.bytes)} bytes</small>`).join('')}</td></tr>`).join('')}<tr><th>评估代码</th><td class="hash">${esc(report.evaluationCodeSha256)}</td></tr></tbody></table><p class="muted">${esc(report.environment.node)} · ${esc(report.environment.platform)} ${esc(report.environment.arch)} · ${esc(report.environment.cpu)}。${esc(report.generatedAt)}</p></details></section>
  </main><script>(function(){var videos=Array.from(document.querySelectorAll('.video'));function update(){var f=document.getElementById('filter').value,q=document.getElementById('search').value.toLowerCase().trim(),n=0;videos.forEach(function(v){var ok=(f==='all'||v.dataset.flags.split(',').includes(f))&&(!q||v.dataset.search.includes(q));v.hidden=!ok;if(ok)n++;});document.getElementById('count').textContent=n+' / '+videos.length+' 个视频';}['filter','search'].forEach(function(id){document.getElementById(id).addEventListener('input',update);});update();})();</script></body></html>`;
}
async function run(options) {
  const records = readDataset(options.input), feedback = JSON.parse(fs.readFileSync(options.feedback, 'utf8'));
  const challenge = options.challenge && fs.existsSync(options.challenge) ? JSON.parse(fs.readFileSync(options.challenge, 'utf8')) : null;
  const productions = { before: loadProduction(null, { sourceDir: options.snapshot }), current: loadProduction() };
  const evaluated = await evaluateRecords(records, feedback, productions, { scope: options.scope, warmup: options.warmup, challenge });
  const codeFiles = ['evaluate-segments.cjs', 'coverage.cjs', './dataset.cjs', './stats.cjs',
    './labels/validate.cjs', './labels/semantics.js', './runner.cjs', './metrics.cjs', '../tests/harness.cjs'];
  const report = { schemaVersion: 1, kind: 'production-multi-segment-replay', generatedAt: new Date().toISOString(), target: 'skipDecision',
    ...evaluated.summary, production: Object.fromEntries(Object.entries(productions).map(([name, value]) => [name, {
      sourceSha256: value.sourceSha256, sourceDir: value.sourceDir, codeSize: value.codeSize,
      codeSizeScope: 'Only content scripts loaded by runner; excludes API, popup, manifest and assets' }])),
    environment: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model },
    inputs: { corpus: { file: options.input, sha256: hash(records) }, human: { file: options.feedback, sha256: hash(feedback) },
      ...(challenge ? { challenge: { file: options.challenge, sha256: hash(challenge) } } : {}) },
    evaluationCodeSha256: hash(codeFiles.map(filename => `${filename}\0${fs.readFileSync(path.join(__dirname, filename), 'utf8')}`).join('\0')),
    excluded: evaluated.excluded, errors: evaluated.errors,
    limitations: ['Human/challenge labels and community references are not passed to detection.',
      'Human development labels are actively selected, not a random platform accuracy sample. Content type and skip decision are independent.',
      'Only explicit high-confidence skip/keep seconds are scored; uncertain-boundary labels use the coverage helper inset policy. Unknown predictions are separate.',
      'Strict complete coverage requires one original prediction per original high-confidence-boundary should-skip segment; adjacent fragments are not combined.',
      'automaticSegments must match actual seek destinations one-to-one; extra or repeated seeks fail evaluation.',
      'Unlabelled challenge candidates receive diagnostics only; assistant-provisional challenge references are scored separately as provisional agreement, never human accuracy.',
      'Development scope excludes whole holdout authors. All scope is intended only after the algorithm is frozen.',
      'Local fixture detection timing includes detection and attachSkipper, excludes VM creation and real network; completeReplay includes VM setup and harness overhead.',
      'Production source hash/file sizes cover runner-loaded content scripts only, not API, popup, manifest or assets.',
      'A complete-segment detection failed diagnostic counts as an evaluation error even when a runtime fallback still produces candidates.'] };
  fs.mkdirSync(options.out, { recursive: true });
  fs.writeFileSync(path.join(options.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(options.out, 'per-video.jsonl'), evaluated.rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(options.out, 'challenge.json'), JSON.stringify(evaluated.challengeRows, null, 2) + '\n');
  fs.writeFileSync(path.join(options.out, 'results.html'), renderHtml(report, evaluated.rows, evaluated.challengeRows));
  console.log(JSON.stringify({ output: path.resolve(options.out), scope: report.scope, replayed: report.replayedVideos,
    humanVideos: report.human.development.videos, errors: report.errors.length, execution: report.execution, human: report.human.development }, null, 2));
  if (report.errors.length) throw new Error(`${report.errors.length} production replay errors; inspect report.json`);
  return report;
}
function parse(args) {
  const options = { input: 'eval/data/combined-351.jsonl', feedback: 'eval/labels/human/review-2026-09-30-v2.json',
    snapshot: 'eval/snapshots/pre-segment-v1', challenge: 'eval/labels/assistant-challenge-v1.json',
    out: 'eval/output/segment-v1', scope: 'development', warmup: 5 };
  for (let i = 0; i < args.length; i++) {
    const field = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !Object.hasOwn(options, field) || !args[i + 1]) throw new Error(`Unknown/missing option ${args[i]}`);
    options[field] = args[++i];
  }
  options.warmup = Number(options.warmup);
  if (!Number.isInteger(options.warmup) || options.warmup < 0 || options.warmup > 1000) throw new Error('Invalid warmup video count');
  if (!['development', 'human', 'all'].includes(options.scope)) throw new Error('Invalid scope');
  return options;
}
if (require.main === module) {
  try { run(parse(process.argv.slice(2))).catch(error => { console.error(error.stack); process.exitCode = 1; }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { detectorInput, normalizeReplay, bestSinglePrediction, wholeSegments, summarizeHuman, evaluateRecords, renderHtml, run, parse };

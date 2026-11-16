#!/usr/bin/env node
'use strict';
// Honest estimate for a detector whose pitch table was fitted on the development
// split: every development video is replayed with a table trained on the other
// authors only. Validation is replayed with the shipped table, which never saw it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadBenchmark } = require('./content-benchmark.cjs');
const { loadProduction, runVideo } = require('./runner.cjs');
const { detectorInput, normalizeReplay } = require('./evaluate-segments.cjs');
const { assess, summarize } = require('./compare-release-markings.cjs');
const { loadFeatures, examples, train, serialize } = require('./train-pitch-model.cjs');
const { resolveSource } = require('../tests/export-source.cjs');

const FOLDS = 5;
const foldOf = author => parseInt(createHash('sha256').update(`pitch-cv-v1:${author}`).digest('hex').slice(0, 8), 16) % FOLDS;

function sourceWithTable(sourceDir, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bss-pitch-cv-'));
  for (const name of fs.readdirSync(sourceDir)) {
    if (name.endsWith('.js')) fs.copyFileSync(path.join(sourceDir, name), path.join(directory, name));
  }
  fs.writeFileSync(path.join(directory, 'pitch-model.js'), text);
  return directory;
}

async function replay(rows, production, transform = input => input) {
  const out = [];
  for (const { item, source, ref, quality } of rows) {
    const result = normalizeReplay(source, await runVideo(transform(detectorInput(source)), production));
    out.push({ bvid: item.bvid, split: item.split, versions: { current: { ...assess(ref, result.candidates, quality),
      automaticSegments: result.automaticSegments, seekDestinations: result.seekDestinations } } });
  }
  return out;
}

function automatic(rows) {
  // Did each interval the player actually sought over land on a reviewed ad?
  const tally = { segments: 0, correct: 0, insideAd: 0, wrongKeep: 0, unknown: 0 };
  for (const row of rows) {
    const version = row.versions.current;
    for (const segment of version.automaticSegments) {
      const marking = version.markings.find(m => m.start === segment.start && m.end === segment.end);
      tally.segments++;
      tally[marking.status === 'correct' ? 'correct' : marking.status === 'wrong-keep' ? 'wrongKeep'
        : marking.status === 'unknown' ? 'unknown' : 'insideAd']++;
    }
  }
  return tally;
}

async function run(sourceDir, output, { transform, label = 'full-inputs' } = {}) {
  const state = loadBenchmark();
  // A snapshot from before the pitch table has nothing to refit: its single
  // replay already is the honest number, reported in all three rows.
  const fitted = fs.existsSync(path.join(sourceDir, 'ad-signals.js')) && fs.existsSync(path.join(sourceDir, 'pitch-model.js'));
  const features = fitted ? loadFeatures(sourceDir) : null;
  const development = state.rows.filter(row => row.item.split === 'development');
  const validation = state.rows.filter(row => row.item.split === 'validation');
  const folds = [], temporary = [];
  try {
    for (let fold = 0; fitted && fold < FOLDS; fold++) {
      const held = development.filter(row => foldOf(row.item.author) === fold);
      const model = train(examples(development.filter(row => foldOf(row.item.author) !== fold), features));
      const directory = sourceWithTable(sourceDir, serialize(model, { split: `development minus fold ${fold}`, videos: model.videos }));
      temporary.push(directory);
      folds.push(...await replay(held, loadProduction(null, { sourceDir: directory }), transform));
    }
    const shipped = loadProduction(null, { sourceDir });
    const inSample = await replay(development, shipped, transform), unseen = await replay(validation, shipped, transform);
    if (!fitted) folds.push(...inSample);
    const report = { kind: 'pitch-table-cross-validation', createdAt: new Date().toISOString(), inputs: label, folds: fitted ? FOLDS : 0,
      foldPolicy: 'SHA-256 of creator key; a creator never appears in both the training and the replayed fold.',
      benchmarkSha256: state.manifestSha256, sourceSha256: shipped.sourceSha256,
      developmentCrossValidated: { ...summarize(folds, 'current'), automatic: automatic(folds) },
      developmentInSample: { ...summarize(inSample, 'current'), automatic: automatic(inSample) },
      validationShippedTable: { ...summarize(unseen, 'current'), automatic: automatic(unseen) },
      rows: { crossValidated: folds, validation: unseen } };
    if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally {
    for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  }
}

function format(report) {
  const row = (name, s) => `${name} | ${s.correctMarkings}/${s.totalMarkings} | ${s.correctPercent?.toFixed(1)}% | ${s.wrongKeepMarkings} (${s.wrongKeepPercent?.toFixed(1)}%) | ${s.videosWithAllAdsCorrect}/${s.videosWithSkipAds} | ${s.automatic.segments}/${s.automatic.correct}/${s.automatic.insideAd}/${s.automatic.wrongKeep}`;
  return [`输入：${report.inputs}`,
    '范围 | 正确标记数/总标记数 | 标记正确率 | 误标正文 | 广告基本跳完整的视频 | 自动跳转 段数/正确/落在广告内/误跳正文',
    '--- | --- | --- | --- | --- | ---',
    row('development · 交叉验证（无偏）', report.developmentCrossValidated),
    row('development · 训练集内（偏乐观）', report.developmentInSample),
    row('validation · 未参与训练', report.validationShippedTable)].join('\n');
}

// node eval/cross-validate-pitch-model.cjs <branch | directory> [report.json] [no-subtitles]
if (require.main === module) (async () => {
  const [spec, output, mode] = process.argv.slice(2);
  const source = resolveSource(spec);
  try {
    // Anonymous viewers often receive no subtitle track at all; replay that case too.
    const options = mode === 'no-subtitles'
      ? { label: 'subtitles withheld from the detector', transform: input => ({ ...input, subtitles: [] }) } : {};
    const report = await run(source.directory, output, options);
    console.log(`评测对象：${source.label}\n${format(report)}`);
  } finally {
    source.cleanup();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { FOLDS, foldOf, run, format, automatic };

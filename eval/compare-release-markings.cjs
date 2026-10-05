#!/usr/bin/env node
'use strict';
// Evaluate content-labelled skip ranges; detecting a trigger alone is not success.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { RELEASE_BASELINE } = require('./audit-full-content.cjs');
const { loadBenchmark } = require('./content-benchmark.cjs');
const { intersections } = require('./audit-content-review.cjs');
const { loadProduction, runVideo } = require('./runner.cjs');
const { detectorInput, normalizeReplay } = require('./evaluate-segments.cjs');
const EPSILON = 1e-9;
const RELEASE_201 = '88652cdd6152f7652a7b21731d53c0942264ca86';
const seconds = ranges => ranges.reduce((n, r) => n + r.end - r.start, 0);
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

function matches(reference, prediction) {
  for (const range of [reference, prediction]) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) throw Error('Invalid interval');
  }
  return overlap(reference, prediction) > EPSILON
    && Math.abs(reference.start - prediction.start) <= 5 + EPSILON
    && Math.abs(reference.end - prediction.end) <= 5 + EPSILON;
}

function assess(ref, predictions, { allAdsAssessable = true } = {}) {
  // Maximum one-to-one matching: no fragment merging or duplicate credit.
  const edges = predictions.map(p => ref.skip.map((r, i) => ({ r, i }))
    .filter(({ r }) => matches(r, p))
    .sort((a, b) => Math.abs(a.r.start - p.start) + Math.abs(a.r.end - p.end)
      - Math.abs(b.r.start - p.start) - Math.abs(b.r.end - p.end)).map(({ i }) => i));
  const owners = new Map();
  function assign(predictionIndex, seen) {
    for (const referenceIndex of edges[predictionIndex]) {
      if (seen.has(referenceIndex)) continue;
      seen.add(referenceIndex);
      if (!owners.has(referenceIndex) || assign(owners.get(referenceIndex), seen)) {
        owners.set(referenceIndex, predictionIndex); return true;
      }
    }
    return false;
  }
  predictions.forEach((_, i) => assign(i, new Set()));
  const matched = new Set(owners.values());
  const allowed = ref.skip.map(r => ({ start: Math.max(0, r.start - 5), end: r.end + 5 }));
  const markings = predictions.map((p, i) => {
    const keep = intersections([p], ref.keepSpeech);
    const extraKeepSeconds = Math.max(0, seconds(keep) - seconds(intersections(keep, allowed)));
    const knownSeconds = seconds(intersections([p], [...ref.skipSpeech, ...ref.keepSpeech]));
    return { start: p.start, end: p.end, source: p.source || null, extraKeepSeconds,
      status: matched.has(i) ? 'correct' : extraKeepSeconds > EPSILON ? 'wrong-keep'
        : knownSeconds > EPSILON ? 'partial-or-boundary' : 'unknown' };
  });
  const boundaries = ref.skip.map((r, referenceIndex) => {
    const candidates = predictions.map((p, predictionIndex) => ({ p, predictionIndex, overlap: overlap(r, p) }))
      .filter(p => p.overlap > EPSILON).sort((a, b) => b.overlap - a.overlap
        || Math.abs(a.p.start - r.start) + Math.abs(a.p.end - r.end)
          - Math.abs(b.p.start - r.start) - Math.abs(b.p.end - r.end));
    const predictionIndex = owners.get(referenceIndex) ?? candidates[0]?.predictionIndex;
    const p = predictions[predictionIndex];
    return { referenceIndex, start: r.start, end: r.end, matched: owners.has(referenceIndex),
      predictionIndex: predictionIndex ?? null, startErrorSeconds: p ? p.start - r.start : null,
      endErrorSeconds: p ? p.end - r.end : null,
      missingStartSeconds: p ? Math.max(0, p.start - r.start) : null,
      missingEndSeconds: p ? Math.max(0, r.end - p.end) : null };
  });
  return { referenceAds: ref.skip.length, allAdsAssessable, markings, boundaries,
    matched: [...owners].map(([referenceIndex, predictionIndex]) => ({ referenceIndex, predictionIndex })),
    allAdsCorrect: allAdsAssessable && ref.skip.length > 0 && owners.size === ref.skip.length };
}

function summarize(rows, version) {
  const values = rows.map(r => r.versions[version]);
  const markings = values.flatMap(v => v.markings);
  const count = status => markings.filter(p => p.status === status).length;
  const correct = count('correct'), wrongKeep = count('wrong-keep');
  return { reviewedVideos: rows.length, videosWithSkipAds: values.filter(v => v.referenceAds > 0).length,
    totalMarkings: markings.length, correctMarkings: correct,
    correctPercent: markings.length ? 100 * correct / markings.length : null,
    wrongKeepMarkings: wrongKeep, wrongKeepPercent: markings.length ? 100 * wrongKeep / markings.length : null,
    partialOrBoundary: count('partial-or-boundary'), unknown: count('unknown'),
    videosWithAllAdsCorrect: values.filter(v => v.allAdsCorrect).length,
    videosWithUnresolvedAds: values.filter(v => !v.allAdsAssessable).length };
}

async function run(sourceDir, output = 'eval/output/release-markings.json', scope = 'development') {
  if (!['development', 'validation', 'all'].includes(scope)) throw Error('Choose development, validation or all');
  const state = loadBenchmark();
  const versions = { '2.0.1': loadProduction(RELEASE_201), '2.1.0': loadProduction(RELEASE_BASELINE),
    current: loadProduction(null, sourceDir ? { sourceDir } : {}) };
  const rows = [];
  for (const { item, source, ref, quality, cohort } of state.rows.filter(r => scope === 'all' || r.item.split === scope)) {
    const row = { bvid: item.bvid, cid: item.cid, title: source.title, cohort, split: item.split, versions: {} };
    for (const [version, production] of Object.entries(versions)) {
      const replay = normalizeReplay(source, await runVideo(detectorInput(source), production));
      row.versions[version] = { ...assess(ref, replay.candidates, quality),
        automaticSegments: replay.automaticSegments, seekDestinations: replay.seekDestinations };
    }
    rows.push(row);
  }
  const grouped = {};
  for (const split of ['all', 'development', 'validation']) {
    const members = rows.filter(r => split === 'all' || r.split === split);
    grouped[split] = Object.fromEntries(Object.keys(versions).map(v => [v, summarize(members, v)]));
  }
  const result = { kind: 'content-reference-marking-comparison', createdAt: new Date().toISOString(), scope,
    policy: 'All detected markings, regardless of confirmation mode. Both endpoints within 5 seconds, positive overlap, one-to-one matching; no 90% coverage threshold.',
    limitations: ['Assistant subtitle references, not frame-verified human ground truth.',
      'Previously collected and partly used corpus; author-disjoint validation does not prove population accuracy.',
      'Missing/pending reviews are excluded, never counted as no-ad or correct. Uncertain decisions and subtitle gaps remain unknown.',
      'Videos with unresolved possible skip segments cannot earn all-ads-correct credit. Correctness is for all markings, not automatic-mode accuracy.',
      'Wrong-keep percent uses all markings as denominator; it is not a population false-positive rate.'],
    versions: Object.fromEntries(Object.entries(versions).map(([v, p]) => [v, { commit: p.commit, sourceSha256: p.sourceSha256 }])),
    benchmarkManifest: state.manifestFile, benchmarkSha256: state.manifestSha256, inventory: state.counts,
    evaluatorSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    excludedVideos: state.missing.length, grouped, rows };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function formatSummary(result) {
  const percent = value => value == null ? '—' : `${value.toFixed(1)}%`;
  return [`已评估 ${result.rows.length} 个已审核视频（${result.scope}）。`,
    '版本 | 正确标记数/总标记数 | 标记正确率 | 误标正文比例 | 广告基本跳完整的视频数',
    '--- | --- | --- | --- | ---',
    ...Object.entries(result.grouped.all).map(([version, s]) =>
      `${version} | ${s.correctMarkings}/${s.totalMarkings} | ${percent(s.correctPercent)} | ${percent(s.wrongKeepPercent)} | ${s.videosWithAllAdsCorrect}`)].join('\n');
}

if (require.main === module) run(process.argv[2], process.argv[3], process.argv[4])
  .then(result => console.log(formatSummary(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { matches, assess, summarize, run, formatSummary };

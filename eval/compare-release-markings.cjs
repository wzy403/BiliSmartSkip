#!/usr/bin/env node
'use strict';
// Evaluate content-labelled skip ranges; detecting a trigger alone is not success.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadReferences, RELEASE_BASELINE } = require('./audit-full-content.cjs');
const { intersections } = require('./audit-content-review.cjs');
const { loadProduction, runVideo } = require('./runner.cjs');
const { detectorInput, normalizeReplay } = require('./evaluate-segments.cjs');
const EPSILON = 1e-9;
const DIRECTORY = 'eval/labels/assistant-content-351-20261004';
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

function assess(ref, predictions) {
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
    return { start: p.start, end: p.end, extraKeepSeconds,
      status: matched.has(i) ? 'correct' : extraKeepSeconds > EPSILON ? 'wrong-keep'
        : knownSeconds > EPSILON ? 'partial-or-boundary' : 'unknown' };
  });
  return { referenceAds: ref.skip.length, markings,
    matched: [...owners].map(([referenceIndex, predictionIndex]) => ({ referenceIndex, predictionIndex })),
    allAdsCorrect: ref.skip.length > 0 && owners.size === ref.skip.length };
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
    videosWithAllAdsCorrect: values.filter(v => v.allAdsCorrect).length };
}

async function run(sourceDir, output = 'eval/output/release-markings.json') {
  const state = loadReferences(DIRECTORY);
  const versions = { '2.0.1': loadProduction('v2.0.1'), '2.1.0': loadProduction(RELEASE_BASELINE),
    current: loadProduction(null, sourceDir ? { sourceDir } : {}) };
  const rows = [];
  for (const { item, source, ref } of state.rows) {
    const row = { bvid: item.bvid, split: item.split, versions: {} };
    for (const [version, production] of Object.entries(versions)) {
      const replay = normalizeReplay(source, await runVideo(detectorInput(source), production));
      row.versions[version] = assess(ref, replay.candidates);
    }
    rows.push(row);
  }
  const grouped = {};
  for (const split of ['all', 'development', 'validation']) {
    const members = rows.filter(r => split === 'all' || r.split === split);
    grouped[split] = Object.fromEntries(Object.keys(versions).map(v => [v, summarize(members, v)]));
  }
  const result = { kind: 'content-reference-marking-comparison', createdAt: new Date().toISOString(),
    policy: 'All detected markings, regardless of confirmation mode. Both endpoints within 5 seconds, positive overlap, one-to-one matching; no 90% coverage threshold.',
    limitations: ['Assistant subtitle references, not frame-verified human ground truth.',
      'The existing validation results have already been seen; this is not a fresh holdout.',
      'Missing sources are excluded, never counted as no-ad or correct. Unreviewed content remains unknown.'],
    versions: Object.fromEntries(Object.entries(versions).map(([v, p]) => [v, { commit: p.commit, sourceSha256: p.sourceSha256 }])),
    sourceSha256: state.manifest.sourceSha256,
    referenceFreezeSha256: createHash('sha256').update(fs.readFileSync(path.join(DIRECTORY, 'freeze.json'))).digest('hex'),
    evaluatorSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    missingSources: state.missing.length, grouped, rows };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (require.main === module) run(process.argv[2], process.argv[3])
  .then(result => console.log(JSON.stringify(result.grouped.all, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { matches, assess, summarize, run };

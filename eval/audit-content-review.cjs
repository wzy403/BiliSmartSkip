#!/usr/bin/env node
'use strict';
// Compare frozen, prediction-blind assistant content reviews with cached replays.
// This measures agreement with subtitle-based reviews, never human accuracy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mergeRanges } = require('./metrics.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const seconds = ranges => mergeRanges(ranges).reduce((n, r) => n + r.end - r.start, 0);
function intersections(a, b) {
  return mergeRanges(mergeRanges(a).flatMap(x => mergeRanges(b).map(y => ({
    start: Math.max(x.start, y.start), end: Math.min(x.end, y.end)
  })).filter(r => r.end > r.start)));
}
const overlap = (a, b) => seconds(intersections(a, b));
function validateRanges(ranges, duration, context) {
  for (const r of ranges) if (!Number.isFinite(r.start) || !Number.isFinite(r.end)
    || r.start < 0 || r.end <= r.start || r.end > duration + 0.001) {
    throw new Error(`${context}: invalid range ${JSON.stringify(r)}`);
  }
}
function reference(review, record) {
  if (!review.fullTranscriptRead || review.cid !== record.cid || review.duration !== record.duration) {
    throw new Error(`${review.bvid}: incomplete review or identity mismatch`);
  }
  const segments = review.segments || [], normal = review.normalSpeechRanges || [];
  validateRanges([...segments, ...normal], record.duration, review.bvid);
  const skip = segments.filter(s => s.skipDecision === 'skip' && s.confidence === 'high');
  const keep = [...normal, ...segments.filter(s => s.skipDecision === 'keep' && s.confidence === 'high')];
  const uncertain = segments.filter(s => s.skipDecision === 'uncertain' || s.confidence !== 'high');
  // Uncertain content may be explicitly kept; it is then known keep, not unknown.
  for (let i = 0; i < skip.length; i++) for (let j = i + 1; j < skip.length; j++) {
    if (overlap([skip[i]], [skip[j]]) > 1e-9) throw new Error(`${review.bvid}: overlapping skip references`);
  }
  if (overlap(skip, keep) > 1e-9) throw new Error(`${review.bvid}: conflicting skip/keep`);
  if (overlap([...skip, ...keep], uncertain) > 1e-9) throw new Error(`${review.bvid}: scored uncertain range`);
  const speech = record.subtitles.map(s => ({ start: s.from, end: s.to }));
  return { skip, skipSpeech: intersections(skip, speech), keepSpeech: intersections(keep, speech),
    unknownPolicy: 'Unreviewed speech, uncertain decisions, and all subtitle gaps remain unknown.' };
}
function score(ref, predictions) {
  const tp = overlap(predictions, ref.skipSpeech), fp = overlap(predictions, ref.keepSpeech);
  return {
    predictedSeconds: seconds(predictions),
    reviewedSkipSpeechSeconds: seconds(ref.skipSpeech),
    reviewedKeepSpeechSeconds: seconds(ref.keepSpeech),
    coveredSkipSpeechSeconds: tp,
    missedSkipSpeechSeconds: seconds(ref.skipSpeech) - tp,
    coveredKeepSpeechSeconds: fp,
    unknownPredictionSeconds: Math.max(0, seconds(predictions) - tp - fp),
    segmentCoverage: ref.skip.map(s => {
      const coverage = predictions.map(p => overlap([p], [s]) / (s.end - s.start));
      return { start: s.start, end: s.end, bestSingleCoverage: Math.max(0, ...coverage),
        complete: coverage.some(c => c >= 1 - 1e-9) };
    }),
    predictions: predictions.map(p => ({ start: p.start, end: p.end,
      skipSpeechSeconds: overlap([p], ref.skipSpeech), keepSpeechSeconds: overlap([p], ref.keepSpeech),
      unknownSeconds: Math.max(0, p.end - p.start - overlap([p], ref.skipSpeech) - overlap([p], ref.keepSpeech)) }))
  };
}
function actualSeeks(replay, duration) {
  const unused = [...replay.seekDestinations];
  const ranges = replay.automaticSegments.map(s => {
    const i = unused.findIndex(end => Math.abs(end - s.end) <= 0.06);
    if (i < 0) throw new Error('Automatic segment missing its recorded actual seek');
    return { start: s.start, end: Math.min(duration, unused.splice(i, 1)[0]) };
  });
  if (unused.length) throw new Error('Unmatched actual seek');
  return ranges;
}
function aggregate(rows, variant, mode) {
  const values = rows.map(r => r[variant][mode]);
  const fields = ['predictedSeconds', 'reviewedSkipSpeechSeconds', 'reviewedKeepSpeechSeconds',
    'coveredSkipSpeechSeconds', 'missedSkipSpeechSeconds', 'coveredKeepSpeechSeconds', 'unknownPredictionSeconds'];
  return { videos: rows.length,
    ...Object.fromEntries(fields.map(f => [f, values.reduce((n, v) => n + v[f], 0)])),
    referenceSkipSegments: values.reduce((n, v) => n + v.segmentCoverage.length, 0),
    completelyCoveredReferenceSegments: values.reduce((n, v) => n + v.segmentCoverage.filter(s => s.complete).length, 0),
    predictionCount: values.reduce((n, v) => n + v.predictions.length, 0),
    predictionsTouchingSkipSpeech: values.reduce((n, v) => n + v.predictions.filter(p => p.skipSpeechSeconds > 0).length, 0),
    predictionsTouchingKeepSpeech: values.reduce((n, v) => n + v.predictions.filter(p => p.keepSpeechSeconds > 1e-9).length, 0) };
}
function main(args) {
  const reviewDir = args[0] || 'eval/labels/assistant-content-20261004';
  const replayFile = args[1] || 'eval/output/danmaku-local-ad-evidence-20261004-human15/per-video.jsonl';
  const out = args[2] || 'eval/output/content-audit-20261004/comparison.json';
  const selection = read(path.join(reviewDir, 'selection.json'));
  const sourceFile = 'eval/data/combined-351.jsonl';
  const freeze = read(path.join(reviewDir, 'freeze.json'));
  if (freeze.selectionSha256 && hash(fs.readFileSync(path.join(reviewDir, 'selection.json'))) !== freeze.selectionSha256) {
    throw new Error('Frozen review selection changed');
  }
  for (const item of freeze.files) {
    if (hash(fs.readFileSync(item.path)) !== item.sha256) throw new Error(`Frozen review changed: ${item.path}`);
  }
  if (freeze.sourceSha256 && hash(fs.readFileSync(sourceFile)) !== freeze.sourceSha256) {
    throw new Error('Frozen subtitle source changed');
  }
  const sources = new Map(jsonl(sourceFile).map(r => [r.bvid, r]));
  const replays = new Map(jsonl(replayFile).map(r => [r.bvid, r]));
  const batches = [1, 2, 3].map(n => path.join(reviewDir, `batch-${n}.json`));
  if (batches.some(file => !freeze.files.some(item => path.resolve(item.path) === path.resolve(file)))) {
    throw new Error('Missing review freeze entry');
  }
  const docs = batches.map(read);
  if (docs.some(d => d.kind !== 'assistant-content-review' || d.algorithmPredictionsSeen !== false)) {
    throw new Error('Expected explicitly prediction-blind assistant reviews');
  }
  const reviews = docs.flatMap(d => d.records);
  if (reviews.length !== selection.records.length || new Set(reviews.map(r => r.bvid)).size !== reviews.length) {
    throw new Error('Review count or identity mismatch');
  }
  const rows = selection.records.map(item => {
    const review = reviews.find(r => r.bvid === item.bvid), source = sources.get(item.bvid), replay = replays.get(item.bvid);
    if (!review || !source || !replay) throw new Error(`Missing review/source/replay ${item.bvid}`);
    const ref = reference(review, source);
    const result = { bvid: item.bvid, group: item.group, adPresence: review.adPresence,
      hasExistingHumanReview: Array.isArray(replay.humanSegments) && replay.humanSegments.length > 0,
      contentSummary: review.videoSummary, referenceSegments: review.segments };
    for (const variant of ['before', 'current']) result[variant] = {
      automatic: score(ref, actualSeeks(replay[variant], source.duration)),
      candidates: score(ref, replay[variant].candidates)
    };
    return result;
  });
  const grouped = {};
  for (const group of ['all', ...new Set(rows.map(r => r.group))]) {
    const members = group === 'all' ? rows : rows.filter(r => r.group === group);
    grouped[group] = {};
    for (const v of ['before', 'current']) grouped[group][v] = Object.fromEntries(
      ['automatic', 'candidates'].map(mode => [mode, aggregate(members, v, mode)]));
  }
  const result = { kind: 'assistant-content-reference-agreement', date: '2026-10-04',
    limitations: ['Assistant review of cached AI subtitles; not independent human truth or frame-verified boundaries.',
      'Selection is enriched for predictions and changes; corpus was used in development. No population accuracy claim.',
      'No boundary trimming. Full proposed ad spans retained for per-segment completeness.',
      'Only actual subtitle-covered seconds are scored; gaps and uncertain decisions remain unknown.',
      'Automatic ranges include recorded seek destinations (normally end + 0.05s).',
      'A complete ad coverage count does not imply safe start/end or no skipped main content.'],
    hashes: { source: hash(fs.readFileSync(sourceFile)), replay: hash(fs.readFileSync(replayFile)),
      reviews: batches.map(file => ({ file, sha256: hash(fs.readFileSync(file)) })),
      selection: hash(fs.readFileSync(path.join(reviewDir, 'selection.json'))) }, grouped, rows };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, grouped }, null, 2));
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { intersections, reference, score, actualSeeks, aggregate };

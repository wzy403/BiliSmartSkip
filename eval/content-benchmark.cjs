#!/usr/bin/env node
'use strict';
// Combine existing content reviews; never infer review completion from file count.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { loadReferences } = require('./audit-full-content.cjs');
const { reference, intersections } = require('./audit-content-review.cjs');
const { creatorKey, splitForCreator } = require('./metrics.cjs');
const { detectorInput } = require('./evaluate-segments.cjs');
const OLD = 'eval/labels/assistant-content-351-20261004';
const EXTRA = 'eval/labels/assistant-content-extra300';
const DIRECTORY = 'eval/benchmarks/content-438-v1';
const HUMAN = 'eval/labels/human/review-2026-10-04-v3.json';
const CORRECTIONS = `${DIRECTORY}/user-decision-overrides.json`;
const hash = body => createHash('sha256').update(body).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n');
const fail = message => { throw Error(message); };

function assertIdentity(a, b) {
  if (!a || !b || ['bvid', 'cid', 'duration'].some(k => a[k] !== b[k])) fail('Source/review identity mismatch');
}

function mergeExtraSource(original, fresh, wrapper, item) {
  const review = wrapper.record;
  for (const value of [fresh, review, item]) assertIdentity(original, value);
  if (item.reviewStatus !== 'reviewed' || review.reviewStatus !== 'reviewed'
    || !review.fullTranscriptRead || review.pendingReasons?.length) fail('Review is still pending');
  if (wrapper.kind !== 'assistant-content-review' || wrapper.algorithmPredictionsSeen !== false
    || wrapper.communityAdLabelsSeen !== false || wrapper.danmakuJumpTimesSeen !== false) fail('Expected blind content review');
  const coverage = review.readCoverage;
  if (!fresh.subtitles?.length || !coverage?.allRowsRead || coverage.firstIndex !== 0
    || coverage.lastIndex !== fresh.subtitles.length - 1 || coverage.subtitleRows !== fresh.subtitles.length
    || item.subtitleRows !== fresh.subtitles.length) fail('Incomplete transcript coverage');
  // The blind source intentionally contains no danmaku/chapters. Retain those from
  // the original acquisition, replacing only the explicitly refreshed fields.
  const source = { ...original };
  for (const key of ['title', 'desc', 'subtitles']) source[key] = fresh[key];
  return source;
}

function loadExtra(directory = EXTRA) {
  const manifestFile = path.join(directory, 'manifest.json'), manifest = read(manifestFile);
  const freezeFile = path.join(directory, 'freeze.json'), freeze = read(freezeFile);
  if (fileHash(manifestFile) !== freeze.manifestSha256 || fileHash(manifest.source) !== manifest.sourceSha256
    || manifest.sourceSha256 !== freeze.sourceSha256) fail('Extra manifest/source freeze changed');
  const frozenFiles = new Map(freeze.files.map(f => [f.path, f.sha256]));
  if (frozenFiles.size !== freeze.files.length) fail('Duplicate frozen file');
  const checked = (file, expected) => {
    if (!expected || fileHash(file) !== expected || frozenFiles.get(file) !== expected) fail(`Frozen file changed: ${file}`);
    return read(file);
  };
  const lines = jsonl(manifest.source), originals = lines.map(JSON.parse);
  if (lines.length !== manifest.expectedVideoCount || manifest.records.length !== lines.length) fail('Extra inventory count mismatch');
  const seen = new Set(), cids = new Set(), rows = [], missing = [];
  for (const item of manifest.records) {
    if (seen.has(item.bvid) || cids.has(item.cid)) fail('Duplicate extra video');
    seen.add(item.bvid); cids.add(item.cid);
    const original = originals[item.inputLine - 1];
    assertIdentity(original, item);
    if (hash(lines[item.inputLine - 1]) !== item.inputLineSha256 || item.inputSha256 !== manifest.sourceSha256) fail('Original line provenance changed');
    const wrapper = checked(item.recordFile, item.recordSha256);
    const fresh = checked(item.transcriptFile, item.transcriptSha256);
    assertIdentity(wrapper.record, item); assertIdentity(fresh, item);
    if (wrapper.record.reviewStatus !== item.reviewStatus) fail('Review/manifest status mismatch');
    for (const key of ['inputLine', 'inputLineSha256', 'inputSha256', 'transcriptFile', 'transcriptSha256']) {
      if (wrapper.source?.[key] !== item[key]) fail(`Review provenance mismatch: ${key}`);
    }
    if (item.reviewStatus !== 'reviewed') {
      missing.push({ bvid: item.bvid, cid: item.cid, cohort: 'extra300', status: item.reviewStatus,
        reasons: wrapper.record.pendingReasons });
      continue;
    }
    const source = mergeExtraSource(original, fresh, wrapper, item);
    rows.push({ item, source, review: wrapper.record, ref: reference(wrapper.record, source),
      recordFile: item.recordFile, recordSha256: item.recordSha256,
      transcriptFile: item.transcriptFile, transcriptSha256: item.transcriptSha256 });
  }
  if (rows.length !== manifest.completedCounts.completed || missing.length !== manifest.completedCounts.pending
    || !isDeepStrictEqual(manifest.completedCounts, freeze.counts)) fail('Extra completion counts changed');
  return { manifest, rows, missing, manifestFile, freezeFile };
}

function referenceQuality(review) {
  const uncertain = review.segments.filter(s => s.confidence !== 'high' || s.skipDecision === 'uncertain');
  return { uncertainSegments: uncertain.length,
    unscoredSkipSegments: uncertain.filter(s => s.skipDecision === 'skip').length,
    // Do not say all ads were covered while a possible additional ad is unscored.
    allAdsAssessable: !uncertain.some(s => s.skipDecision !== 'keep') };
}

function subtractRange(ranges, cut) {
  return ranges.flatMap(r => r.end <= cut.start || r.start >= cut.end ? [r] : [
    ...(r.start < cut.start ? [{ ...r, end: cut.start }] : []),
    ...(r.end > cut.end ? [{ ...r, start: cut.end }] : [])]);
}

function applyUserCorrections(review, decisions, human) {
  const result = structuredClone(review);
  for (const correction of decisions.filter(c => c.bvid === review.bvid)) {
    const confirmed = human.records.find(r => r.bvid === review.bvid && r.cid === review.cid)?.segments[correction.humanSegmentIndex];
    if (!confirmed || confirmed.skipConfidence !== 'high'
      || ['start', 'end', 'skipDecision'].some(k => confirmed[k] !== correction[k])) fail('User correction no longer matches its source');
    const index = result.segments.findIndex(s => ['start', 'end', 'skipDecision'].every(k => s[k] === correction.replaces[k]));
    if (index < 0) fail('User correction no longer matches original assistant decision');
    const previous = result.segments.splice(index, 1)[0];
    result.segments.push(...subtractRange([previous], confirmed), { start: confirmed.start, end: confirmed.end,
      contentType: confirmed.contentType, skipDecision: confirmed.skipDecision, confidence: 'high',
      boundaryConfidence: confirmed.boundaryConfidence, reason: confirmed.reason, evidence: confirmed.evidence,
      decisionProvenance: `${HUMAN}#${review.bvid}/segments/${correction.humanSegmentIndex}` });
    if (confirmed.skipDecision === 'skip') result.normalSpeechRanges = subtractRange(result.normalSpeechRanges, confirmed);
  }
  result.segments.sort((a, b) => a.start - b.start);
  return result;
}

function collect() {
  const old = loadReferences(OLD), extra = loadExtra();
  const human = read(HUMAN), corrections = read(CORRECTIONS);
  if (corrections.humanSourceSha256 !== fileHash(HUMAN)) fail('User feedback source changed');
  const oldSources = jsonl(old.manifest.source).map(JSON.parse);
  const oldAuthors = new Set(oldSources.map(creatorKey));
  const allIds = new Set(old.manifest.records.map(r => r.bvid));
  const allCids = new Set(old.manifest.records.map(r => r.cid));
  for (const item of extra.manifest.records) {
    if (allIds.has(item.bvid) || allCids.has(item.cid)) fail('Overlapping source inventories');
  }
  const rows = [...old.rows.map(row => ({ ...row, cohort: 'old351',
    recordFile: `${OLD}/records/${row.item.bvid}.json`,
    recordSha256: fileHash(`${OLD}/records/${row.item.bvid}.json`),
    transcriptFile: old.manifest.source, transcriptSha256: old.manifest.sourceSha256 })),
  ...extra.rows.map(row => ({ ...row, cohort: 'extra300' }))];
  for (const row of rows) {
    row.review = applyUserCorrections(row.review, corrections.decisions, human);
    row.ref = reference(row.review, row.source);
    // Partial human confirmations must never be contradicted by a complete
    // assistant reference. Agreed longer ad spans are not shortened to fit them.
    const confirmed = human.records.find(r => r.bvid === row.item.bvid);
    if (confirmed) {
      assertIdentity(confirmed, row.source);
      for (const segment of confirmed.segments.filter(s => s.skipConfidence === 'high')) {
        const opposite = segment.skipDecision === 'keep' ? row.ref.skip : row.ref.keepSpeech;
        if (intersections([segment], opposite).length) fail(`Unresolved user/assistant decision conflict: ${row.item.bvid}`);
      }
    }
    const author = creatorKey(row.source);
    const split = row.cohort === 'extra300' && author !== 'unknown-creator' && !oldAuthors.has(author)
      && splitForCreator(row.source, 25, 'content-438-v1') === 'holdout' ? 'validation' : 'development';
    row.item = { ...row.item, author, split };
    row.quality = referenceQuality(row.review);
  }
  rows.sort((a, b) => a.item.bvid.localeCompare(b.item.bvid, 'en'));
  const missing = [...old.missing.map(r => ({ bvid: r.bvid, cid: r.cid, cohort: 'old351', status: 'needs-source', reasons: r.reason })), ...extra.missing];
  const inputs = [OLD, EXTRA].map(directory => ({ directory,
    manifestSha256: fileHash(`${directory}/manifest.json`), freezeSha256: fileHash(`${directory}/freeze.json`) }));
  inputs.push({ humanSource: HUMAN, humanSourceSha256: fileHash(HUMAN), corrections: CORRECTIONS, correctionsSha256: fileHash(CORRECTIONS) });
  const counts = { inventory: old.manifest.records.length + extra.manifest.records.length,
    reviewed: rows.length, oldReviewed: old.rows.length, extraReviewed: extra.rows.length,
    excluded: missing.length, oldExcluded: old.missing.length, extraExcluded: extra.missing.length,
    highConfidenceSkipSegments: rows.reduce((n, r) => n + r.ref.skip.length, 0),
    videosWithHighConfidenceSkip: rows.filter(r => r.ref.skip.length).length,
    unscoredSkipSegments: rows.reduce((n, r) => n + r.quality.unscoredSkipSegments, 0),
    development: rows.filter(r => r.item.split === 'development').length,
    validation: rows.filter(r => r.item.split === 'validation').length };
  return { rows, missing, inputs, counts };
}

function snapshot(state) {
  return { kind: 'frozen-combined-content-benchmark', version: 1, inputs: state.inputs, counts: state.counts,
    splitPolicy: 'All previously reviewed old351 videos are development. New authors absent from old351 use SHA-256 creator split, seed content-438-v1, 25% validation. Previously collected material is not a fresh population holdout.',
    referencePolicy: 'High-confidence skip and keep decisions only; uncertain content and subtitle gaps remain unknown. Keep commercial content when labelled keep. No boundary trimming.',
    records: state.rows.map(r => ({ bvid: r.item.bvid, cid: r.item.cid, duration: r.source.duration,
      cohort: r.cohort, author: r.item.author, split: r.item.split,
      recordFile: r.recordFile, recordSha256: r.recordSha256,
      transcriptFile: r.transcriptFile, transcriptSha256: r.transcriptSha256,
      detectorInputSha256: hash(JSON.stringify(detectorInput(r.source))), ...r.quality })),
    excluded: state.missing };
}

function freezeBenchmark(directory = DIRECTORY) {
  const state = collect();
  if (state.counts.reviewed !== 438 || state.counts.oldReviewed !== 250 || state.counts.extraReviewed !== 188) fail('Unexpected benchmark membership');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(snapshot(state), null, 2) + '\n', { flag: 'wx' });
  return state.counts;
}

function loadBenchmark(directory = DIRECTORY) {
  const state = collect(), manifestFile = path.join(directory, 'manifest.json');
  if (!isDeepStrictEqual(read(manifestFile), snapshot(state))) fail('Combined benchmark changed; make an explicit new version instead of silently refreezing');
  return { ...state, manifestFile, manifestSha256: fileHash(manifestFile) };
}

if (require.main === module) {
  try {
    const action = process.argv[2] || 'check';
    const counts = action === 'freeze' ? freezeBenchmark() : action === 'check' ? loadBenchmark().counts : fail('Use check or freeze');
    console.log(JSON.stringify(counts, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { mergeExtraSource, loadExtra, referenceQuality, applyUserCorrections, collect, snapshot, freezeBenchmark, loadBenchmark };

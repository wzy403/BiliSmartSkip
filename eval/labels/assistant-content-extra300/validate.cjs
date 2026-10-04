#!/usr/bin/env node
'use strict';
// Checks evidence integrity and bookkeeping only. Does not detect advertisements
// or evaluate an algorithm. A successful run never establishes a content review.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const base = __dirname;
const root = path.resolve(base, '../../..');
const rel = value => path.relative(root, value).split(path.sep).join('/');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const issues = [], warnings = [];
const issue = (file, message) => issues.push({ file: rel(file), message });
const warn = (file, message) => warnings.push({ file: rel(file), message });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const equalTime = (left, right) => finite(left) && finite(right) && Math.abs(left - right) < 0.00001;
const overlap = (left, right) => Math.min(left.end, right.end) - Math.max(left.start, right.start) > 0.00001;
if (git('branch', '--show-current') !== 'test-branch') throw Error('Validation output may only be written on test-branch.');
const initialFile = path.join(base, 'initial-audit.json');
const initial = read(initialFile);
const inputFile = path.join(root, initial.source);
const inputBytes = fs.readFileSync(inputFile);
const inputLines = inputBytes.toString('utf8').split('\n');
const inputHash = hash(inputBytes);
if (inputHash !== initial.sourceSha256) issue(inputFile, 'Original input hash changed.');
if (initial.records.length !== 300) issue(initialFile, 'Expected exactly 300 input videos.');
for (const branch of ['master', 'fix/improve-detction-rate']) {
  const ref = `refs/heads/${branch}`;
  const before = initial.git.refs[ref];
  if (before && git('rev-parse', ref) !== before) issue(base, `Protected branch changed: ${branch}.`);
}
for (const entry of initial.comparisonSources.oldReviewFiles) {
  const file = path.join(root, entry.path);
  if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== entry.sha256) issue(file, 'Old review file missing or changed.');
}
const originals = new Map(initial.records.map(row => [row.bvid, row]));
for (const row of initial.records) {
  const raw = inputLines[row.inputLine - 1];
  if (raw === undefined || hash(Buffer.from(raw, 'utf8')) !== row.inputLineSha256) issue(inputFile, `Raw line hash mismatch for ${row.bvid}.`);
}
const oldBvids = new Set(initial.records.filter(row => row.presentInOriginal351 || row.presentInOld250Reviews).map(row => row.bvid));
if (oldBvids.size) issue(initialFile, 'New input overlaps old corpus.');
const recordDir = path.join(base, 'records');
const files = fs.existsSync(recordDir) ? fs.readdirSync(recordDir).filter(file => file.endsWith('.json')).sort().map(file => path.join(recordDir, file)) : [];
const seenBvids = new Set(), seenCids = new Map(), sourceCache = new Map(), visualFilesSeen = new Set();
const counts = { expected: 300, recordFiles: files.length, completed: 0, withSkippableAd: 0, withoutSkippableAd: 0, pending: 0, missingRecords: 0, invalidRecords: 0 };
const reviewed = [], pending = [], fileHashes = [{ path: rel(inputFile), sha256: inputHash }, { path: rel(initialFile), sha256: hash(fs.readFileSync(initialFile)) }];
const resolveEvidence = (value, file) => {
  if (!nonempty(value)) return null;
  const absolute = path.resolve(root, value);
  const baseRelative = path.relative(base, absolute);
  if (baseRelative.startsWith('..') || path.isAbsolute(baseRelative) || !/^(sources|acquisition)[/\\]/.test(baseRelative)) {
    issue(file, 'Transcript source must be inside new review sources/ or acquisition/.');
    return null;
  }
  if (!fs.existsSync(absolute)) { issue(file, `Missing transcript source: ${value}.`); return null; }
  if (!sourceCache.has(absolute)) {
    const bytes = fs.readFileSync(absolute);
    let rows;
    try {
      rows = absolute.endsWith('.jsonl') ? bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse) : [JSON.parse(bytes)];
      sourceCache.set(absolute, { rows, sha256: hash(bytes), path: rel(absolute) });
      fileHashes.push({ path: rel(absolute), sha256: hash(bytes) });
    } catch (error) { issue(file, `Invalid transcript JSON: ${error.message}`); return null; }
  }
  return sourceCache.get(absolute);
};
for (const file of files) {
  const errorsBefore = issues.length;
  let top;
  try { top = read(file); } catch (error) { issue(file, `Invalid JSON: ${error.message}`); counts.invalidRecords++; continue; }
  fileHashes.push({ path: rel(file), sha256: hash(fs.readFileSync(file)) });
  const record = top.record;
  if (!record || typeof record !== 'object') { issue(file, 'Missing record object.'); counts.invalidRecords++; continue; }
  const original = originals.get(record.bvid);
  if (!original) issue(file, 'Video does not belong to new input.');
  if (path.basename(file) !== `${record.bvid}.json`) issue(file, 'Filename does not match BV.');
  if (seenBvids.has(record.bvid)) issue(file, 'Duplicate BV review.');
  seenBvids.add(record.bvid);
  if (seenCids.has(record.cid)) issue(file, `Duplicate CID also used by ${seenCids.get(record.cid)}.`);
  seenCids.set(record.cid, record.bvid);
  if (!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(record.bvid)) issue(file, 'Invalid BV format.');
  if (!Number.isSafeInteger(record.cid) || record.cid <= 0) issue(file, 'Invalid CID.');
  if (original && record.cid !== original.cid) issue(file, 'Record CID differs from input; explicitly resolve identity before review.');
  if (!finite(record.duration) || record.duration <= 0) issue(file, 'Invalid duration.');
  if (top.kind !== 'assistant-content-review') issue(file, 'kind must identify assistant content review.');
  if (!nonempty(top.modality)) issue(file, 'Missing modality.');
  if (top.algorithmPredictionsSeen !== false) issue(file, 'Must explicitly attest algorithmPredictionsSeen=false.');
  for (const key of ['danmakuJumpTimesSeen', 'communityAdLabelsSeen']) if (top[key] === true) issue(file, `Blind-review requirement violated: ${key}.`);
  const status = record.reviewStatus ?? top.reviewStatus;
  if (!['reviewed', 'needs-source', 'needs-review', 'needs-verification'].includes(status)) issue(file, 'Invalid or missing reviewStatus.');
  if ((status === 'reviewed' || record.fullTranscriptRead) && !nonempty(top.reviewer)) issue(file, 'A performed review requires a named assistant reviewer.');
  if (typeof record.fullTranscriptRead !== 'boolean') issue(file, 'fullTranscriptRead must be a truthful boolean.');
  if ((status === 'reviewed' || record.fullTranscriptRead) && !nonempty(record.videoSummary)) issue(file, 'A performed review requires a videoSummary.');
  if (!['ad', 'no_ad_in_transcript', 'uncertain'].includes(record.adPresence)) issue(file, 'Invalid adPresence.');
  if (!Array.isArray(record.limitations) || !record.limitations.length || record.limitations.some(value => !nonempty(value))) issue(file, 'Missing source/modality limitations.');
  const source = top.source || record.source || {};
  if (source.inputFile !== initial.source || source.inputSha256 !== initial.sourceSha256) issue(file, 'Missing/mismatched original input path or hash.');
  if (original && (source.inputLine !== original.inputLine || source.inputLineSha256 !== original.inputLineSha256)) issue(file, 'Missing/mismatched original raw line identity/hash.');
  const loaded = resolveEvidence(source.transcriptFile, file);
  if (loaded && source.transcriptSha256 !== loaded.sha256) issue(file, 'Missing/mismatched transcript file hash.');
  const sourceRow = loaded?.rows.find(row => row.bvid === record.bvid && row.cid === record.cid);
  if (loaded && !sourceRow) issue(file, 'Transcript source does not contain matching BV/CID.');
  if (sourceRow && finite(sourceRow.duration) && !equalTime(sourceRow.duration, record.duration)) issue(file, 'Duration differs from evidence source.');
  if (source.transcriptFile?.includes('/sources/') && sourceRow) {
    for (const key of ['danmaku', 'annotations', 'references', 'predictions', 'algorithmPredictions']) {
      if (Object.hasOwn(sourceRow, key)) issue(file, `Blind-review source unexpectedly includes ${key}.`);
    }
  }
  const subtitles = Array.isArray(sourceRow?.subtitles) ? sourceRow.subtitles : [];
  const subtitleCoverage = [];
  for (const row of [...subtitles].filter(row => nonempty(row.content ?? row.text)).sort((a,b) => a.from-b.from)) {
    const last = subtitleCoverage.at(-1);
    if (last && row.from <= last.end + 0.00001) last.end = Math.max(last.end,row.to);
    else subtitleCoverage.push({start:row.from,end:row.to});
  }
  const hasTranscript = subtitles.some(item => nonempty(item.content ?? item.text));
  const coverage = record.readCoverage ?? top.readCoverage;
  if (record.fullTranscriptRead && (!coverage || coverage.subtitleRows !== subtitles.length || coverage.firstIndex !== 0 || coverage.lastIndex !== subtitles.length - 1 || coverage.allRowsRead !== true)) issue(file, 'Full transcript review requires readCoverage for every source subtitle row.');
  if (record.fullTranscriptRead && !hasTranscript) issue(file, 'Claims full transcript read but no usable transcript exists.');
  if (record.adPresence === 'no_ad_in_transcript' && (!record.fullTranscriptRead || !hasTranscript)) issue(file, 'Missing transcript cannot establish absence of ads.');
  if (status === 'reviewed' && !record.fullTranscriptRead) issue(file, 'Completed subtitle review requires fullTranscriptRead=true.');
  if (status === 'needs-source' && hasTranscript) warn(file, 'Source now has subtitles; check whether needs-source reason remains current.');
  const pendingReasons = record.pendingReasons ?? top.pendingReasons;
  if (status !== 'reviewed' && (!Array.isArray(pendingReasons) || !pendingReasons.length || pendingReasons.some(value => !nonempty(value)))) issue(file, 'Pending review requires specific pendingReasons.');
  if (status === 'reviewed' && Array.isArray(pendingReasons) && pendingReasons.length) issue(file, 'Completed review still has unresolved pendingReasons.');
  if (!Array.isArray(record.segments) || !Array.isArray(record.normalSpeechRanges)) issue(file, 'segments and normalSpeechRanges must be arrays.');
  const segments = Array.isArray(record.segments) ? record.segments : [];
  const normal = Array.isArray(record.normalSpeechRanges) ? record.normalSpeechRanges : [];
  const validRange = (range, label) => {
    if (!finite(range.start) || !finite(range.end) || range.start < 0 || range.end <= range.start || range.end > record.duration + 0.00001) {
      issue(file, `${label} has invalid/out-of-duration time range.`); return false;
    }
    return true;
  };
  const seenSegments = new Set();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i], label = `segments[${i}]`;
    validRange(segment, label);
    const signature = `${segment.start}:${segment.end}:${segment.contentType}:${segment.skipDecision}`;
    if (seenSegments.has(signature)) issue(file, `${label} duplicates another segment.`);
    seenSegments.add(signature);
    if (!['ad', 'non_ad', 'uncertain'].includes(segment.contentType)) issue(file, `${label}: invalid contentType.`);
    if (!['skip', 'keep', 'uncertain'].includes(segment.skipDecision)) issue(file, `${label}: invalid skipDecision.`);
    if (segment.skipDecision === 'skip' && segment.contentType !== 'ad') issue(file, `${label}: only confirmed ads may be labeled skip.`);
    if (!nonempty(segment.reason) || !nonempty(segment.confidence) || !nonempty(segment.boundaryConfidence)) issue(file, `${label}: reason/confidence/boundaryConfidence required.`);
    for (const [key, point] of [['startUncertainty', segment.start], ['endUncertainty', segment.end]]) {
      const range = segment[key];
      if (!Array.isArray(range) || range.length !== 2 || range.some(value => !finite(value)) || range[0] < 0 || range[0] > point || range[1] < point || range[1] > record.duration + 0.00001) issue(file, `${label}: invalid ${key}.`);
    }
    const visual = Array.isArray(segment.visualEvidence) ? segment.visualEvidence : [];
    if (!Array.isArray(segment.evidence) || (!segment.evidence.length && !visual.length)) issue(file, `${label}: timestamped original subtitle or actual visual evidence required.`);
    for (const evidence of visual) {
      if (!finite(evidence.time) || evidence.time < 0 || evidence.time > record.duration + 0.00001 || !nonempty(evidence.observation)) issue(file, `${label}: invalid visual observation time/text.`);
      if (!nonempty(evidence.file)) {issue(file, `${label}: missing visual evidence file.`);continue;}
      let imagePath = path.resolve(root, evidence.file);
      if (!path.isAbsolute(evidence.file) && evidence.file.startsWith('acquisition/')) imagePath = path.resolve(base, evidence.file);
      const mediaRoot = path.join(base, 'acquisition', 'media'), mediaRelative = path.relative(mediaRoot, imagePath);
      if (mediaRelative.startsWith('..') || path.isAbsolute(mediaRelative) || !/\.(png|jpe?g|webp)$/i.test(imagePath)) {issue(file, `${label}: visual evidence must be an image inside acquisition/media/.`);continue;}
      if (!fs.existsSync(imagePath)) {issue(file, `${label}: visual evidence image missing.`);continue;}
      const imageHash = hash(fs.readFileSync(imagePath));
      if (imageHash !== evidence.sha256) issue(file, `${label}: visual evidence hash mismatch.`);
      if (!visualFilesSeen.has(imagePath)) {visualFilesSeen.add(imagePath);fileHashes.push({path:rel(imagePath),sha256:imageHash});}
    }
    for (const evidence of segment.evidence || []) {
      if (!finite(evidence.from) || !finite(evidence.to) || evidence.from < 0 || evidence.to <= evidence.from || evidence.to > record.duration + 0.00001 || !nonempty(evidence.text)) issue(file, `${label}: invalid evidence time/text.`);
      const match = subtitles.some(item => equalTime(item.from, evidence.from) && equalTime(item.to, evidence.to) && (item.content ?? item.text) === evidence.text);
      if (!match) issue(file, `${label}: evidence does not exactly match a timestamped source subtitle.`);
    }
    for (let j = 0; j < i; j++) if (overlap(segment, segments[j])) issue(file, `${label} overlaps segments[${j}]; resolve duplicate or contradictory labels.`);
  }
  for (let i = 0; i < normal.length; i++) {
    const range = normal[i];
    validRange(range, `normalSpeechRanges[${i}]`);
    if (!nonempty(range.reason)) issue(file, `normalSpeechRanges[${i}] missing reason.`);
    if (!record.fullTranscriptRead || !hasTranscript) issue(file, 'Unreviewed or missing transcript cannot be labeled ordinary speech.');
    if (!subtitles.some(item => overlap(range, { start: item.from, end: item.to }))) issue(file, `normalSpeechRanges[${i}] has no supporting subtitle coverage.`);
    let coveredTo = range.start;
    for (const interval of subtitleCoverage) {
      if (interval.end <= coveredTo + 0.00001) continue;
      if (interval.start > coveredTo + 0.00001) break;
      coveredTo = Math.max(coveredTo, interval.end);
      if (coveredTo >= range.end - 0.00001) break;
    }
    if (coveredTo < range.end - 0.00001) issue(file, `normalSpeechRanges[${i}] includes time outside nonempty subtitle coverage; keep visual observations separate.`);
    for (const segment of segments) if (overlap(range, segment) && (segment.skipDecision !== 'keep' || segment.contentType === 'uncertain')) issue(file, `normalSpeechRanges[${i}] overlaps skipped/uncertain content.`);
    for (let j = 0; j < i; j++) if (overlap(range, normal[j])) issue(file, `normalSpeechRanges[${i}] overlaps another ordinary-speech range.`);
  }
  if (record.adPresence === 'no_ad_in_transcript' && segments.some(segment => segment.contentType !== 'non_ad')) issue(file, 'adPresence conflicts with advertisement/uncertain segments.');
  if (record.adPresence === 'ad' && !segments.some(segment => segment.contentType === 'ad')) issue(file, 'adPresence=ad needs an explicitly identified advertisement segment.');
  if (status === 'reviewed' && (record.adPresence === 'uncertain' || segments.some(segment => segment.contentType === 'uncertain' || segment.skipDecision === 'uncertain'))) issue(file, 'Unresolved ad/skip judgments must remain needs-verification.');
  const entry = { bvid: record.bvid, cid: record.cid, reviewStatus: status, path: rel(file), sha256: hash(fs.readFileSync(file)) };
  if (issues.length > errorsBefore) { counts.invalidRecords++; entry.validation = 'invalid'; }
  if (status === 'reviewed' && issues.length === errorsBefore) {
    counts.completed++;
    if (segments.some(segment => segment.contentType === 'ad' && segment.skipDecision === 'skip')) { counts.withSkippableAd++; entry.hasSkippableAd = true; }
    else { counts.withoutSkippableAd++; entry.hasSkippableAd = false; }
    reviewed.push(entry);
  } else {
    counts.pending++;
    entry.pendingReasons = pendingReasons || ['Record incomplete or failed validation; not counted as reviewed.'];
    pending.push(entry);
  }
}
const missing = initial.records.filter(row => !seenBvids.has(row.bvid)).map(row => ({ bvid: row.bvid, cid: row.cid, reason: 'No per-video record saved.' }));
counts.missingRecords = missing.length;
counts.pending += missing.length;
if (missing.length) issue(recordDir, `${missing.length} input videos have no per-video record.`);
const report = {
  kind: 'assistant-extra300-evidence-and-integrity-validation', validatedAt: new Date().toISOString(),
  scope: 'Input identity, provenance, schema, evidence, range/conflict and count checks only; no content review and no algorithm accuracy evaluation.',
  valid: issues.length === 0, sourceSha256: inputHash, counts, issues, warnings,
  reviewed, pending, missingRecords: missing,
  files: fileHashes.sort((a, b) => a.path.localeCompare(b.path)),
};
const output = path.join(base, 'validation-report.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ valid: report.valid, counts, errors: issues.length, warnings: warnings.length, report: rel(output) }, null, 2));
if (issues.length) { console.error(JSON.stringify(issues.slice(0, 20), null, 2)); process.exitCode = 1; }

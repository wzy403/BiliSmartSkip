#!/usr/bin/env node
'use strict';
// Metadata and integrity audit only. Never exposes or uses danmaku, predictions,
// community annotations, or inferred advertisement labels.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const base = __dirname;
const root = path.resolve(base, '../../..');
const rel = value => path.relative(root, value).split(path.sep).join('/');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('branch', '--show-current') !== 'test-branch') throw Error('Audit requires test-branch.');
const target = path.join(base, 'initial-audit.json');
if (fs.existsSync(target)) throw Error('Initial audit already exists; preserve its original snapshot.');
const input = path.join(root, 'eval/data/danmaku-audit-20261001/new-public.jsonl');
const bytes = fs.readFileSync(input);
const oldManifestPath = path.join(root, 'eval/labels/assistant-content-351-20261004/manifest.json');
const oldManifest = JSON.parse(fs.readFileSync(oldManifestPath));
const oldRecordsDir = path.join(root, 'eval/labels/assistant-content-351-20261004/records');
const oldFiles = fs.readdirSync(oldRecordsDir).filter(name => name.endsWith('.json')).sort();
const oldReviews = oldFiles.map(name => ({ name, record: JSON.parse(fs.readFileSync(path.join(oldRecordsDir, name))).record }));
const oldBvids = new Set(oldManifest.records.map(row => row.bvid));
const oldCids = new Set(oldManifest.records.map(row => String(row.cid)));
const reviewedBvids = new Set(oldReviews.map(row => row.record.bvid));
const reviewedCids = new Set(oldReviews.map(row => String(row.record.cid)));
const rows = [];
const blankLines = [];
let start = 0, lineNumber = 1;
for (let cursor = 0; cursor <= bytes.length; cursor++) {
  if (cursor < bytes.length && bytes[cursor] !== 10) continue;
  if (cursor === bytes.length && start === bytes.length) break;
  const line = bytes.subarray(start, cursor);
  if (line.toString('utf8').trim() === '') blankLines.push(lineNumber);
  else {
    const row = JSON.parse(line.toString('utf8'));
    const acquisition = row.acquisition || {};
    rows.push({
      inputLine: lineNumber, inputLineSha256: hash(line), bvid: row.bvid, cid: row.cid,
      duration: row.duration, page: row.page ?? null,
      validBvid: /^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(row.bvid),
      validCid: Number.isSafeInteger(row.cid) && row.cid > 0,
      validDuration: Number.isFinite(row.duration) && row.duration > 0,
      subtitleEntries: Array.isArray(row.subtitles) ? row.subtitles.length : 0,
      subtitleCharacters: Array.isArray(row.subtitles) ? row.subtitles.reduce((sum, item) => sum + String(item.content ?? item.text ?? '').length, 0) : 0,
      metadataStatus: acquisition.metadata ?? null,
      subtitleStatus: acquisition.subtitles ?? null,
      subtitleReason: acquisition.subtitleReason ?? null,
      capturedAt: acquisition.capturedAt ?? null,
      acquisitionMethod: acquisition.method ?? null,
      metadataError: acquisition.error ?? null,
      presentInOriginal351: oldBvids.has(row.bvid) || oldCids.has(String(row.cid)),
      presentInOld250Reviews: reviewedBvids.has(row.bvid) || reviewedCids.has(String(row.cid)),
    });
  }
  start = cursor + 1;
  lineNumber++;
}
const duplicates = key => {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    groups.set(value, [...(groups.get(value) || []), row.inputLine]);
  }
  return [...groups].filter(([, lines]) => lines.length > 1).map(([value, inputLines]) => ({ value, inputLines }));
};
const tally = key => rows.reduce((counts, row) => { const value = String(row[key]); counts[value] = (counts[value] || 0) + 1; return counts; }, {});
const refs = Object.fromEntries(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads').split('\n').filter(Boolean).map(line => line.split(' ')));
const output = {
  kind: 'assistant-extra300-initial-input-audit', createdAt: new Date().toISOString(),
  source: rel(input), sourceSha256: hash(bytes), sourceBytes: bytes.length,
  rawLineHashDefinition: 'SHA-256 of exact original UTF-8 line bytes excluding LF; no parsed JSON normalization; any CR is retained.',
  policy: 'Metadata-only integrity audit, not content review. Missing subtitles do not imply no advertisement. No algorithm evaluation.',
  git: { branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), statusPorcelainAtAudit: git('status', '--porcelain'), refs },
  comparisonSources: {
    original351Manifest: rel(oldManifestPath), original351ManifestSha256: hash(fs.readFileSync(oldManifestPath)),
    original351Count: oldManifest.records.length, oldReviewCount: oldReviews.length,
    oldReviewFiles: oldFiles.map(name => { const file = path.join(oldRecordsDir, name); return { path: rel(file), sha256: hash(fs.readFileSync(file)) }; }),
  },
  summary: {
    expectedVideoCount: 300, videoCount: rows.length, countMatchesExpected: rows.length === 300,
    uniqueBvidCount: new Set(rows.map(row => row.bvid)).size,
    uniqueCidCount: new Set(rows.map(row => row.cid)).size,
    subtitleAvailableCount: rows.filter(row => row.subtitleEntries > 0).length,
    subtitleMissingCount: rows.filter(row => row.subtitleEntries === 0).length,
    metadataStatusCounts: tally('metadataStatus'), subtitleStatusCounts: tally('subtitleStatus'),
    invalidBvids: rows.filter(row => !row.validBvid).map(row => row.bvid),
    invalidCids: rows.filter(row => !row.validCid).map(row => ({ bvid: row.bvid, cid: row.cid })),
    invalidDurations: rows.filter(row => !row.validDuration).map(row => row.bvid),
    duplicateBvids: duplicates(row => row.bvid), duplicateCids: duplicates(row => String(row.cid)),
    duplicateIdentities: duplicates(row => `${row.bvid}:${row.cid}`), duplicateRawRecords: duplicates(row => row.inputLineSha256),
    overlapsOriginal351: rows.filter(row => row.presentInOriginal351).map(row => row.bvid),
    overlapsOld250: rows.filter(row => row.presentInOld250Reviews).map(row => row.bvid), blankLines,
  },
  records: rows,
};
fs.writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ file: rel(target), sourceSha256: output.sourceSha256, summary: output.summary }, null, 2));

#!/usr/bin/env node
'use strict';
// Frozen assistant content references are an audit, not human ground truth.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { reference, score, actualSeeks, aggregate } = require('./audit-content-review.cjs');
const { loadProduction, runVideo } = require('./runner.cjs');
const { detectorInput, normalizeReplay } = require('./evaluate-segments.cjs');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const defaultDir = 'eval/labels/assistant-content-351-20261004';
const RELEASE_BASELINE = '3ce86faffab16a881640fc27dea5f53bf7b219ee';

function loadReferences(directory, { frozen = true } = {}) {
  const manifestFile = path.join(directory, 'manifest.json'), manifest = read(manifestFile);
  if (hash(manifest.source) !== manifest.sourceSha256) throw new Error('Source corpus changed');
  if (new Set(manifest.records.map(r => r.bvid)).size !== manifest.records.length) throw new Error('Duplicate manifest video');
  const sources = new Map(jsonl(manifest.source).map(r => [r.bvid, r]));
  if (sources.size !== manifest.records.length) throw new Error('Manifest does not cover the full corpus');
  const freezeFile = path.join(directory, 'freeze.json');
  const freeze = frozen ? read(freezeFile) : null;
  if (freeze && (freeze.manifestSha256 !== hash(manifestFile) || freeze.sourceSha256 !== hash(manifest.source))) throw new Error('Frozen manifest/source changed');
  const rows = [], missing = [], files = [];
  for (const item of manifest.records) {
    const source = sources.get(item.bvid);
    if (!source || source.cid !== item.cid || source.duration !== item.duration) throw new Error(`Identity mismatch: ${item.bvid}`);
    const file = path.join(directory, 'records', `${item.bvid}.json`);
    if (!source.subtitles?.length) {
      // Acquisition failure/empty captions never imply no advertisement.
      missing.push({ bvid: item.bvid, cid: item.cid, split: item.split, reason: item.acquisition });
      continue;
    }
    if (!fs.existsSync(file)) throw new Error(`Content review still pending: ${item.bvid}`);
    const wrapper = read(file), review = wrapper.record;
    if (wrapper.kind !== 'assistant-content-review' || wrapper.algorithmPredictionsSeen !== false || review?.bvid !== item.bvid) throw new Error(`Invalid blind review: ${item.bvid}`);
    const sha256 = hash(file);
    if (freeze && !freeze.files.some(f => f.path === file && f.sha256 === sha256)) throw new Error(`Frozen review changed: ${item.bvid}`);
    files.push({ path: file, sha256 });
    rows.push({ item, source, review, ref: reference(review, source) });
  }
  if (freeze && freeze.files.length !== files.length) throw new Error('Frozen review count changed');
  return { manifest, rows, missing, files, manifestFile };
}

function freezeReferences(directory) {
  const state = loadReferences(directory, { frozen: false });
  const filename = path.join(directory, 'freeze.json');
  if (fs.existsSync(filename)) throw new Error('Reference freeze already exists; do not overwrite');
  const freeze = { kind: 'assistant-full-content-reference-freeze', frozenAt: new Date().toISOString(),
    sourceSha256: state.manifest.sourceSha256, manifestSha256: hash(state.manifestFile), files: state.files,
    inputVideos: state.manifest.records.length, reviewedVideos: state.rows.length, missingSourceVideos: state.missing.length,
    limitations: ['Cached AI subtitle review by assistants, not independent human or audiovisual verification.',
      'All unobserved content and subtitle gaps remain unknown. Missing sources never count as negatives.',
      'Prospective author validation within a previously used corpus; not an untouched population holdout.'] };
  fs.writeFileSync(filename, JSON.stringify(freeze, null, 2) + '\n');
  return { filename, inputVideos: freeze.inputVideos, reviewedVideos: freeze.reviewedVideos, missingSourceVideos: freeze.missingSourceVideos };
}

async function evaluate(directory, split, output, sourceDir, baseline = RELEASE_BASELINE) {
  if (!['development', 'validation', 'all'].includes(split)) throw new Error('Choose development, validation or all');
  // The frozen manifest records historical provenance, not the baseline for a new run.
  const state = loadReferences(directory), before = loadProduction(baseline);
  const current = loadProduction(null, sourceDir ? { sourceDir } : {});
  const rows = [], selected = state.rows.filter(r => split === 'all' || r.item.split === split);
  for (const { item, source, review, ref } of selected) {
    const row = { bvid: item.bvid, cid: item.cid, split: item.split, title: source.title,
      adPresence: review.adPresence, referenceSegments: review.segments };
    for (const [variant, production] of Object.entries({ before, current })) {
      const replay = normalizeReplay(source, await runVideo(detectorInput(source), production));
      row[variant] = { replay, automatic: score(ref, actualSeeks(replay, source.duration)), candidates: score(ref, replay.candidates) };
    }
    rows.push(row);
  }
  const grouped = Object.fromEntries(['before', 'current'].map(v => [v,
    Object.fromEntries(['automatic', 'candidates'].map(mode => [mode, aggregate(rows, v, mode)]))]));
  const result = { kind: 'assistant-full-content-reference-agreement', createdAt: new Date().toISOString(), split,
    hashes: { source: state.manifest.sourceSha256, manifest: hash(state.manifestFile), freeze: hash(path.join(directory, 'freeze.json')),
      before: before.sourceSha256, current: current.sourceSha256 },
    inventory: { inputVideos: state.manifest.records.length, reviewedVideos: state.rows.length, missingSourceVideos: state.missing.length, scoredVideos: rows.length },
    limitations: read(path.join(directory, 'freeze.json')).limitations, grouped, rows };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return { output, inventory: result.inventory, grouped, hashes: result.hashes };
}

if (require.main === module) {
  const [action, split = 'development', output = 'eval/output/content-audit-351-20261004/development.json', sourceDir, baseline] = process.argv.slice(2);
  Promise.resolve().then(() => action === 'freeze' ? freezeReferences(defaultDir)
    : action === 'check' ? (() => { const x = loadReferences(defaultDir); return { reviewed: x.rows.length, missing: x.missing.length }; })()
    : action === 'evaluate' ? evaluate(defaultDir, split, output, sourceDir, baseline) : Promise.reject(new Error('Use check, freeze or evaluate [split] [output] [source-dir] [baseline-ref]')))
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { loadReferences, freezeReferences, evaluate, RELEASE_BASELINE };

#!/usr/bin/env node
'use strict';
// Prepare a NEW review input from saved replay output. No detector or model runs.
const fs = require('node:fs');
const path = require('node:path');
const { readDataset, validateRecord, sourceAvailability } = require('../dataset.cjs');
const { validateLabels } = require('../labels/validate.cjs');
const C = require('./core.js');

const defaults = {
  results: path.resolve(__dirname, '../output/segment-v1/per-video.jsonl'),
  labels: path.resolve(__dirname, '../labels/assistant-seed-v2.json')
};
const sameRange = (a, b) => a.start === b.start && a.end === b.end;
function index(records, name) {
  const lookup = new Map();
  for (const record of records) {
    if (!record?.bvid || !record.cid) throw new Error(`${name}: BV/CID identity required`);
    const key = C.key(record);
    if (lookup.has(key)) throw new Error(`${name}: duplicate identity ${key}`);
    lookup.set(key, record);
  }
  return lookup;
}
function requireAssistant(labels) {
  if (labels?.kind !== 'assistant-provisional') throw new Error('Only assistant-provisional labels are allowed; human review must stay separate');
  validateLabels(labels);
  for (const value of [labels, ...labels.records, ...labels.records.flatMap(record => record.segments)]) {
    if ((value.labelSource != null && value.labelSource !== 'assistant')
      || (value.origin != null && value.origin !== 'assistant')) throw new Error('Human or mixed provenance cannot become assistant drafts');
  }
}
function checkDuration(value, record, name, required = true) {
  if (!required && value.duration == null) return;
  if (!Number.isFinite(value.duration) || Math.abs(value.duration - record.duration) > 0.001) {
    throw new Error(`${name}: duration mismatch for ${C.key(record)}`);
  }
}
function prediction(saved, name) {
  if (!saved || !Array.isArray(saved.candidates) || !Array.isArray(saved.automaticSegments)) {
    throw new Error(`${name}: saved candidates and automaticSegments arrays are required`);
  }
  if (saved.automaticSegments.some(segment => !saved.candidates.some(candidate => sameRange(candidate, segment)))) {
    throw new Error(`${name}: automatic interval is not a saved candidate`);
  }
  return {
    available: true, automatic: saved.automaticSegments.length > 0, predictionMode: 'saved-runtime-replay',
    segments: saved.candidates.map(candidate => {
      const automatic = saved.automaticSegments.some(segment => sameRange(candidate, segment));
      // The review UI always asks for human confirmation. Its automatic flag
      // describes an observed replay action, not permission to accept a draft.
      return { ...candidate, confidence: candidate.confidence === 'high' ? 'high' : 'uncertain',
        automatic, requiresConfirmation: !automatic };
    })
  };
}
function makeBundle(corpus, results, labels, { generatedAt = new Date().toISOString() } = {}) {
  requireAssistant(labels);
  const corpusByKey = index(corpus, 'corpus'), resultsByKey = index(results, 'results');
  const labelsByKey = index(labels.records, 'labels');
  const corpusBvids = new Set(corpus.map(record => record.bvid));
  for (const [key, label] of labelsByKey) {
    if (corpusBvids.has(label.bvid) && !corpusByKey.has(key)) throw new Error(`labels: BV/CID identity mismatch for ${key}`);
  }
  const records = [];
  let skippedUnavailable = 0;
  for (const record of corpus) {
    const key = C.key(record), saved = resultsByKey.get(key);
    if (!saved) {
      if (results.some(value => value.bvid === record.bvid)) throw new Error(`results: BV/CID identity mismatch for ${key}`);
      if (!sourceAvailability(record).replayEligible) { skippedUnavailable++; continue; }
      throw new Error(`Missing saved replay for ${key}; generate evaluation results first`);
    }
    validateRecord(record);
    C.identity(record);
    checkDuration(saved, record, 'results');
    const label = labelsByKey.get(key);
    if (label) checkDuration(label, record, 'labels', false);
    const predictions = Object.fromEntries(['model', 'topics', 'rules', 'legacy'].map(source => [source, { available: false, segments: [] }]));
    predictions.conservative = prediction(saved.before, `${key} before`);
    predictions.pipeline = prediction(saved.current, `${key} current`);
    records.push({ bvid: record.bvid, cid: record.cid, title: record.title, duration: record.duration,
      creator: record.creator, page: record.page, subtitles: record.subtitles || [],
      split: record.evaluationSplit?.split || (typeof record.evaluationSplit === 'string' ? record.evaluationSplit : record.split) || saved.cohort || 'unknown',
      predictions, assistantSegments: label?.segments || [] });
    // Deliberately do not copy saved.humanSegments or corpus.annotations.
  }
  return { bundle: C.normalizeBundle({ schemaVersion: 1, kind: 'review-bundle', modelSha256: null, generatedAt, records }), skippedUnavailable };
}
function prepare(options) {
  if (!options.input || !options.out) throw new Error('--input and --out are required; use a new output path');
  const results = options.results || defaults.results, labels = options.labels || defaults.labels;
  const output = path.resolve(options.out);
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing file: ${output}`);
  const { bundle, skippedUnavailable } = makeBundle(readDataset(options.input), readDataset(results), JSON.parse(fs.readFileSync(labels, 'utf8')));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
  return { output, videos: bundle.records.length, skippedUnavailable,
    assistantSegments: bundle.records.reduce((sum, record) => sum + record.assistantSegments.length, 0) };
}
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (!['--input', '--results', '--labels', '--out'].includes(argument) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node eval/review/prepare.cjs --input corpus.jsonl --out NEW-review-bundle.json [--results per-video.jsonl] [--labels assistant.json]');
    }
    if (options[argument.slice(2)]) throw new Error(`Repeated option: ${argument}`);
    options[argument.slice(2)] = args[++i];
  }
  if (!options.input || !options.out) throw new Error('--input and --out are required; existing bundles must not be overwritten');
  return options;
}
if (require.main === module) {
  try { console.log(JSON.stringify(prepare(parse(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { makeBundle, prepare, parse };

#!/usr/bin/env node
'use strict';
// Fit the line-level "pitch-likeness" table used by scr/ad-signals.js to place
// ad boundaries. Labels are used here, offline, and never reach the detector at
// run time. Training reads the development split only; validation stays unseen.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadBenchmark } = require('./content-benchmark.cjs');

const DEFAULTS = Object.freeze({ minAuthors: 4, keep: 4000, epochs: 6, l2: 2e-5, rate: 0.15, adWeight: 4, unit: 0.1 });

function loadFeatures(sourceDir) {
  // One definition of a feature: the production module's own.
  return require(path.resolve(sourceDir, 'ad-signals.js')).lineFeatures;
}

function examples(rows, lineFeatures) {
  const inside = (line, ranges) => ranges.some(range => line.from >= range.start - 0.05 && line.to <= range.end + 0.05);
  return rows.map(row => ({ author: row.item.author, lines: row.source.subtitles.map(line => ({
    features: [...lineFeatures(line.content)],
    // 1 = reviewed should-skip ad, 0 = reviewed keep, -1 = unknown (not trained on).
    label: inside(line, row.ref.skip) ? 1 : inside(line, row.review.normalSpeechRanges || []) ? 0 : -1
  })).filter(line => line.label >= 0) }));
}

function fit(videos, vocabulary, options) {
  const index = new Map(vocabulary.map((feature, i) => [feature, i]));
  const weights = new Float64Array(vocabulary.length);
  let bias = -2;
  const samples = videos.flatMap(video => video.lines.map(line => ({ label: line.label,
    ids: line.features.map(feature => index.get(feature)).filter(id => id !== undefined) })));
  // Fixed-seed shuffle: the same inputs always produce the same table.
  let seed = 12345;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let epoch = 0; epoch < options.epochs; epoch++) {
    for (let i = samples.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [samples[i], samples[j]] = [samples[j], samples[i]];
    }
    const rate = options.rate / (1 + epoch);
    for (const sample of samples) {
      let logit = bias;
      for (const id of sample.ids) logit += weights[id];
      const gradient = (1 / (1 + Math.exp(-logit)) - sample.label) * (sample.label ? options.adWeight : 1);
      bias -= rate * gradient * 0.1;
      for (const id of sample.ids) weights[id] -= rate * (gradient + options.l2 * weights[id]);
    }
  }
  return { bias, weights: new Map(vocabulary.map((feature, i) => [feature, weights[i]])) };
}

function train(videos, overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  const support = new Map();
  for (const video of videos) for (const line of video.lines) for (const feature of line.features) {
    let entry = support.get(feature);
    if (!entry) support.set(feature, entry = { authors: new Set(), lines: 0 });
    entry.authors.add(video.author); entry.lines++;
  }
  // A phrase heard from one creator is a habit, not evidence about ads in general.
  let vocabulary = [...support].filter(([, entry]) => entry.authors.size >= options.minAuthors).map(([feature]) => feature).sort();
  let model = fit(videos, vocabulary, options);
  if (options.keep && options.keep < vocabulary.length) {
    const influence = feature => Math.abs(model.weights.get(feature)) * Math.sqrt(support.get(feature).lines);
    vocabulary = vocabulary.sort((a, b) => influence(b) - influence(a) || (a < b ? -1 : 1)).slice(0, options.keep).sort();
    model = fit(videos, vocabulary, options);
  }
  return { ...model, options, lines: videos.reduce((total, video) => total + video.lines.length, 0), videos: videos.length };
}

function serialize(model, provenance) {
  const { unit } = model.options, pairs = new Map(), words = {};
  for (const [feature, weight] of [...model.weights].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const quantized = Math.round(weight / unit);
    if (!quantized) continue;
    if (/^[a-z]+$/.test(feature)) words[feature] = quantized;
    else if (feature.length === 2) pairs.set(quantized, (pairs.get(quantized) || '') + feature);
    else throw new Error(`Unexpected feature shape: ${feature}`);
  }
  const body = { version: 1, bias: Math.round(model.bias * 1000) / 1000, unit,
    pairs: Object.fromEntries([...pairs].sort((a, b) => a[0] - b[0])), words };
  const featureCount = [...pairs.values()].reduce((total, text) => total + text.length / 2, 0) + Object.keys(words).length;
  return ['// == BiliSmartSkip: generated pitch-likeness table ==',
    '// Do not edit by hand. Regenerate on test-branch with eval/train-pitch-model.cjs.',
    '// Each two-character pair (or Latin word) seen in a subtitle line adds its weight',
    '// (in `unit` logits) to that line; positive lines read like a sponsor pitch.',
    '// ad-signals.js uses the total only to place the first and last line of a',
    '// passage that rules have already identified as an ad.',
    `// Provenance: ${JSON.stringify({ ...provenance, features: featureCount })}`,
    `const BILI_PITCH_MODEL = Object.freeze(${JSON.stringify(body)});`, ''].join('\n');
}

function trainingRows(state, split = 'development') {
  return state.rows.filter(row => row.item.split === split);
}

if (require.main === module) {
  const [sourceDir, output = path.join(sourceDir || '', 'pitch-model.js')] = process.argv.slice(2);
  if (!sourceDir) { console.error('Usage: node eval/train-pitch-model.cjs <algorithm scr directory> [output file]'); process.exit(1); }
  const state = loadBenchmark(), rows = trainingRows(state);
  const model = train(examples(rows, loadFeatures(sourceDir)));
  const text = serialize(model, { benchmark: state.manifestSha256.slice(0, 16), split: 'development',
    videos: model.videos, lines: model.lines, options: model.options });
  fs.writeFileSync(output, text);
  console.log(JSON.stringify({ output, bytes: Buffer.byteLength(text), videos: model.videos, lines: model.lines,
    sha256: createHash('sha256').update(text).digest('hex') }, null, 2));
}
module.exports = { DEFAULTS, loadFeatures, examples, fit, train, serialize, trainingRows };

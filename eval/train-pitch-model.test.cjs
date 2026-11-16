'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceDir = require('../tests/source-directory.cjs');
const { loadBenchmark } = require('./content-benchmark.cjs');
const { DEFAULTS, loadFeatures, examples, train, serialize, trainingRows } = require('./train-pitch-model.cjs');
const { FOLDS, foldOf, automatic } = require('./cross-validate-pitch-model.cjs');

// The table belongs to the branch under test; sources that predate it skip
// the checks that need it.
const hasTable = fs.existsSync(path.join(sourceDir, 'ad-signals.js')) && fs.existsSync(path.join(sourceDir, 'pitch-model.js'));
const skip = hasTable ? false : 'source directory has no pitch table';
const parse = text => vm.runInNewContext(`${text}; BILI_PITCH_MODEL`);

const synthetic = () => Array.from({ length: 8 }, (_, author) => ({ author: `creator-${author}`, lines: [
  ...Array.from({ length: 30 }, () => ({ features: ['按摩', '热敷', '下单', 'sale'], label: 1 })),
  ...Array.from({ length: 30 }, () => ({ features: ['战役', '皇帝', '下单'], label: 0 })),
  { features: [`口头禅${author}`], label: 1 }
] }));

test('training is deterministic and learns which features belong to a pitch', () => {
  const first = train(synthetic(), { keep: 0 }), second = train(synthetic(), { keep: 0 });
  assert.deepEqual([...first.weights], [...second.weights]);
  assert.equal(first.bias, second.bias);
  assert.ok(first.weights.get('按摩') > 0.5 && first.weights.get('sale') > 0.5);
  assert.ok(first.weights.get('战役') < -0.5);
  assert.ok(Math.abs(first.weights.get('下单')) < Math.abs(first.weights.get('按摩')), 'a word used on both sides carries little weight');
});

test('a phrase heard from too few creators is left out', () => {
  const model = train(synthetic(), { keep: 0 });
  assert.equal([...model.weights.keys()].some(feature => feature.startsWith('口头禅')), false);
  assert.equal(train(synthetic(), { keep: 0, minAuthors: 9 }).weights.size, 0);
});

test('pruning keeps the most influential features and refits on them', () => {
  const model = train(synthetic(), { keep: 2 });
  assert.equal(model.weights.size, 2);
  assert.ok(model.weights.has('按摩') || model.weights.has('热敷') || model.weights.has('战役'));
});

test('the serialized table is valid JavaScript that the production module scores with', { skip }, () => {
  const model = train(synthetic(), { keep: 0 });
  const text = serialize(model, { note: 'test' });
  assert.match(text, /^\/\/ == BiliSmartSkip: generated pitch-likeness table ==/);
  const table = parse(text);
  assert.equal(table.unit, DEFAULTS.unit);
  for (const [weight, pairs] of Object.entries(table.pairs)) {
    assert.ok(Number.isInteger(Number(weight)) && Number(weight) !== 0);
    assert.equal(pairs.length % 2, 0);
  }
  const signals = require(path.join(sourceDir, 'ad-signals.js'));
  const [pitch, story] = signals.scoreLines([{ from: 0, to: 2, content: '按摩热敷' }, { from: 2, to: 4, content: '战役皇帝' }], 60, table);
  assert.ok(pitch.score > 0 && story.score < 0);
  // Quantised weights reproduce the fitted ones to within half a unit.
  const expected = model.bias + ['按摩', '摩热', '热敷'].reduce((sum, feature) => sum + (model.weights.get(feature) || 0), 0);
  assert.ok(Math.abs(Math.min(4, expected) + 0.3 - pitch.score) <= 3 * DEFAULTS.unit / 2 + 1e-3);
});

test('training examples use reviewed lines only and never the validation split', { skip }, () => {
  const state = loadBenchmark(), rows = trainingRows(state);
  assert.equal(rows.length, state.counts.development);
  assert.ok(rows.every(row => row.item.split === 'development'));
  const validation = new Set(state.rows.filter(row => row.item.split === 'validation').map(row => row.item.author));
  assert.equal(rows.some(row => validation.has(row.item.author)), false, 'validation creators are disjoint from training');
  const [video] = examples(rows.slice(0, 1), loadFeatures(sourceDir));
  assert.ok(video.lines.every(line => line.label === 0 || line.label === 1));
  assert.ok(video.lines.length <= rows[0].source.subtitles.length);
});

test('the shipped table is exactly what the frozen development split produces', { skip }, () => {
  const state = loadBenchmark();
  const model = train(examples(trainingRows(state), loadFeatures(sourceDir)));
  const text = serialize(model, { benchmark: state.manifestSha256.slice(0, 16), split: 'development',
    videos: model.videos, lines: model.lines, options: model.options });
  assert.equal(fs.readFileSync(path.join(sourceDir, 'pitch-model.js'), 'utf8'), text,
    'regenerate with: node eval/train-pitch-model.cjs <branch>');
});

test('cross-validation keeps every creator on one side of each fold', () => {
  const authors = Array.from({ length: 200 }, (_, index) => `creator-${index}`);
  const folds = authors.map(foldOf);
  assert.ok(folds.every(fold => Number.isInteger(fold) && fold >= 0 && fold < FOLDS));
  assert.deepEqual(authors.map(foldOf), folds, 'assignment is stable');
  assert.equal(new Set(folds).size, FOLDS);
});

test('automatic tally separates correct, inside-the-ad and kept-content seeks', () => {
  const marking = (start, end, status) => ({ start, end, status });
  const tally = automatic([{ versions: { current: {
    markings: [marking(10, 40, 'correct'), marking(100, 130, 'partial-or-boundary'), marking(200, 230, 'wrong-keep'), marking(300, 330, 'correct')],
    automaticSegments: [{ start: 10, end: 40 }, { start: 100, end: 130 }, { start: 200, end: 230 }]
  } } }]);
  assert.deepEqual(tally, { segments: 3, correct: 1, insideAd: 1, wrongKeep: 1, unknown: 0 });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { coverage, aggregateCoverage } = require('./coverage.cjs');
const label = (start, end, kind, extra = {}) => ({ start, end, label: kind,
  confidence: 'high', boundaryConfidence: 'high', ...extra });

test('short CTA fragment loses measured ad seconds and complete interval recall', () => {
  const labels = [label(20, 100, 'ad'), label(100, 140, 'normal')];
  const full = aggregateCoverage([coverage(labels, [{ start: 20, end: 100 }], 200)]);
  const short = aggregateCoverage([coverage(labels, [{ start: 80, end: 95 }], 200)]);
  assert.equal(full.adSecondsRecall, 1);
  assert.equal(short.adSecondsRecall, 15 / 80);
  assert.equal(short.ad90CoverageRate, 0);
  assert.equal(short.labelledSecondsPrecision, 1);
  assert.equal(full.labelledSecondsPrecision, 1);
});

test('unknown seconds are unscored, explicit normal time is counted, overlapping predictions deduplicate', () => {
  const result = coverage([label(20, 40, 'ad'), label(50, 60, 'normal')],
    [{ start: 10, end: 55 }, { start: 25, end: 65 }], 100);
  assert.equal(result.coveredAdSeconds, 20);
  assert.equal(result.coveredNormalSeconds, 10);
  assert.equal(result.unlabelledPredictionSeconds, 25);
});

test('unreviewed and uncertain boundaries cannot become evaluation gold or negatives', () => {
  const result = aggregateCoverage([coverage([label(20, 40, 'ad', { boundaryConfidence: 'uncertain' })],
    [{ start: 20, end: 40 }], 100)]);
  assert.equal(result.adSecondsRecall, 1);
  assert.equal(result.ad90CoverageRate, null);
  assert.equal(result.boundaryErrors.matches, 0);
  assert.equal(result.unlabelledPredictionSeconds, 10);
  const uncertain = aggregateCoverage([coverage([label(20, 40, 'ad', { confidence: 'uncertain' })], [], 100)]);
  assert.equal(uncertain.adSecondsRecall, null);
});

test('invalid or contradictory labels fail instead of improving metrics', () => {
  assert.throws(() => coverage([label(20, 40, 'ad'), label(30, 60, 'normal')], [], 100), /Contradictory/);
  assert.throws(() => coverage([], [{ start: 50, end: 101 }], 100), /Invalid/);
});

const decision = (start, end, skipDecision, contentType = 'ad', more = {}) => ({ start, end,
  contentType, contentConfidence: 'high', skipDecision, skipConfidence: 'high', boundaryConfidence: 'high', ...more });

test('commercial keep is a false-positive target while commercial skip is a true-positive target', () => {
  const result = coverage([decision(10, 20, 'skip'), decision(30, 40, 'keep'),
    decision(50, 60, 'uncertain', 'non_ad', { skipConfidence: 'uncertain' })], [{ start: 0, end: 70 }], 100);
  assert.equal(result.coveredAdSeconds, 10); assert.equal(result.coveredNormalSeconds, 10);
  assert.equal(result.unlabelledPredictionSeconds, 50); assert.equal(result.target, 'skipDecision');
});

test('content uncertainty and misleading notes never change explicit skip confidence or boundaries', () => {
  const labels = [decision(0, 2.32, 'keep', 'uncertain', { contentConfidence: 'uncertain', reason: '应该跳过' }),
    decision(10, 20, 'skip', 'ad', { reason: '无需跳过' })];
  const result = coverage(labels, [{ start: 0, end: 2.32 }, { start: 10, end: 20 }], 100);
  assert.equal(result.coveredNormalSeconds, 2.32); assert.equal(result.coveredAdSeconds, 10);
  assert.equal(result.adSegments, 1);
});

test('time-weighted classification metrics score only known skip/keep seconds', () => {
  const result = aggregateCoverage([coverage([decision(10, 20, 'skip'), decision(30, 40, 'keep')],
    [{ start: 10, end: 16 }, { start: 30, end: 34 }, { start: 70, end: 80 }], 100)]);
  assert.deepEqual(result.skipMetrics, { target: 'skipDecision', unit: 'seconds', knownSeconds: 20,
    truePositiveSeconds: 6, falsePositiveSeconds: 4, falseNegativeSeconds: 4, trueNegativeSeconds: 6,
    precision: 0.6, recall: 0.6, f1: 0.6, accuracy: 0.6, specificity: 0.6, unknownPredictionSeconds: 10 });
  const unknown = aggregateCoverage([coverage([decision(0, 10, 'uncertain', 'non_ad', { skipConfidence: 'uncertain' })], [], 100)]);
  for (const field of ['precision', 'recall', 'f1', 'accuracy', 'specificity']) assert.equal(unknown.skipMetrics[field], null);
});

test('content disagreement is independent from contradictory skip/keep decisions', () => {
  const bothKeep = coverage([decision(10, 20, 'keep', 'ad'), decision(10, 20, 'keep', 'non_ad')], [], 100);
  assert.equal(bothKeep.labelledNormalSeconds, 10);
  assert.throws(() => coverage([decision(10, 20, 'skip', 'ad'), decision(10, 20, 'keep', 'ad')], [], 100), /Contradictory skip\/keep/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reference, score, actualSeeks } = require('./audit-content-review.cjs');

// Synthetic fixtures only: these tests never open content labels or replay data.
const source = (subtitles, duration = 30) => ({
  bvid: 'synthetic-video', cid: 1, duration,
  subtitles: subtitles.map(([from, to]) => ({ from, to, content: 'Fixture speech' }))
});
const segment = (start, end, skipDecision = 'skip', options = {}) => ({
  start, end, contentType: 'ad', skipDecision, confidence: 'high', ...options
});
const review = (segments = [], normalSpeechRanges = [], duration = 30) => ({
  bvid: 'synthetic-video', cid: 1, duration, fullTranscriptRead: true,
  segments, normalSpeechRanges
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `Expected ${actual} to equal ${expected}`);

test('unreviewed speech and subtitle gaps remain unknown, including gaps inside a normal range', () => {
  const ref = reference(review([], [{ start: 0, end: 10 }]),
    source([[0, 2], [4, 6], [8, 10], [12, 14]]));
  const result = score(ref, [{ start: 0, end: 14 }]);
  near(result.reviewedKeepSpeechSeconds, 6);
  near(result.coveredKeepSpeechSeconds, 6);
  near(result.unknownPredictionSeconds, 8);
  near(result.coveredSkipSpeechSeconds, 0);
  assert.deepEqual(result.segmentCoverage, []);
});

test('complete ad coverage still reports every second of extra skipped main speech', () => {
  const ref = reference(review([segment(4, 10)],
    [{ start: 0, end: 4 }, { start: 10, end: 16 }]), source([[0, 16]]));
  const result = score(ref, [{ start: 0, end: 16 }]);
  assert.equal(result.segmentCoverage[0].complete, true);
  near(result.segmentCoverage[0].bestSingleCoverage, 1);
  near(result.coveredSkipSpeechSeconds, 6);
  near(result.coveredKeepSpeechSeconds, 10);
  near(result.predictions[0].keepSpeechSeconds, 10);
  near(result.unknownPredictionSeconds, 0);
});

test('subtitle-only speech recall does not replace full ad-span completeness', () => {
  const ref = reference(review([segment(4, 10)]), source([[6, 8]]));
  const result = score(ref, [{ start: 6, end: 8 }]);
  near(result.coveredSkipSpeechSeconds, 2);
  near(result.missedSkipSpeechSeconds, 0);
  assert.equal(result.segmentCoverage[0].complete, false);
  near(result.segmentCoverage[0].bestSingleCoverage, 1 / 3);
});

test('recorded end + 0.05 seek is scored against main speech after the ad', () => {
  const ref = reference(review([segment(10, 20)], [{ start: 20, end: 30 }]),
    source([[10, 20], [20, 30]]));
  const replay = { automaticSegments: [{ start: 10, end: 20 }], seekDestinations: [20.05] };
  const seeks = actualSeeks(replay, 30);
  assert.deepEqual(seeks, [{ start: 10, end: 20.05 }]);
  const actual = score(ref, seeks);
  const candidate = score(ref, replay.automaticSegments);
  near(actual.coveredKeepSpeechSeconds, 0.05);
  near(actual.predictedSeconds, 10.05);
  near(candidate.coveredKeepSpeechSeconds, 0);
  assert.equal(actual.segmentCoverage[0].complete, true);
});

test('actual seeks use recorded destinations independently of order and require a one-to-one match', () => {
  assert.deepEqual(actualSeeks({
    automaticSegments: [{ start: 2, end: 4 }, { start: 8, end: 10 }],
    seekDestinations: [10.05, 4.05]
  }, 30), [{ start: 2, end: 4.05 }, { start: 8, end: 10.05 }]);
  assert.throws(() => actualSeeks({
    automaticSegments: [{ start: 2, end: 4 }], seekDestinations: []
  }, 30), /missing.*actual seek/i);
  assert.throws(() => actualSeeks({
    automaticSegments: [{ start: 2, end: 4 }], seekDestinations: [4.05, 8.05]
  }, 30), /unmatched actual seek/i);
});

test('uncertain ad identity with an explicit confident keep decision is scored as keep', () => {
  const ref = reference(review([
    segment(2, 6, 'keep', { contentType: 'uncertain' }),
    segment(8, 10, 'uncertain', { contentType: 'uncertain', confidence: 'uncertain' })
  ]), source([[2, 6], [8, 10]]));
  const result = score(ref, [{ start: 2, end: 10 }]);
  near(result.reviewedKeepSpeechSeconds, 4);
  near(result.coveredKeepSpeechSeconds, 4);
  near(result.coveredSkipSpeechSeconds, 0);
  near(result.unknownPredictionSeconds, 4);
});

test('conflicting decisions and duplicate or overlapping skip segments are rejected', async t => {
  for (const [name, segments, normal] of [
    ['skip versus keep', [segment(2, 6)], [{ start: 5, end: 8 }]],
    ['skip versus uncertain', [segment(2, 6), segment(5, 8, 'uncertain')], []],
    ['duplicate skip', [segment(2, 6), segment(2, 6)], []],
    ['overlapping skip', [segment(2, 6), segment(5, 8)], []],
    ['sub-millisecond skip versus keep', [segment(2, 6)], [{ start: 5.9995, end: 8 }]]
  ]) {
    await t.test(name, () => assert.throws(() => reference(review(segments, normal), source([[0, 10]]))));
  }
});

test('normal ranges may duplicate an explicit keep segment without double-counting speech', () => {
  const ref = reference(review([segment(2, 6, 'keep', { contentType: 'uncertain' })],
    [{ start: 2, end: 6 }]), source([[2, 6]]));
  const result = score(ref, [{ start: 2, end: 6 }]);
  near(result.reviewedKeepSpeechSeconds, 4);
  near(result.coveredKeepSpeechSeconds, 4);
  near(result.unknownPredictionSeconds, 0);
});

test('adjacent ad and normal labels sharing only their boundary are valid', () => {
  const ref = reference(review([segment(2, 6)], [{ start: 6, end: 8 }]), source([[2, 8]]));
  const result = score(ref, [{ start: 2, end: 8 }]);
  near(result.coveredSkipSpeechSeconds, 4);
  near(result.coveredKeepSpeechSeconds, 2);
  near(result.unknownPredictionSeconds, 0);
});

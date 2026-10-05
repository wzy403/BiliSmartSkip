'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matches, assess, summarize } = require('./compare-release-markings.cjs');
const range = (start, end) => ({ start, end });
const ref = { skip: [range(10, 30)], skipSpeech: [range(10, 30)], keepSpeech: [range(0, 10), range(30, 50)] };

test('five-second boundary tolerance accepts a short ad without a 90-percent gate', () => {
  assert.equal(matches(range(10, 20), range(14, 16)), true);
  assert.equal(matches(range(10, 30), range(15.001, 30)), false);
  assert.equal(matches(range(10, 12), range(13, 14)), false);
});
test('five seconds of kept content at each endpoint are allowed, not added into one limit', () => {
  const result = assess(ref, [range(5, 35)]);
  assert.equal(result.markings[0].status, 'correct');
  assert.equal(result.markings[0].extraKeepSeconds, 0);
});
test('a late partial ad is different from a jump into kept content', () => {
  assert.equal(assess(ref, [range(25, 30)]).markings[0].status, 'partial-or-boundary');
  assert.equal(assess(ref, [range(10, 36)]).markings[0].status, 'wrong-keep');
});
test('a short false marking away from an ad is not forgiven as a boundary error', () => {
  const result = assess(ref, [range(40, 43)]);
  assert.equal(result.markings[0].status, 'wrong-keep');
  assert.equal(result.markings[0].extraKeepSeconds, 3);
});
test('adjacent partial markings cannot be merged into a complete match', () => {
  const result = assess(ref, [range(10, 20), range(20, 30)]);
  assert.equal(result.matched.length, 0);
});
test('duplicate markings cannot earn credit twice', () => {
  const result = assess(ref, [range(10, 30), range(10, 30)]);
  assert.equal(result.matched.length, 1);
});
test('matching can reassign an ambiguous candidate to cover both references once', () => {
  const result = assess({ skip: [range(10, 14), range(15, 19)], skipSpeech: [range(10, 14), range(15, 19)], keepSpeech: [] },
    [range(12, 17), range(6, 14)]);
  assert.equal(result.matched.length, 2);
  assert.equal(result.allAdsCorrect, true);
});
test('unobserved time stays unknown and is not counted as correct', () => {
  const result = assess({ skip: [], skipSpeech: [], keepSpeech: [] }, [range(10, 30)]);
  assert.equal(result.markings[0].status, 'unknown');
  const summary = summarize([{ versions: { current: result } }], 'current');
  assert.equal(summary.totalMarkings, 1);
  assert.equal(summary.correctMarkings, 0);
  assert.equal(summary.unknown, 1);
});
test('a matched confirmed ad does not prove all ads are covered when another skip is unresolved', () => {
  const result = assess(ref, [range(10, 30)], { allAdsAssessable: false });
  assert.equal(result.markings[0].status, 'correct');
  assert.equal(result.allAdsCorrect, false);
});
test('boundary diagnostics preserve the full reference and separate missing starts and ends', () => {
  const result = assess(ref, [range(18, 27)]);
  assert.deepEqual(result.boundaries[0], { referenceIndex: 0, start: 10, end: 30, matched: false,
    predictionIndex: 0, startErrorSeconds: 8, endErrorSeconds: -3, missingStartSeconds: 8, missingEndSeconds: 3 });
  assert.equal(assess(ref, []).boundaries[0].predictionIndex, null);
});

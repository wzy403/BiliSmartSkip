'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateLabels } = require('./validate.cjs');
const { coverage } = require('../coverage.cjs');
const previousBytes = fs.readFileSync(path.join(__dirname, 'human/review-2026-09-30-v2.json'));
const previous = JSON.parse(previousBytes);
const current = require('./human/review-2026-10-04-v3.json');
const feedback = require('./human/user-feedback-2026-10-04.json');

test('v3 appends corrected partial feedback while preserving all 14 prior records and their original file', () => {
  assert.doesNotThrow(() => validateLabels(current));
  assert.equal(createHash('sha256').update(previousBytes).digest('hex'), 'b2705d80cbdef33519821137d5c8a24d0eafd46f0766f7d86306c79942897e34');
  assert.equal(current.records.length, 15);
  assert.deepEqual(current.records.slice(0, 14), previous.records);
  const record = current.records.at(-1);
  assert.equal(record.bvid, 'BV1r1421r7am');
  assert.deepEqual(record.reviewedRanges, [{ start: 294.089, end: 326 }, { start: 351, end: 372 }]);
  assert.equal(record.status, 'partial');
  assert.deepEqual(record.segments.map(segment => [segment.contentType, segment.skipDecision, segment.skipConfidence, segment.boundaryConfidence]),
    [['non_ad', 'keep', 'high', 'high'], ['ad', 'skip', 'high', 'uncertain']]);
  assert.equal(record.source.visualReviewPerformedByAssistant, false);
});

test('feedback history preserves the exact correction and supersedes the no-ad statement without inventing visual review', () => {
  assert.equal(feedback.messages[0].verbatim, '`BV1r1421r7am`\n这个视频是严重的误判。。。这里不存在广告');
  assert.equal(feedback.messages[0].status, 'superseded');
  assert.equal(feedback.messages[0].supersededBy, feedback.messages[1].id);
  assert.equal(feedback.messages[1].verbatim, '不好意思我说错了，这个视频的广告是在 5:51~6:12秒 左右。。。。');
  assert.equal(feedback.messages[1].status, 'active');
  assert.equal(feedback.visualReviewPerformedByAssistant, false);
});

test('uncertain ad boundaries retain only the known interior and unlabelled seconds remain unknown', () => {
  const record = current.records.at(-1);
  const result = coverage(record.segments, [], record.duration);
  assert.equal(result.labelledAdSeconds, 11, '351–372 is trimmed by five seconds at each uncertain boundary');
  assert.ok(Math.abs(result.labelledNormalSeconds - 31.911) < 1e-9);
  assert.equal(result.adSegments, 0, 'approximate ad boundaries do not enter strict whole-segment coverage');
  assert.ok(result.labelledAdSeconds + result.labelledNormalSeconds < record.duration);
});

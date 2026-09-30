const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('./semantics.js');

test('legacy labels migrate conservatively without claiming that keep is noncommercial', () => {
  const ad = S.normalizeSegment({ label: 'ad', confidence: 'high', boundaryConfidence: 'high' });
  assert.deepEqual([ad.contentType, ad.contentConfidence, ad.skipDecision, ad.skipConfidence], ['ad', 'high', 'skip', 'high']);
  const normal = S.normalizeSegment({ label: 'normal', confidence: 'high' });
  assert.deepEqual([normal.contentType, normal.contentConfidence, normal.skipDecision, normal.skipConfidence], ['uncertain', 'uncertain', 'keep', 'high']);
  const unknown = S.normalizeSegment({ label: 'uncertain', confidence: 'uncertain' });
  assert.deepEqual([unknown.contentType, unknown.skipDecision, unknown.confidence], ['uncertain', 'uncertain', 'uncertain']);
});

test('explicit commercial content can be kept and overwrites stale compatibility fields', () => {
  const source = Object.freeze({ start: 0, end: 2.32, label: 'ad', confidence: 'uncertain',
    contentType: 'ad', contentConfidence: 'high', skipDecision: 'keep', skipConfidence: 'high',
    boundaryConfidence: 'high', reason: 'This sponsorship should be kept', custom: { preserved: true } });
  const result = S.normalizeSegment(source);
  assert.equal(result.label, 'normal'); assert.equal(result.confidence, 'high');
  assert.equal(result.contentType, 'ad'); assert.equal(result.boundaryConfidence, 'high');
  assert.equal(result.custom, source.custom); assert.equal(source.label, 'ad');
  assert.deepEqual(S.normalizeSegment(result), result, 'normalization is idempotent');
  assert.equal(S.targetSegment, S.normalizeSegment);
});

test('content and skip confidence remain independent and notes never decide either axis', () => {
  const source = { contentType: 'uncertain', contentConfidence: 'uncertain', skipDecision: 'keep',
    skipConfidence: 'high', boundaryConfidence: 'high', reason: '广告必须全部跳过' };
  const result = S.normalizeSegment(source);
  assert.equal(result.skipConfidence, 'high'); assert.equal(result.boundaryConfidence, 'high');
  assert.equal(result.contentConfidence, 'uncertain'); assert.equal(result.label, 'normal');
  assert.equal(S.normalizeSegment({ ...source, contentType: 'non_ad', contentConfidence: 'high',
    skipDecision: 'uncertain', skipConfidence: 'uncertain', reason: '正常内容无需跳过' }).label, 'uncertain');
});

test('an explicitly changed axis does not silently inherit old high confidence', () => {
  const result = S.normalizeSegment({ label: 'ad', confidence: 'high', contentType: 'non_ad', skipDecision: 'keep' });
  assert.equal(result.contentConfidence, 'uncertain'); assert.equal(result.skipConfidence, 'uncertain');
});

test('invalid explicit enums fail even when valid legacy fields are present', () => {
  for (const [field, value] of Object.entries({ contentType: 'sponsor', contentConfidence: false,
    skipDecision: 'normal', skipConfidence: null, label: 'unknown', confidence: 1 })) {
    assert.throws(() => S.normalizeSegment({ label: 'normal', confidence: 'high', [field]: value }), new RegExp(field));
  }
  assert.throws(() => S.normalizeSegment(null), /object/);
});

test('shared semantics run as a standalone browser script without dependencies', () => {
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'semantics.js'), 'utf8'), browser);
  assert.equal(browser.LabelSemantics.normalizeSegment({ label: 'normal', confidence: 'high' }).skipDecision, 'keep');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migrate } = require('./migrate-human-v2.cjs');
const original = fs.readFileSync(path.join(__dirname, 'human/review-2026-09-30-v1.json'), 'utf8');

test('notes migration preserves every human range, original reason, and completed review', () => {
  const before = JSON.parse(original), after = migrate(original);
  assert.equal(after.records.length, before.records.length);
  after.records.forEach((record, index) => {
    const prior = before.records[index];
    assert.equal(record.bvid, prior.bvid);
    assert.equal(record.reviewComplete, prior.reviewComplete);
    assert.deepEqual(record.segments.map(s => [s.start, s.end, s.reason]), prior.segments.map(s => [s.start, s.end, s.reason]));
  });
});

test('user-approved soft ads and short sponsorship are advertisements to keep', () => {
  const after = migrate(original), byId = new Map(after.records.map(r => [r.bvid, r]));
  const keptAds = [...byId.get('BV1JucQzwEiP').segments, byId.get('BV1TnVb6bEwG').segments[0]];
  for (const s of keptAds) {
    assert.equal(s.contentType, 'ad'); assert.equal(s.skipDecision, 'keep');
    assert.equal(s.label, 'normal'); assert.equal(s.skipConfidence, 'high');
  }
  assert.equal(keptAds[2].semanticMigration.original.boundaryConfidence, 'uncertain');
  const segments = after.records.flatMap(r => r.segments);
  assert.equal(segments.filter(s => s.skipDecision === 'skip').length, 12);
  assert.equal(segments.filter(s => s.skipDecision === 'keep').length, 13);
  assert.equal(segments.filter(s => s.contentType === 'ad' && s.skipDecision === 'keep').length, 3);
});

test('migration cannot silently apply its note interpretation to another export', () => {
  assert.throws(() => migrate(original.replace('可不用跳过', '应当跳过')), /frozen v1/);
});

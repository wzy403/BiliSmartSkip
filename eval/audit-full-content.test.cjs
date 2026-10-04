const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadReferences, freezeReferences } = require('./audit-full-content.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bss-content-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'records'));
  const source = path.join(dir, 'source.jsonl');
  const records = [{ bvid: 'BV0000000001', cid: 1, duration: 100, subtitles: [{ from: 10, to: 20, content: 'example' }] },
    { bvid: 'BV0000000002', cid: 2, duration: 100, subtitles: [] }];
  fs.writeFileSync(source, records.map(JSON.stringify).join('\n') + '\n');
  const manifest = { source, sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    records: records.map(r => ({ bvid: r.bvid, cid: r.cid, duration: r.duration, split: 'development' })) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const reviewFile = path.join(dir, 'records', 'BV0000000001.json');
  const wrapper = { kind: 'assistant-content-review', algorithmPredictionsSeen: false,
    record: { ...records[0], fullTranscriptRead: true, segments: [], normalSpeechRanges: [{ start: 10, end: 20 }] } };
  fs.writeFileSync(reviewFile, JSON.stringify(wrapper));
  return { dir, source, reviewFile, wrapper, manifest };
}

test('missing captions are unknown inventory entries, not reviewed negatives', t => {
  const { dir } = fixture(t), result = freezeReferences(dir);
  assert.equal(result.inputVideos, 2);
  assert.equal(result.reviewedVideos, 1);
  assert.equal(result.missingSourceVideos, 1);
  assert.equal(loadReferences(dir).rows.length, 1);
});

test('cannot freeze when an available full transcript has not been reviewed', t => {
  const { dir, reviewFile } = fixture(t);
  fs.unlinkSync(reviewFile);
  assert.throws(() => freezeReferences(dir), /still pending/);
});

test('changed labels and changed corpus are rejected after freezing', t => {
  const { dir, source, reviewFile } = fixture(t);
  freezeReferences(dir);
  fs.appendFileSync(reviewFile, '\n');
  assert.throws(() => loadReferences(dir), /Frozen review changed/);
  fs.appendFileSync(source, '\n');
  assert.throws(() => loadReferences(dir), /Source corpus changed/);
});

test('a prediction-exposed review cannot silently become a blind reference', t => {
  const { dir, reviewFile, wrapper } = fixture(t);
  wrapper.algorithmPredictionsSeen = true;
  fs.writeFileSync(reviewFile, JSON.stringify(wrapper));
  assert.throws(() => freezeReferences(dir), /Invalid blind review/);
});

test('split changes and accidental freeze overwrites are rejected', t => {
  const { dir, manifest } = fixture(t);
  freezeReferences(dir);
  assert.throws(() => freezeReferences(dir), /already exists/);
  manifest.records[0].split = 'validation';
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => loadReferences(dir), /Frozen manifest/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeBundle, prepare, parse } = require('./prepare.cjs');
const C = require('./core.js');

function fixture() {
  const identity = { bvid: 'BV1a5N4zxEQe', cid: 123, duration: 200 };
  const auto = { start: 20, end: 40, source: 'chapters', requiresConfirmation: false };
  const manual = { start: 100, end: 130, source: 'subtitles', requiresConfirmation: true,
    contentType: 'ad', skipDecision: 'skip', confidence: 'low' };
  const human = { start: 150, end: 160, label: 'ad', origin: 'human' };
  return {
    corpus: [{ ...identity, title: '测试视频', subtitles: [{ from: 0, to: 2, content: '片头' }],
      annotations: { status: 'reviewed', segments: [human], reviewedRanges: [{ start: 150, end: 160 }] },
      evaluationSplit: { split: 'development' } }],
    results: [{ ...identity, humanSegments: [human],
      before: { candidates: [manual], automaticSegments: [] },
      current: { candidates: [auto, manual], automaticSegments: [auto] } }],
    labels: { schemaVersion: 1, kind: 'assistant-provisional', labelSource: 'assistant', records: [{ ...identity,
      segments: [{ start: 0, end: 2, contentType: 'ad', contentConfidence: 'high', skipDecision: 'keep', skipConfidence: 'high',
        boundaryConfidence: 'high', labelSource: 'assistant', reason: '短声明保留' }] }] }
  };
}
const make = f => makeBundle(f.corpus, f.results, f.labels, { generatedAt: '2026-01-01T00:00:00Z' });

test('saved multisegment replay preserves auto/manual evidence and separate assistant axes', () => {
  const f = fixture(), original = JSON.stringify(f), { bundle } = make(f), record = bundle.records[0];
  assert.deepEqual(C.normalizeBundle(bundle), bundle);
  assert.deepEqual(record.predictions.pipeline.segments.map(segment => [segment.start, segment.end, segment.automatic]), [[20, 40, true], [100, 130, false]]);
  assert.deepEqual(record.predictions.conservative.segments.map(segment => [segment.start, segment.end, segment.automatic]), [[100, 130, false]]);
  assert.ok(['model', 'topics', 'rules', 'legacy'].every(source => record.predictions[source].available === false));
  assert.ok(record.predictions.pipeline.segments.every(segment => segment.requiresConfirmation === true));
  assert.equal(record.predictions.pipeline.segments[1].confidence, 'uncertain');
  assert.equal(record.assistantSegments.length, 1);
  assert.equal(record.assistantSegments[0].contentType, 'ad');
  assert.equal(record.assistantSegments[0].skipDecision, 'keep');
  assert.ok(!JSON.stringify(bundle).includes('150'), 'human annotations and saved humanSegments never become drafts');
  assert.equal(JSON.stringify(f), original, 'inputs remain unchanged');
});

test('rejects stale identities, mismatched durations and missing saved replay', () => {
  for (const where of ['results', 'labels']) {
    const f = fixture(), record = where === 'results' ? f.results[0] : f.labels.records[0];
    record.cid = 456;
    assert.throws(() => make(f), /identity mismatch/);
    record.cid = 123; record.duration = 201;
    assert.throws(() => make(f), /duration mismatch/);
  }
  const f = fixture(); f.results = [];
  assert.throws(() => make(f), /Missing saved replay/);
});

test('rejects human or mixed labels including a disguised human segment', () => {
  for (const kind of ['human-review', 'mixed-provisional-and-human-review']) {
    const f = fixture(); f.labels.kind = kind;
    assert.throws(() => make(f), /human review must stay separate/);
  }
  const f = fixture(); f.labels.records[0].segments[0].origin = 'human';
  assert.throws(() => make(f), /provenance/);
});

test('only unavailable corpus entries may lack replay and unrelated result rows do not enter a subset bundle', () => {
  const f = fixture();
  f.corpus.push({ bvid: 'BV1RnVU6FE4q', cid: 456, duration: 100, acquisition: { metadata: 'failed', danmaku: 'failed' } });
  f.results.push({ ...f.results[0], bvid: 'BV1HX5i6CEam', cid: 789 });
  const result = make(f);
  assert.equal(result.skippedUnavailable, 1); assert.equal(result.bundle.records.length, 1);
});

test('rejects out-of-range predictions and automatic intervals absent from candidates', () => {
  const f = fixture(); f.results[0].current.candidates[1].end = 201;
  assert.throws(() => make(f), /区间/);
  const g = fixture(); g.results[0].current.automaticSegments = [{ start: 80, end: 90 }];
  assert.throws(() => make(g), /not a saved candidate/);
});

test('CLI requires a fresh output path and file preparation cannot overwrite saved review progress', () => {
  assert.throws(() => parse(['--input', 'corpus.jsonl']), /--out/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-prepare-'));
  try {
    const f = fixture(), options = { input: path.join(dir, 'corpus.jsonl'), results: path.join(dir, 'results.jsonl'),
      labels: path.join(dir, 'assistant.json'), out: path.join(dir, 'new', 'review-bundle.json') };
    fs.writeFileSync(options.input, f.corpus.map(JSON.stringify).join('\n'));
    fs.writeFileSync(options.results, f.results.map(JSON.stringify).join('\n'));
    fs.writeFileSync(options.labels, JSON.stringify(f.labels));
    assert.equal(prepare(options).videos, 1);
    const saved = fs.readFileSync(options.out, 'utf8');
    assert.throws(() => prepare(options), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(options.out, 'utf8'), saved);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

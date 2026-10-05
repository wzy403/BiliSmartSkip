'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBenchmark, mergeExtraSource, referenceQuality } = require('./content-benchmark.cjs');
const { detectorInput } = require('./evaluate-segments.cjs');

test('frozen combined benchmark includes reviewed records only and separates validation authors', () => {
  const state = loadBenchmark();
  assert.equal(state.rows.length, 438);
  assert.equal(state.rows.filter(r => r.cohort === 'old351').length, 250);
  assert.equal(state.rows.filter(r => r.cohort === 'extra300').length, 188);
  assert.equal(state.missing.filter(r => r.cohort === 'extra300').length, 112);
  assert.equal(new Set(state.rows.map(r => r.item.bvid)).size, 438);
  const authors = new Set(state.rows.filter(r => r.item.split === 'development').map(r => r.item.author));
  for (const r of state.rows.filter(r => r.item.split === 'validation')) {
    assert.equal(authors.has(r.item.author), false);
    assert.equal(r.cohort, 'extra300');
  }
  assert.equal(state.counts.highConfidenceSkipSegments, 441);
  assert.equal(state.counts.unscoredSkipSegments, 6);
  const product = state.rows.find(r => r.item.bvid === 'BV1JucQzwEiP');
  assert.equal(product.ref.skip.length, 0);
  assert.ok(product.ref.keepSpeech.some(r => r.start <= 119.18 && r.end >= 120.42));
  const quark = state.rows.find(r => r.item.bvid === 'BV15GyYB8ESg');
  assert.ok(quark.ref.skip.some(r => r.start === 35.899 && r.end === 57.55));
  // A partial confirmation is not permission to shrink the complete ad span.
  assert.equal(state.rows.find(r => r.item.bvid === 'BV1Yz5k62E3y').ref.skip[0].start, 64.92);
  const originals = new Map(fs.readFileSync('eval/data/danmaku-audit-20261001/new-public.jsonl', 'utf8').trim().split('\n').map(JSON.parse).map(r => [r.bvid, r]));
  for (const row of state.rows.filter(r => r.cohort === 'extra300')) {
    const original = originals.get(row.item.bvid);
    assert.deepEqual(row.source.danmaku, original.danmaku);
    assert.deepEqual(row.source.chapters, original.chapters);
    assert.ok(row.source.subtitles.length > 0);
    const input = detectorInput(row.source);
    assert.equal(input.annotations, undefined);
    assert.equal(input.referenceSegments, undefined);
    assert.equal(input.skipDecision, undefined);
  }
});

test('a changed excluded review cannot hide behind pending status', t => {
  const manifest = JSON.parse(fs.readFileSync('eval/labels/assistant-content-extra300/manifest.json'));
  const pending = manifest.records.find(r => r.reviewStatus !== 'reviewed');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file) === pending.recordFile) return Buffer.from('{}');
    return read.call(this, file, ...args);
  });
  assert.throws(() => loadBenchmark(), /Frozen file changed/);
});

test('tampering with frozen membership is rejected instead of silently adopting it', t => {
  const filename = 'eval/benchmarks/content-438-v1/manifest.json';
  const altered = JSON.parse(fs.readFileSync(filename));
  altered.records.pop();
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file) === filename) return JSON.stringify(altered);
    return read.call(this, file, ...args);
  });
  assert.throws(() => loadBenchmark(), /Combined benchmark changed/);
});

function sample() {
  const original = { bvid: 'BVexample', cid: 1, duration: 100, danmaku: [{ time: 2, textContent: '30工程' }], chapters: [] };
  const fresh = { bvid: 'BVexample', cid: 1, duration: 100, title: 'new title', desc: '', subtitles: [{ from: 0, to: 1, content: '正文' }], danmaku: ['must not replace original'] };
  const item = { ...original, reviewStatus: 'reviewed', subtitleRows: 1 };
  const wrapper = { kind: 'assistant-content-review', algorithmPredictionsSeen: false, communityAdLabelsSeen: false, danmakuJumpTimesSeen: false,
    record: { ...original, reviewStatus: 'reviewed', fullTranscriptRead: true, pendingReasons: [],
      readCoverage: { firstIndex: 0, lastIndex: 0, allRowsRead: true, subtitleRows: 1 } } };
  return { original, fresh, wrapper, item };
}
test('refresh refuses another CID, pending review, incomplete reading and prediction-informed labels', () => {
  for (const change of [s => { s.fresh.cid = 2; }, s => { s.wrapper.record.reviewStatus = 'needs-verification'; },
    s => { s.wrapper.record.readCoverage.allRowsRead = false; }, s => { s.wrapper.algorithmPredictionsSeen = true; }]) {
    const s = sample(); change(s);
    assert.throws(() => mergeExtraSource(s.original, s.fresh, s.wrapper, s.item));
  }
  const s = sample(), merged = mergeExtraSource(s.original, s.fresh, s.wrapper, s.item);
  assert.deepEqual(merged.danmaku, s.original.danmaku);
  assert.deepEqual(merged.subtitles, s.fresh.subtitles);
});
test('medium skip decisions remain unscored and preclude a complete-ad claim', () => {
  assert.deepEqual(referenceQuality({ segments: [{ skipDecision: 'skip', confidence: 'medium' }] }),
    { uncertainSegments: 1, unscoredSkipSegments: 1, allAdsAssessable: false });
  assert.equal(referenceQuality({ segments: [{ skipDecision: 'keep', confidence: 'medium' }] }).allAdsAssessable, true);
});

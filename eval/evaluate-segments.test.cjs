'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDataset, validateRecord, sourceAvailability } = require('./dataset.cjs');
const { stats } = require('./stats.cjs');
const { validateLabels, splitOf } = require('./labels/validate.cjs');
const { detectorInput, normalizeReplay, wholeSegments, evaluateRecords, renderHtml, parse } = require('./evaluate-segments.cjs');
const truth = (start, end, skipDecision = 'skip') => ({ start, end, origin: 'human', contentType: 'ad', contentConfidence: 'high',
  skipDecision, skipConfidence: 'high', boundaryConfidence: 'high', reason: '<script>only a note</script>' });
const candidate = (start, end, manual = false) => ({ start, end, source: 'fixture', requiresConfirmation: manual });
function fixture() {
  const records = [1, 2, 3, 4].map(cid => ({ bvid: `BV${String(cid).padStart(10, '0')}`, cid, title: `Test <img src=x onerror=alert(1)> ${cid}`,
    duration: 100, split: 'development', creator: { mid: cid }, desc: '', subtitles: [{ from: 10, to: 30, content: 'fixture text' }], danmaku: [],
    annotations: { status: 'unreviewed', segments: [{ start: 1, end: 90 }] }, references: [{ source: 'community', segments: [{ start: 1, end: 90 }] }] }));
  records[1].creator = { mid: 1 }; records[1].split = 'holdout'; // The first record shares its author.
  const feedback = { schemaVersion: 1, kind: 'human-review', records: [{ bvid: records[2].bvid, cid: 3, duration: 100,
    segments: [truth(0, 5, 'keep'), truth(10, 30), truth(50, 60)] }] };
  const challenge = { kind: 'reserved-development-challenge-candidates', videos: [{ bvid: records[3].bvid, cid: 4, title: records[3].title,
    segments: [truth(1, 99)], status: 'unreviewed' }] }; // Even supplied challenge intervals must not enter scoring.
  return { records, feedback, challenge };
}
function runner(input, production) {
  assert.equal(Object.hasOwn(input, 'annotations'), false);
  assert.equal(Object.hasOwn(input, 'references'), false);
  assert.equal(Object.hasOwn(input, 'humanSegments'), false);
  assert.equal(Object.hasOwn(input, 'segments'), false);
  const candidates = production.name === 'before' ? [candidate(10, 15)] : [candidate(10, 30), candidate(50, 60, true)];
  return { candidates, automaticSegments: [candidates[0]], seekDestinations: [candidates[0].end + 0.05], detectionMs: 0.2 };
}
const productions = { before: { name: 'before' }, current: { name: 'current' } };
test('standalone corpus helpers preserve reviewed-range and incomplete-source safeguards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bilismartskip-dataset-'));
  try {
    const { records } = fixture();
    fs.writeFileSync(path.join(dir, '01.json'), JSON.stringify({ videos: [records[0]] }));
    fs.writeFileSync(path.join(dir, '02.jsonl'), JSON.stringify(records[1]) + '\n\n');
    fs.writeFileSync(path.join(dir, 'collection-summary.json'), '{}');
    const loaded = readDataset(dir);
    assert.deepEqual(loaded, records.slice(0, 2));
    assert.doesNotThrow(() => validateRecord(loaded[0]));
    assert.equal(sourceAvailability(loaded[0]).replayEligible, true);
    const incomplete = { ...loaded[0], acquisition: { metadata: 'available', danmaku: 'error', subtitles: 'available' } };
    assert.equal(sourceAvailability(incomplete).replayEligible, false);
    const reviewed = { ...loaded[0], annotations: { status: 'reviewed', segments: [{ start: 5, end: 15 }], reviewedRanges: [{ start: 10, end: 20 }] } };
    assert.throws(() => validateRecord(reviewed), /fully contained/);
    fs.writeFileSync(path.join(dir, '03.jsonl'), '{}\ninvalid\n');
    assert.throws(() => readDataset(dir), /03\.jsonl:2:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('standalone label checks preserve dual-axis decisions, human provenance and holdout precedence', () => {
  const { records, feedback } = fixture();
  feedback.records[0].segments[0].contentType = 'uncertain';
  feedback.records[0].segments[0].contentConfidence = 'uncertain';
  const original = JSON.stringify(feedback);
  assert.doesNotThrow(() => validateLabels(feedback));
  assert.equal(JSON.stringify(feedback), original, 'validation does not normalize or mutate raw labels');
  assert.throws(() => validateLabels({ ...feedback, records: [...feedback.records, ...feedback.records] }), /Duplicate label/);
  const invalid = structuredClone(feedback); invalid.records[0].segments[0].origin = 'assistant';
  assert.throws(() => validateLabels(invalid), /origin human/);
  assert.equal(splitOf({ ...records[0], evaluationSplit: { split: 'development' }, split: 'holdout' }), 'holdout');
  assert.equal(splitOf({ ...records[0], evaluationSplit: 'development' }, { split: 'holdout' }), 'holdout');
  assert.equal(splitOf({ ...records[0], evaluationSplit: { split: 'development' } }), 'development');
});
test('standalone timing summary preserves empty and nearest-rank results without sorting input', () => {
  assert.deepEqual(stats([]), { samples: 0, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null });
  const input = [4, 1, 3, 2];
  assert.deepEqual(stats(input), { samples: 4, p50Ms: 2, p95Ms: 4, maxMs: 4, meanMs: 2.5 });
  assert.deepEqual(input, [4, 1, 3, 2]);
});
test('production replay dependency closure contains no training or historical evaluator modules', () => {
  const visited = new Set();
  const visit = entry => {
    if (visited.has(entry.id)) return;
    visited.add(entry.id);
    for (const child of entry.children) visit(child);
  };
  visit(require.cache[require.resolve('./evaluate-segments.cjs')]);
  for (const filename of visited) {
    assert.doesNotMatch(filename, /[/\\](?:features|model|train|benchmark|evaluate)\.cjs$/);
  }
});
test('multiple auto intervals require one actual matching seek each, not merely permission flags', () => {
  const candidates = [candidate(10, 30), candidate(40, 50, true), candidate(60, 80)];
  const result = normalizeReplay({ duration: 100 }, { candidates, automaticSegments: [candidates[0], candidates[2]], seekDestinations: [30.05, 80.05] });
  assert.equal(result.candidates.length, 3); assert.equal(result.automaticSegments.length, 2);
  assert.throws(() => normalizeReplay({ duration: 100 }, { candidates, automaticSegments: [candidates[0]], seekDestinations: [] }), /seek count/);
  assert.throws(() => normalizeReplay({ duration: 100 }, { candidates, automaticSegments: [candidates[0]], seekDestinations: [80.05] }), /matching actual seek/);
  assert.throws(() => normalizeReplay({ duration: 100 }, { candidates, automaticSegments: [candidates[0]], seekDestinations: [30.05, 30.05] }), /repeated seeks/);
  assert.throws(() => normalizeReplay({ duration: 100 }, { candidates, automaticSegments: [candidate(5, 30)], seekDestinations: [30.05] }), /not a detected candidate/);
  assert.throws(() => normalizeReplay({ duration: 100 }, { candidates, automaticSegments: [candidates[0], candidates[0]], seekDestinations: [30.05, 30.05] }), /Repeated automatic interval/);
});
test('runtime detector fallback is an evaluation failure even if legacy candidates and seeks still succeed', async () => {
  const { records, feedback } = fixture();
  const result = await evaluateRecords(records, feedback, productions, { scope: 'human', warmup: 1,
    runner: (input, production) => ({ ...runner(input, production), diagnostics: production.name === 'current'
      ? [['[BiliSmartSkip] complete-segment detection failed', 'mock detector exception']] : [] }) });
  assert.equal(result.rows.length, 0, 'failed detector fallback must not become a successful paired accuracy sample');
  assert.equal(result.errors.length, 2, 'warmup and measured failure are both visible');
  assert.ok(result.errors.every(error => error.variant === 'current' && /fell back after failure/.test(error.message)));
  assert.equal(result.summary.human.development.videos, 0);
});
test('legacy single-result runner is accepted only with actual seek evidence', () => {
  const value = candidate(10, 30);
  const result = normalizeReplay({ duration: 100 }, { candidate: value, auto: value, seekDestinations: [30.05] });
  assert.deepEqual(result.candidates, [value]); assert.deepEqual(result.automaticSegments, [value]);
  assert.deepEqual(normalizeReplay({ duration: 100 }, { candidate: value, auto: null, seekDestinations: [] }).automaticSegments, []);
});
test('strict whole-segment metric cannot combine adjacent fragments into a complete prediction', () => {
  const before = { candidates: [candidate(10, 20), candidate(20, 30)], automaticSegments: [] };
  const current = { candidates: [candidate(11, 30)], automaticSegments: [candidate(11, 30)] };
  const row = wholeSegments([truth(10, 30), truth(40, 50, 'keep')], before, current)[0];
  assert.equal(row.before.candidates.coverage, 0.5); assert.equal(row.before.candidates.complete90, false);
  assert.equal(row.current.candidates.coverage, 0.95); assert.equal(row.current.candidates.complete90, true);
  assert.equal(row.current.candidates.startErrorSeconds, 1); assert.equal(row.current.automatic.complete90, true);
});
test('development replay isolates entire holdout authors, detectors never see labels and challenges never score accuracy', async () => {
  const { records, feedback, challenge } = fixture(), calls = [];
  const result = await evaluateRecords(records, feedback, productions, { scope: 'development', warmup: 0, challenge,
    runner: (input, production) => { calls.push(input.cid); return runner(input, production); } });
  assert.deepEqual([...new Set(calls)].sort(), [3, 4]);
  assert.equal(result.summary.replayedVideos, 2); assert.equal(result.summary.human.development.videos, 1);
  assert.equal(result.summary.human.development.current.candidates.strictWholeSegments.complete90, 2);
  assert.equal(result.summary.human.development.current.automatic.strictWholeSegments.complete90, 1);
  assert.equal(result.summary.execution.current.actualSeekCount, 2, 'one actual seek in each replayed video, not one per detected candidate');
  assert.equal(result.summary.human.development.current.candidates.metrics.labelledAdSeconds, 30);
  assert.equal(result.summary.human.development.current.candidates.metrics.labelledNormalSeconds, 5, 'ad content marked keep stays a negative skip target');
  assert.equal(result.challengeRows[0].accuracy, null);
  assert.equal(result.rows.find(row => row.cid === 4).humanSegments, null);
  assert.equal(result.excluded.filter(row => row.reason === 'holdout-author-not-replayed').length, 2);
  assert.equal(result.summary.execution.current.timing.detection.samples, 2);
});
test('human scope replays only labelled identities and leaves other challenge rows unobserved', async () => {
  const { records, feedback, challenge } = fixture();
  const result = await evaluateRecords(records, feedback, productions, { scope: 'human', warmup: 0, runner, challenge });
  assert.deepEqual(result.rows.map(row => row.cid), [3]);
  assert.equal(result.challengeRows[0].status, 'not-replayed'); assert.equal(result.challengeRows[0].changed, null);
  assert.equal(result.challengeRows[0].current, null);
  assert.equal(detectorInput(records[0]).bvid, records[0].bvid);
  assert.equal(detectorInput(records[0]).title, records[0].title, 'title is a real production signal and must remain available');
  assert.equal(parse([]).scope, 'development'); assert.throws(() => parse(['--scope', 'holdout-tune']), /Invalid scope/);
});
test('frozen assistant challenge is scored separately as reference agreement and cannot enter human gold', async () => {
  const { records, feedback } = fixture();
  const challenge = { schemaVersion: 1, kind: 'assistant-provisional', records: [{ bvid: records[3].bvid, cid: 4,
    segments: [truth(10, 30), { ...truth(50, 60), skipDecision: 'uncertain', skipConfidence: 'uncertain' }, truth(0, 5, 'keep')] }] };
  const result = await evaluateRecords(records, feedback, productions, { scope: 'development', warmup: 0, runner, challenge });
  assert.equal(result.summary.human.development.current.candidates.metrics.labelledAdSeconds, 30);
  const provisional = result.summary.challenge.referenceAgreement.current.candidates.metrics;
  assert.equal(provisional.labelledAdSeconds, 20); assert.equal(provisional.labelledNormalSeconds, 5);
  assert.equal(provisional.unlabelledPredictionSeconds, 10, 'uncertain challenge time is unknown, not keep');
  assert.equal(result.summary.challenge.accuracy, null);
  assert.equal(result.summary.challenge.referenceKind, 'assistant-provisional');
  assert.equal(result.challengeRows[0].referenceKind, 'assistant-provisional');
  assert.equal(result.challengeRows[0].humanSegments, undefined);
  challenge.records[0].bvid = records[2].bvid; challenge.records[0].cid = 3;
  await assert.rejects(evaluateRecords(records, feedback, productions, { warmup: 0, runner, challenge }), /separate from human review authors/);
});
test('standalone report escapes human notes and titles and renders independent candidate/auto and strict completeness results', async () => {
  const { records, feedback, challenge } = fixture();
  const result = await evaluateRecords(records, feedback, productions, { warmup: 0, runner, challenge });
  const report = { ...result.summary, excluded: result.excluded, errors: result.errors, inputs: {}, environment: {},
    production: Object.fromEntries(['before', 'current'].map(name => [name, { sourceSha256: 'hash', codeSize: { files: [], totalBytes: 1, gzipBytes: 1 } }])) };
  const html = renderHtml(report, result.rows, result.challengeRows);
  assert.ok(!html.includes('<img src=x')); assert.ok(!html.includes('<script>only a note</script>'));
  assert.ok(html.includes('&lt;script&gt;only a note&lt;/script&gt;'));
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.match(html, /实际自动跳转/); assert.match(html, /单段完整 ≥90%/); assert.match(html, /未知预测秒/);
  assert.match(html, /实际跳转位置/); assert.match(html, /0:30\.05/);
  assert.match(html, /当前工作区/); assert.ok(!html.includes('当前生产'));
  assert.match(html, /没有人工真值|无人工真值/);
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadProduction, runVideo, repoRoot } = require('./runner.cjs');
const { detectorInput } = require('./evaluate-segments.cjs');

// Captured from the unmodified replay runner before heatmap support was added.
const snapshots = [
  { ref: '88652cdd6152f7652a7b21731d53c0942264ca86',
    sha: 'fd73ae7ec78e0cec2ca58c2392d307101740c499ae02846491aab9d15242630f', start: 84, legacy: true },
  { ref: '3ce86faffab16a881640fc27dea5f53bf7b219ee',
    sha: '872615e3d08f4c81645488e525a0b55607fd3caa7d118dac27fbe002c1c9bb1f', start: 84 },
  { ref: 'b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963',
    sha: 'e807e8dec8a1d56b0d1849c24e428b87215b6680c23749d46ba9eceadc923c1b', start: 79, boundaries: true }
];
const record = { bvid: 'BV_fixture', cid: 14, duration: 600,
  danmaku: [{ time: 79, textContent: '空降2:00' }] };
const heatmap = { step_sec: 10, events: { default: [1, 8, 2, 0] } };
const stable = result => { const { detectionMs, ...rest } = result; return rest; };

for (const snapshot of snapshots) {
  test(`historical replay ${snapshot.ref.slice(0, 7)} keeps its source hash and behavior`, async () => {
    const production = loadProduction(snapshot.ref);
    assert.equal(production.sourceSha256, snapshot.sha);
    assert.equal(production.codeSize.files.some(file => file.filename === 'heatmap-verifier.js'), false);
    const expected = { start: snapshot.start, end: 120, source: 'danmaku-time', matchedKeywords: [] };
    if (!snapshot.legacy) Object.assign(expected, {
      requiresConfirmation: false, matchedKeywords: ['空降'], reason: 'explicit-danmaku-skip',
      earlyAdEvidence: false, referenceCount: 1, explicitCount: 1, alternativeDestinations: [], confidence: 'high'
    });
    if (snapshot.boundaries) Object.assign(expected, { adReactionCount: 0,
      boundaryEvidence: { start: { kind: 'time-instruction', time: 79 }, end: { kind: 'danmaku-destination', time: 120 } } });
    const expectedReplay = { candidate: expected, auto: expected, candidates: [expected],
      automaticSegments: [expected], seekDestinations: [120.05], diagnostics: [] };
    assert.deepEqual(stable(await runVideo(record, production)), expectedReplay);
    assert.deepEqual(stable(await runVideo(record, production, { heatmap })), expectedReplay);
    const h = production.createHarness({ heatmap, danmaku: record.danmaku });
    await h.detectAllAndAttach();
    assert.equal(h.heatmapFetches, 0, 'a fixture does not add heatmap calls to historical source');
  });
}

test('an optional heatmap source loads before content and enters only that source snapshot hash', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bss-heatmap-runner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseline = loadProduction('b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963');
  for (const { filename } of baseline.codeSize.files) {
    fs.writeFileSync(path.join(directory, filename), execFileSync('git', ['show', `b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963:scr/${filename}`], { cwd: repoRoot }));
  }
  assert.equal(loadProduction(null, { sourceDir: directory }).sourceSha256, baseline.sourceSha256);
  fs.writeFileSync(path.join(directory, 'heatmap-verifier.js'), 'var BiliHeatmapVerifier = { fixtureModule: true };\n');
  fs.appendFileSync(path.join(directory, 'content.js'), '\nglobalThis.heatmapPresentBeforeContent = BiliHeatmapVerifier.fixtureModule;\n');
  const production = loadProduction(null, { sourceDir: directory });
  assert.notEqual(production.sourceSha256, baseline.sourceSha256);
  assert.deepEqual(production.codeSize.files.slice(-2).map(file => file.filename), ['heatmap-verifier.js', 'content.js']);
  assert.equal(production.createHarness().context.heatmapPresentBeforeContent, true);
  assert.equal(loadProduction('b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963').sourceSha256, baseline.sourceSha256);
});

test('heatmap fixtures, fetch counts and optional aid stay isolated per harness', async () => {
  const production = loadProduction('b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963');
  const withHeatmap = production.createHarness({ heatmap, videoInfo: { aid: 123 } });
  const withoutHeatmap = production.createHarness();
  assert.equal(await withHeatmap.context.fetchVideoHeatmap(record.bvid, 123, record.cid), heatmap);
  assert.equal(await withoutHeatmap.context.fetchVideoHeatmap(record.bvid, 123, record.cid), null);
  assert.equal(await withHeatmap.context.fetchVideoHeatmap(record.bvid, 123, record.cid), heatmap);
  assert.equal(withHeatmap.heatmapFetches, 2);
  assert.equal(withoutHeatmap.heatmapFetches, 1);
  assert.equal((await withHeatmap.context.fetchVideoInfo()).aid, 123);
  assert.equal((await withoutHeatmap.context.fetchVideoInfo()).aid, undefined);
});

test('runVideo accepts only its explicit heatmap sidecar and leaves frozen detector input unchanged', async () => {
  const baseline = loadProduction('b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963');
  const fixtures = [];
  const production = { ...baseline, createHarness(fixture) { fixtures.push(fixture); return baseline.createHarness(fixture); } };
  const untrustedRecord = { ...record, aid: 123, heatmap: { labels: 'must not leak' },
    annotations: ['must not leak'], referenceSegments: ['must not leak'] };
  await runVideo(untrustedRecord, production);
  await runVideo(untrustedRecord, production, { heatmap });
  assert.equal(fixtures[0].heatmap, undefined);
  assert.equal(fixtures[1].heatmap, heatmap);
  assert.equal(fixtures[1].videoInfo.aid, 123);
  const input = detectorInput(untrustedRecord);
  assert.equal(input.heatmap, undefined);
  assert.equal(input.aid, undefined);
  assert.equal(input.annotations, undefined);
  assert.equal(input.referenceSegments, undefined);
  assert.deepEqual(Object.keys(input).sort(), ['bvid', 'chapters', 'cid', 'danmaku', 'desc', 'duration', 'subtitles', 'title']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./harness.cjs');
const { strongSubtitles, timestamp } = require('./fixtures.cjs');
const { detectorInput } = require('../eval/evaluate-segments.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
let cachedFixture;

function actualKeywordFixture() {
  if (!cachedFixture) {
    const row = require('../eval/content-benchmark.cjs').loadBenchmark().rows.find(row => row.item.bvid === 'BV1BVyBY9EEw');
    assert.equal(row.item.split, 'development');
    const record = detectorInput(row.source);
    cachedFixture = {
      record,
      fixture: { videoInfo: { aid: 113344019242945, cid: record.cid, duration: record.duration,
        desc: record.desc, title: record.title }, chapters: record.chapters,
        subtitles: record.subtitles, danmaku: record.danmaku },
      heatmap: JSON.parse(fs.readFileSync(path.join(__dirname,
        '../eval/experiments/heatmap-full-20261004/responses/BV1BVyBY9EEw.json'), 'utf8'))
    };
  }
  return cachedFixture;
}

test('actual development keyword false positive is removed before any button or seek is attached', async () => {
  const { record, fixture, heatmap } = actualKeywordFixture();
  const baseline = createHarness(fixture);
  const original = await baseline.detectAllAndAttach();
  assert.equal(original.length, 1);
  assert.equal(original[0].source, 'danmaku-keywords');
  assert.equal(original[0].start, 710.721);
  assert.equal(original[0].end, 747.09);
  const h = createHarness({ ...fixture, heatmap });
  h.context.getBvidFromPage = () => record.bvid;
  const fetch = h.context.fetchVideoHeatmap, calls = [];
  h.context.fetchVideoHeatmap = async (...args) => { calls.push(args); return fetch(...args); };
  assert.deepEqual(plain(await h.detectAllAndAttach()), []);
  assert.equal(h.heatmapFetches, 1);
  assert.deepEqual(calls, [[record.bvid, fixture.videoInfo.aid, record.cid]]);
  h.tick(original[0].start);
  assert.equal(h.button.parentElement, null);
  assert.deepEqual(h.video.seeks, []);
});

test('missing or failed optional heatmap retains the complete original detection and manual behavior', async () => {
  const { fixture } = actualKeywordFixture();
  const baseline = createHarness(fixture);
  const original = plain(await baseline.detectAllAndAttach());
  assert.equal(baseline.heatmapFetches, 1);
  const unavailable = createHarness({ ...fixture, heatmap: { modules: [] } });
  const failed = createHarness(fixture);
  failed.context.fetchVideoHeatmap = async () => { throw new Error('optional heatmap failed'); };
  for (const h of [unavailable, failed]) {
    assert.deepEqual(plain(await h.detectAllAndAttach()), original);
    h.tick(original[0].start);
    assert.deepEqual(h.video.seeks, []);
    assert.match(h.button.textContent, /疑似广告/);
    h.button.click();
    assert.deepEqual(h.video.seeks, [original[0].end + 0.05]);
  }
});

test('no candidate, sponsored subtitles, explicit timestamp and missing subtitles do not fetch heatmaps', async () => {
  const { fixture, heatmap } = actualKeywordFixture();
  const cases = [
    { subtitles: [{ from: 40, to: 50, content: '这是普通历史正文' }], expected: false },
    { subtitles: strongSubtitles, expected: true },
    { danmaku: [timestamp('跳过广告 2:00', 74)], expected: true },
    { ...fixture, subtitles: [], expected: true }
  ];
  for (const { expected, ...source } of cases) {
    const h = createHarness({ ...source, heatmap });
    const segments = await h.detectAllAndAttach();
    assert.equal(segments.length > 0, expected);
    assert.equal(h.heatmapFetches, 0);
  }
});

test('a failed heatmap eligibility check preserves the original candidates without fetching', async () => {
  const { fixture } = actualKeywordFixture();
  const baseline = createHarness(fixture);
  const expected = plain(await baseline.detectAllAndAttach());
  const h = createHarness(fixture);
  h.context.BiliHeatmapVerifier = { ...h.context.BiliHeatmapVerifier,
    needsHeatmap() { throw new Error('optional eligibility failure'); } };
  assert.deepEqual(plain(await h.detectAllAndAttach()), expected);
  assert.equal(h.heatmapFetches, 0);
  h.tick(expected[0].start);
  assert.match(h.button.textContent, /疑似广告/);
  assert.deepEqual(h.video.seeks, []);
});

test('a delayed heatmap result from the previous page cannot attach to the new video', { timeout: 5000 }, async () => {
  const { record, fixture } = actualKeywordFixture();
  const h = createHarness(fixture);
  h.setMode('auto');
  h.context.getBvidFromPage = () => record.bvid;
  let requested, resolveHeatmap;
  const waitingForRequest = new Promise(resolve => { requested = resolve; });
  const heatmapPending = new Promise(resolve => { resolveHeatmap = resolve; });
  h.context.fetchVideoHeatmap = () => { requested(); return heatmapPending; };
  const attachments = [], attach = h.context.attachSkipper;
  h.context.attachSkipper = segments => { attachments.push(plain(segments)); attach(segments); };
  h.context.mainLogic();
  await waitingForRequest;
  const oldGeneration = h.evaluate('detectionGeneration');

  // Simulate the existing navigation handler's mainLogic call with a new BV.
  h.context.getBvidFromPage = () => 'BVnewVideo';
  h.context.fetchVideoInfo = async () => ({ aid: 2, cid: 15, duration: 600, desc: '' });
  h.context.fetchPlayerInfo = async () => ({ viewPoints: [{ from: 90, to: 120, content: '广告' }], subtitles: [] });
  h.context.fetchDanmakuWithTime = async () => [];
  h.context.mainLogic();
  await new Promise(setImmediate);
  assert.ok(h.evaluate('detectionGeneration') > oldGeneration);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0][0].start, 90);
  assert.equal(attachments[0][0].end, 120);
  h.tick(90);
  assert.deepEqual(h.video.seeks, [120.05]);

  // Null retains the old nonempty candidate, so only the generation check can
  // prevent it from replacing the new page's schedule after its request ends.
  resolveHeatmap(null);
  await new Promise(setImmediate);
  assert.equal(attachments.length, 1);
  assert.equal(h.video.listeners.get('timeupdate').length, 1);
  h.tick(710.721);
  assert.equal(h.button.parentElement, null);
  assert.deepEqual(h.video.seeks, [120.05]);
});

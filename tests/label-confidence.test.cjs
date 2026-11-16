const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');
const { timestamp } = require('./fixtures.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

test('English substrings and negated chapter labels do not identify advertisements', async () => {
  for (const label of ['Download', 'Shader tutorial', 'Adapter', '无广告', '不是广告', '非广告', '没有赞助', 'No ads', 'without sponsorship', 'Ad-free tutorial']) {
    const h = createHarness({ chapters: [{ from: 70, to: 130, content: label }] });
    assert.equal(await h.detectAndAttach(), null, label);
    h.tick(80);
    assert.deepEqual(h.video.seeks, [], label);
  }
});

test('a chapter discussing advertising requires confirmation', async () => {
  for (const label of ['广告识别算法', '广告的发展历史', '广告：为什么越来越多', '广告（识别教程）', 'Ad detection', 'sponsor marketing history']) {
    const h = createHarness({ chapters: [{ from: 70, to: 130, content: label }] });
    const segment = await h.detectAndAttach();
    assert.equal(segment.requiresConfirmation, true, label);
    h.tick(80);
    assert.deepEqual(h.video.seeks, [], label);
  }
});

test('explicit ad chapter labels still permit automatic skips', async () => {
  for (const label of ['广告', '广告时间：某产品', '恰饭环节', '某产品（广告）', 'Ad', 'Sponsored segment: product']) {
    const h = createHarness({ chapters: [{ from: 70, to: 130, content: label }] });
    const segment = await h.detectAndAttach();
    assert.equal(segment.requiresConfirmation, false, label);
    h.tick(80);
    assert.deepEqual(h.video.seeks, [130.05], label);
  }
});

test('uncertain chapter does not mask a later explicit chapter or danmaku destination', async () => {
  for (const [extra, start] of [
    [{ chapters: [{ from: 70, to: 130, content: '广告历史' }, { from: 200, to: 250, content: '恰饭' }] }, 200],
    [{ chapters: [{ from: 70, to: 130, content: '广告历史' }], danmaku: [timestamp('跳过广告 4:10', 195)] }, 195]
  ]) {
    const h = createHarness(extra);
    const segments = await h.detectAllAndAttach();
    // Both are kept: the ambiguous title as a prompt, the explicit one as a skip.
    assert.deepEqual(plain(segments.map(segment => [segment.start, segment.end, segment.requiresConfirmation])),
      [[70, 130, true], [start, 250, false]]);
    h.tick(80);
    assert.deepEqual(h.video.seeks, []);
    h.tick(start - 0.001);
    assert.deepEqual(h.video.seeks, []);
    h.tick(start);
    assert.deepEqual(h.video.seeks, [250.05]);
  }
});

test('every explicit ad chapter and description entry is kept, each skipped once', async () => {
  const h = createHarness({
    chapters: [{ from: 0, to: 60, content: '开场' }, { from: 60, to: 100, content: '广告' },
      { from: 100, to: 400, content: '正片' }, { from: 400, to: 440, content: '恰饭环节' }, { from: 440, to: 600, content: '结尾' }]
  });
  const segments = await h.detectAllAndAttach();
  assert.deepEqual(plain(segments.map(segment => [segment.start, segment.end, segment.source, segment.requiresConfirmation])),
    [[60, 100, 'chapters', false], [400, 440, 'chapters', false]]);
  h.tick(60); h.tick(200); h.tick(400);
  assert.deepEqual(h.video.seeks, [100.05, 440.05]);

  const described = createHarness({ videoInfo: { desc: '0:00 开场\n1:00 广告\n1:40 正片\n6:40 赞助\n7:20 结尾' } });
  assert.deepEqual(plain((await described.detectAllAndAttach()).map(segment => [segment.start, segment.end, segment.source])),
    [[60, 100, 'description'], [400, 440, 'description']]);
});

test('description timelines with hours are read whole; an ad entry without a next entry is not run to the end unprompted', async () => {
  // Reading only "58:00 广告" from this timeline used to make it the last entry
  // and seek from 58:00 to the end of the video.
  const hours = createHarness({ videoInfo: { duration: 3780, desc: '00:00 开场\n58:00 广告\n1:00:30 正片下半\n1:02:00 结尾' } });
  assert.deepEqual(plain((await hours.detectAllAndAttach()).map(segment => [segment.start, segment.end, segment.requiresConfirmation])),
    [[3480, 3630, false]]);
  hours.tick(3490);
  assert.deepEqual(hours.video.seeks, [3630.05]);

  const last = createHarness({ videoInfo: { duration: 600, desc: '0:00 开场\n1:00 正片\n8:20 广告' } });
  const [segment] = plain(await last.detectAllAndAttach());
  assert.deepEqual([segment.start, segment.end, segment.requiresConfirmation, segment.reason], [500, 600, true, 'label-without-end']);
  last.tick(510);
  assert.deepEqual(last.video.seeks, []);

  // Not a timeline: one stray time, times out of order, impossible clock values.
  for (const desc of ['8:20 广告', '8:20 广告\n1:00 正片', '0:00 开场\n1:75 广告\n3:00 正片', '0:00 开场\n1:70:00 广告\n2:00:00 正片']) {
    assert.deepEqual(plain(await createHarness({ videoInfo: { duration: 9000, desc } }).detectAllAndAttach()), [], desc);
  }
});

test('an unknown duration still honours the author\'s own chapter times', async () => {
  const h = createHarness({ videoInfo: { duration: 0, desc: '0:00 开场\n1:00 广告' }, chapters: [{ from: 70, to: 130, content: '广告' }],
    danmaku: [timestamp('跳过广告 4:10', 195)] });
  assert.deepEqual(plain((await h.detectAllAndAttach()).map(segment => [segment.start, segment.end, segment.source, segment.requiresConfirmation])),
    [[70, 130, 'chapters', false]]);
});

test('an explicit label with an implausible length is shown, not taken', async () => {
  for (const [from, to] of [[70, 75], [70, 400], [10, 590]]) {
    const h = createHarness({ chapters: [{ from, to, content: '广告' }] });
    const segment = await h.detectAndAttach();
    assert.equal(segment.requiresConfirmation, true, `${from}-${to}`);
    assert.equal(segment.reason, 'label-duration-needs-review');
    h.tick(from + 1);
    assert.deepEqual(h.video.seeks, []);
  }
});

test('description timestamps share the same label confidence policy', async () => {
  for (const [label, expected] of [['Download', null], ['无广告', null], ['广告历史', true], ['广告', false]]) {
    const h = createHarness({ videoInfo: { desc: `1:10 ${label}\n2:20 正片` } });
    const segment = await h.detectAndAttach();
    if (expected === null) assert.equal(segment, null);
    else assert.equal(segment.requiresConfirmation, expected);
    h.tick(80);
    assert.equal(h.video.seeks.length, expected === false ? 1 : 0);
  }
});

test('非常感谢 does not negate a valid skip instruction', async () => {
  // Typed well before 2:00, so it points there; "非常" is not a denial.
  const h = createHarness({ danmaku: [timestamp('非常感谢，跳过广告2:00')] });
  const segment = await h.detectAndAttach();
  assert.equal(segment.requiresConfirmation, false);
  h.tick(80);
  assert.deepEqual(h.video.seeks, [120.05]);
  // The same thanks posted on arrival confirms the destination instead.
  const arrived = createHarness({ danmaku: [timestamp('空降2:00'), timestamp('非常感谢，空降2:00', 121)] });
  assert.equal((await arrived.detectAndAttach()).requiresConfirmation, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');
const { timestamp } = require('./fixtures.cjs');

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
    const segment = await h.detectAndAttach();
    assert.equal(segment.start, start);
    assert.equal(segment.end, 250);
    h.tick(80);
    assert.deepEqual(h.video.seeks, []);
    h.tick(start - 0.001);
    assert.deepEqual(h.video.seeks, []);
    h.tick(start);
    assert.deepEqual(h.video.seeks, [250.05]);
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
  const h = createHarness({ danmaku: [timestamp('非常感谢，空降2:00')] });
  const segment = await h.detectAndAttach();
  assert.equal(segment.requiresConfirmation, false);
  h.tick(80);
  assert.deepEqual(h.video.seeks, [120.05]);
});

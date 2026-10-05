const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');
const { timestamp } = require('./fixtures.cjs');

test('real early advertisement: explicit ad + skip instruction survives the opening guard', async () => {
  // BV1iH4y1w7i2 public XML; video points 46.35 and 81.35 show product promotion,
  // subtitles return to lake physics at 91.1. This is not a complete gold annotation.
  const h = createHarness({
    videoInfo: { duration: 291 },
    danmaku: [timestamp('恭喜接广！跳伞01:32', 34.751)]
  });
  const segment = await h.detectAndAttach();
  assert.equal(segment.start, 34.751);
  assert.equal(segment.end, 92);
  assert.equal(segment.earlyAdEvidence, true);
  h.tick(34.75);
  assert.deepEqual(h.video.seeks, []);
  h.tick(segment.start);
  assert.deepEqual(h.video.seeks, [92.05]);
});

test('opening guard still applies to general jumps, bare times and negated ads', async () => {
  for (const text of ['空降1:32', '1:32', '不是广告，跳伞1:32', '不要跳过广告1:32', '非恰饭，空降1:32', '非赞助，空降1:32', '广告里讲的游戏，空降01:32看操作']) {
    const h = createHarness({ danmaku: [timestamp(text, 34.751)] });
    assert.equal(await h.detectAndAttach(), null, text);
    h.tick(40);
    assert.deepEqual(h.video.seeks, [], text);
  }
});

test('explicit early ad still rejects malformed, oversized and end-of-video intervals', async () => {
  for (const [time, text] of [[-2, '跳过广告1:32'], [20, '跳过广告9:00'], [20, '跳过广告0:29'], [20, '跳过广告9:50']]) {
    const h = createHarness({ danmaku: [timestamp(text, time)] });
    assert.equal(await h.detectAndAttach(), null, text);
  }
});

test('an explicit early timestamp keeps the exact ten-second minimum', async () => {
  const h = createHarness({ danmaku: [timestamp('跳过广告0:30', 20)] });
  const segment = await h.detectAndAttach();
  assert.equal(segment.start, 20);
  assert.equal(segment.end, 30);
  h.tick(19.999);
  assert.deepEqual(h.video.seeks, []);
  h.tick(20);
  assert.deepEqual(h.video.seeks, [30.05]);
});

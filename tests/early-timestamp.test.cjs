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
  assert.equal(await createHarness({ danmaku: [timestamp('跳过广告0:29', 20)] }).detectAndAttach(), null);
});

test('the first thirty seconds are offered, never skipped unprompted', async () => {
  // Jumps this early mostly skip intros. Even with a sign of an ad, the reviewed
  // videos had more intros than ads here (5 of 13), so the viewer decides.
  const h = createHarness({ danmaku: [timestamp('跳过广告0:45', 8), timestamp('空降00:45', 9), timestamp('恭喜接广', 12)] });
  const segment = await h.detectAndAttach();
  assert.deepEqual([segment.start, segment.end, segment.requiresConfirmation], [8, 45, true]);
  h.tick(10);
  assert.deepEqual(h.video.seeks, []);
  h.button.click();
  assert.deepEqual(h.video.seeks, [45.05]);
  // A long jump from the opening is navigation, not a pre-roll ad.
  assert.equal(await createHarness({ danmaku: [timestamp('跳过广告5:19', 1), timestamp('恭喜接广', 3)] }).detectAndAttach(), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

test('Issue #14: actual 种草 + 性价比 at 78.54/152.96 seconds do not create an ad', async () => {
  // BV1GxdRBJE6u / CID 37625333201, official AI subtitles collected 2026-09-30.
  // Keep the two exact legacy keyword hits plus three actual neutral rows.
  // Replaying the full 154-row transcript on 88652 yields 78.54–154.72 and an
  // automatic seek to 154.77; this reduced fixture also exercises its >=5-row gate.
  const subtitles = [
    { from: 0.08, to: 1.46, content: '家居废物坑货多' },
    { from: 1.46, to: 2.82, content: '有用东西真不多' },
    { from: 2.82, to: 4.66, content: '今天我又是从粑粑里淘金' },
    { from: 78.54, to: 80.92, content: '我是看了网上那些种草视频买的哈' },
    { from: 152.96, to: 154.72, content: '总体来说性价比还算不错' }
  ];
  const h = createHarness({ videoInfo: { cid: 37625333201, duration: 237 }, subtitles });
  assert.equal(await h.detectAndAttach('auto'), null);
  h.tick(78.54);
  h.tick(79);
  h.tick(152.96);
  h.advanceTimers(10000);
  assert.deepEqual(h.video.seeks, []);
  assert.equal(h.button.parentElement, null);
});

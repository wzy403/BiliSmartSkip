const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

function attach(segments, mode = 'auto') {
  const h = createHarness();
  h.setMode(mode);
  h.context.__segments = segments;
  h.evaluate('currentVideo = __video; attachSkipper(__segments)');
  return h;
}
const automatic = (start, end) => ({ start, end, source: 'fixture', requiresConfirmation: false });

test('each independent break skips once without seeking the intervening narrative', () => {
  const h = attach([automatic(40, 65), automatic(150, 190)]);
  h.tick(40); h.tick(45); h.tick(65); h.tick(100);
  assert.deepEqual(h.video.seeks, [65.05]);
  h.tick(150); h.tick(155); h.tick(40);
  assert.deepEqual(h.video.seeks, [65.05, 190.05]);
  assert.equal(h.evaluate('skippedSegments.size'), 2);
});

test('trust remains per interval across automatic and manual breaks', () => {
  const h = attach([automatic(40, 65), { start: 100, end: 130, requiresConfirmation: true }, automatic(150, 190)]);
  h.tick(40); h.tick(100); h.advanceTimers(12000);
  assert.deepEqual(h.video.seeks, [65.05]);
  h.tick(150);
  assert.deepEqual(h.video.seeks, [65.05, 190.05]);
});

test('a button from the preceding segment cannot seek to its stale end', () => {
  const h = attach([automatic(40, 65), automatic(150, 190)], 'manual');
  h.tick(40); h.tick(150); h.button.click();
  assert.deepEqual(h.video.seeks, [190.05]);
  h.tick(100);
  assert.equal(h.button.parentElement, null);
  assert.equal(h.evaluate('currentAdSegment'), null);
});

test('reattaching a replacement player preserves independent skip history', () => {
  const h = attach([automatic(40, 65), automatic(150, 190)]);
  h.tick(40);
  h.evaluate('attachSkipper(__segments)');
  h.tick(40); h.tick(150);
  assert.deepEqual(h.video.seeks, [65.05, 190.05]);
  assert.equal(h.video.listeners.get('timeupdate').length, 1);
});

test('navigation cleanup resets all interval history', () => {
  const h = attach([automatic(40, 65), automatic(150, 190)]);
  h.tick(40);
  h.evaluate('cleanUp(); currentVideo = __video; attachSkipper(__segments)');
  h.tick(40);
  assert.deepEqual(h.video.seeks, [65.05, 65.05]);
});

test('explicit publisher boundaries win overlaps; independent later breaks survive', () => {
  const h = createHarness();
  const chapter = { ...automatic(60, 120), source: 'chapters' };
  const result = h.context.combineSkipSegments(chapter, [automatic(55, 119), automatic(160, 190)]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [chapter, automatic(160, 190)]);
});

test('source agreement refines timestamp start without stretching conflicting destinations', () => {
  const h = createHarness();
  const timestamp = { ...automatic(75, 120), source: 'danmaku-time' };
  assert.equal(h.context.combineSkipSegments(timestamp, [automatic(60, 119)])[0].start, 60);
  assert.equal(h.context.combineSkipSegments(timestamp, [automatic(60, 180)])[0].start, 75);
  assert.equal(h.context.combineSkipSegments(timestamp, [{ ...automatic(60, 119), requiresConfirmation: true }])[0].start, 75);
});

test('keep annotations cannot enter the skip schedule', () => {
  const h = createHarness();
  assert.equal(h.context.combineSkipSegments(null, [{ ...automatic(60, 120), skipDecision: 'keep' }]).length, 0);
});

test('all-segment pipeline fetches subtitle body once and falls back on module failure', async () => {
  const h = createHarness({ subtitles: [{ from: 70, to: 75, content: '普通正文' }] });
  h.context.BiliSegmentDetector = { detectSegments() { throw new Error('fixture error'); } };
  const segments = await h.detectAllAndAttach();
  assert.equal(segments.length, 0);
  assert.equal(h.subtitleFetches, 1);
  assert.ok(h.logs.some(log => log.level === 'warn' && String(log.args[0]).includes('complete-segment detection failed')));
});

test('a timestamp conflicting with an explicit return cannot silently override structural evidence', async () => {
  const h = createHarness({ subtitles: [
    { from: 70, to: 73, content: '本视频由某品牌赞助' },
    { from: 73, to: 80, content: '这款产品功能很多' },
    { from: 80, to: 85, content: '新人领取优惠券' },
    { from: 85, to: 95, content: '现在点击评论区链接购买下单' },
    { from: 100, to: 104, content: '现在回到视频' },
    { from: 104, to: 160, content: '以下全是正常正文' }
  ], danmaku: [{ time: 74, textContent: '跳过广告3:00' }] });
  const result = await h.detectAllAndAttach();
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, 'cross-source-boundary-conflict');
  assert.equal(result[0].start, 70);
  assert.equal(result[0].end, 95);
  assert.equal(result[0].conflictingTimestamp.end, 180);
  h.tick(79);
  assert.deepEqual(h.video.seeks, []);
});

test('observed promotion continuing past a timestamp prevents automatic truncation', () => {
  const h = createHarness();
  const primary = { ...automatic(80, 120), source: 'danmaku-time' };
  const result = h.context.combineSkipSegments(primary, [{ start: 70, end: 132, source: 'segment-detector',
    requiresConfirmation: true, boundaryEvidence: { end: { kind: 'commercial-continuation-after-timestamp' } } }]);
  assert.equal(result[0].end, 132);
  assert.equal(result[0].requiresConfirmation, true);
  assert.equal(result[0].reason, 'cross-source-boundary-conflict');
});

test('contradictory community endpoints cannot regain trust through the primary fallback', () => {
  const h = createHarness();
  const result = h.context.combineSkipSegments({ ...automatic(80, 120), source: 'danmaku-time' }, [
    { start: 70, end: 120, source: 'segment-detector', requiresConfirmation: true,
      reviewReasons: ['conflicting-time-destinations'], boundaryEvidence: { alternativeEnds: [{ end: 180 }] } }
  ]);
  assert.equal(result[0].start, 70);
  assert.equal(result[0].end, 120);
  assert.equal(result[0].requiresConfirmation, true);
  assert.equal(result[0].conflictingTimestamp.end, 120);
});

test('an explicit return remains contrary end evidence when subtitle continuity is uncertain', async () => {
  const h = createHarness({ subtitles: [
    { from: 80, to: 83, content: '本视频由某品牌赞助' },
    { from: 96, to: 100, content: '这款产品功能很多' },
    { from: 100, to: 105, content: '原理是普通物理知识' },
    { from: 105, to: 110, content: '新人可以免费试用' },
    { from: 110, to: 118, content: '现在点击评论区链接领取优惠券' },
    { from: 120, to: 124, content: '现在回到视频' },
    { from: 124, to: 170, content: '以下全是正常正文' }
  ], danmaku: [{ time: 85, textContent: '跳过广告3:00' }] });
  const result = await h.detectAllAndAttach();
  assert.equal(result[0].end, 118);
  assert.equal(result[0].requiresConfirmation, true);
  assert.equal(result[0].reason, 'cross-source-boundary-conflict');
  h.tick(90);
  assert.deepEqual(h.video.seeks, []);
});

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

const plain = value => JSON.parse(JSON.stringify(value));
const from = (source, start, end, extra = {}) => ({ ...automatic(start, end), source, ...extra });

test('explicit publisher boundaries win overlaps; independent later breaks survive', () => {
  const h = createHarness();
  const chapter = from('chapters', 60, 120);
  const result = h.context.reconcileSegments([from('segment-detector', 55, 119), from('danmaku-time', 160, 190), chapter]);
  assert.deepEqual(plain(result), [chapter, from('danmaku-time', 160, 190)]);
});

test('an author label is not put in doubt by what viewers typed', () => {
  const h = createHarness();
  const result = h.context.reconcileSegments([from('chapters', 60, 120), from('danmaku-time', 70, 200)]);
  assert.deepEqual(plain(result), [from('chapters', 60, 120)]);
});

test('inferred sources that agree on the end keep the better-ranked interval automatic', () => {
  const h = createHarness();
  // A complete sponsor break supplies the start a late comment missed.
  const agreed = h.context.reconcileSegments([from('danmaku-time', 75, 120), from('segment-detector', 60, 119)]);
  assert.deepEqual(plain(agreed), [from('segment-detector', 60, 119)]);
  // Still needing confirmation, it yields to the corroborated destination instead.
  const weaker = h.context.reconcileSegments([from('danmaku-time', 75, 120),
    from('segment-detector', 60, 119, { requiresConfirmation: true })]);
  assert.deepEqual(plain(weaker), [from('danmaku-time', 75, 120)]);
});

test('inferred sources that disagree on the end are shown, never taken unprompted', () => {
  const h = createHarness();
  const [result] = h.context.reconcileSegments([from('danmaku-time', 75, 120), from('segment-detector', 60, 180)]);
  assert.deepEqual([result.start, result.end, result.source], [60, 180, 'segment-detector']);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.reason, 'cross-source-boundary-conflict');
  assert.deepEqual(plain(result.conflictingSegment), { start: 75, end: 120, source: 'danmaku-time' });
});

test('transcript wording yields to an interval with an observed start and end', () => {
  const h = createHarness();
  const block = from('subtitles', 70, 118, { requiresConfirmation: true });
  const sponsorBreak = from('segment-detector', 80, 112, { requiresConfirmation: true });
  const jump = from('danmaku-time', 82, 115, { requiresConfirmation: true });
  assert.deepEqual(plain(h.context.reconcileSegments([block, sponsorBreak])), [sponsorBreak]);
  assert.deepEqual(plain(h.context.reconcileSegments([block, sponsorBreak, jump])), [jump]);
});

test('keep annotations and malformed intervals cannot enter the skip schedule', () => {
  const h = createHarness();
  assert.equal(h.context.reconcileSegments([{ ...automatic(60, 120), skipDecision: 'keep' }, null,
    automatic(NaN, 100), automatic(100, 100), automatic(-5, 20), automatic(90, 80)]).length, 0);
});

test('the pipeline fetches the subtitle body once and reports a failing module', async () => {
  const h = createHarness({ subtitles: [{ from: 70, to: 75, content: '普通正文' }] });
  h.context.BiliSegmentDetector = { detectSegments() { throw new Error('fixture error'); } };
  const segments = await h.detectAllAndAttach();
  assert.equal(segments.length, 0);
  assert.equal(h.subtitleFetches, 1);
  assert.ok(h.logs.some(log => log.level === 'warn' && String(log.args[0]).includes('sponsor-break detection failed')));
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
  assert.equal(result[0].conflictingSegment.end, 180);
  h.tick(79);
  assert.deepEqual(h.video.seeks, []);
  h.button.click();
  assert.deepEqual(h.video.seeks, [95.05]);
});

test('the same explicit return and destination in agreement skip automatically', async () => {
  const h = createHarness({ subtitles: [
    { from: 70, to: 73, content: '本视频由某品牌赞助' },
    { from: 73, to: 80, content: '这款产品功能很多' },
    { from: 80, to: 85, content: '新人领取优惠券' },
    { from: 85, to: 95, content: '现在点击评论区链接购买下单' },
    { from: 100, to: 104, content: '现在回到视频' },
    { from: 104, to: 160, content: '以下全是正常正文' }
  ], danmaku: [{ time: 74, textContent: '跳过广告1:36' }] });
  const result = await h.detectAllAndAttach();
  assert.equal(result.length, 1);
  assert.equal(result[0].requiresConfirmation, false);
  assert.equal(result[0].start, 70);
  h.tick(79);
  assert.equal(h.video.seeks.length, 1);
  assert.ok(Math.abs(h.video.seeks[0] - 95.5) <= 1);
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
  assert.equal(result.length, 1);
  assert.equal(result[0].end, 118);
  assert.equal(result[0].requiresConfirmation, true);
  assert.equal(result[0].reason, 'cross-source-boundary-conflict');
  assert.equal(result[0].conflictingSegment.end, 180);
  h.tick(90);
  h.tick(130);
  assert.deepEqual(h.video.seeks, [], 'a typed destination cannot carry the viewer past the speaker\'s own return');
});

test('a spoken return only overrides a destination that lands beyond it; results never overlap', () => {
  const h = createHarness();
  const spoken = (start, end) => from('segment-detector', start, end,
    { requiresConfirmation: true, boundaryEvidence: { end: { kind: 'explicit-return' } } });
  const shape = proposals => plain(h.context.reconcileSegments(proposals))
    .map(segment => [segment.start, segment.end, segment.source, segment.requiresConfirmation]);
  // Destination before the return: the viewer lands inside the ad, which is harmless.
  assert.deepEqual(shape([from('chapters', 150, 200), from('danmaku-time', 70, 140), spoken(60, 170)]),
    [[70, 140, 'danmaku-time', false], [150, 200, 'chapters', false]]);
  // Destination past the return: follow the transcript, and ask first.
  assert.deepEqual(shape([from('chapters', 150, 200), from('danmaku-time', 70, 140), spoken(60, 120)]),
    [[60, 120, 'segment-detector', true], [150, 200, 'chapters', false]]);
  // The same holds for a jump that already needed confirmation: its button must not carry the viewer past the return.
  assert.deepEqual(shape([from('danmaku-time', 100, 230, { requiresConfirmation: true }), spoken(95, 190)]),
    [[95, 190, 'segment-detector', true]]);
  // The transcript interval would run into another selection: keep the jump's bounds, still ask first.
  assert.deepEqual(shape([from('danmaku-time', 70, 140), from('danmaku-time', 30, 65), spoken(60, 120)]),
    [[30, 65, 'danmaku-time', false], [70, 140, 'danmaku-time', true]]);
});

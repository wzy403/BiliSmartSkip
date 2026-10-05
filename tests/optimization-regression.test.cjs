const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProduction } = require('../eval/runner.cjs');
const originalAd = require('./fixtures/danmaku-false-positive-BV1r1421r7am.json');
const naturalPromotion = require('./fixtures/natural-promotion.json');

// Algorithm changes live in the production worktree; fixtures and checks stay
// on test-branch. Set the environment variable when checking another snapshot.
const sourceDir = require('./source-directory.cjs');
const production = loadProduction(null, { sourceDir: path.resolve(sourceDir) });
const harness = fixture => production.createHarness(fixture);
const fromSavedInput = (fixture, danmaku = fixture.danmaku) => harness({
  videoInfo: fixture.video,
  chapters: fixture.chapters,
  subtitles: fixture.subtitles,
  danmaku
});

test('original corrected user case selects the actual late ad instead of an earlier general jump', async () => {
  // The fixture name predates the user's correction. It is an anonymous XML
  // snapshot without subtitles, not evidence that this video has no ad.
  // Human correction: about 351–372 seconds; separate from the 438 benchmark.
  const h = fromSavedInput(originalAd);
  const segments = await h.detectAllAndAttach('auto');
  const ad = segments.find(segment => segment.start >= 346 && segment.start <= 356
    && segment.end >= 367 && segment.end <= 377);
  assert.ok(ad, 'retain the ad supported by the late jump and nearby ad reactions');
  h.tick(294.089);
  h.advanceTimers(10000);
  assert.deepEqual(Array.from(h.video.seeks), [], 'the earlier 空降05:26 is not ad evidence');
  h.tick(ad.start);
  assert.deepEqual(Array.from(h.video.seeks), [ad.end + 0.05]);
  h.tick(ad.start);
  assert.equal(h.video.seeks.length, 1, 'the same ad only skips once');
});

test('saved natural promotion recovers the complete break and performs the actual seek', async () => {
  // Complete saved signed-in subtitles, but only THREE retained time comments
  // from a summary of 675 comments. Never call this a complete logged-in replay.
  // User estimate 145–190; the subtitle transition starts at 141.12.
  const h = fromSavedInput(naturalPromotion, naturalPromotion.danmakuSample);
  const segments = await h.detectAllAndAttach('auto');
  const ad = segments.find(segment => segment.start >= 136 && segment.start <= 150
    && segment.end >= 185 && segment.end <= 195);
  assert.ok(ad, 'a late CTA fragment alone does not recover the natural promotion');
  h.tick(130);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.tick(ad.start);
  assert.deepEqual(Array.from(h.video.seeks), [ad.end + 0.05]);
  h.tick(193.538);
  assert.equal(h.video.seeks.length, 1, 'post-ad thanks cannot cause another jump');
});

test('saved compact and dotted engineering timestamps parse without reinterpreting a thank-you as a command', () => {
  const h = harness();
  for (const text of ['310认证成功', '3.10工程']) {
    assert.equal(h.context.extractTimeFromText(text)?.time, 190, text);
  }
  assert.equal(h.context.findAdTimestamps([
    { time: 193.538, textContent: '感谢310工程' }
  ], 633), null);
});

test('ordinary buying reactions do not create an advertising interval on their own', async () => {
  const h = harness({
    videoInfo: { title: '手机自购评测', duration: 600 },
    subtitles: [
      { from: 65, to: 70, content: '下面看屏幕的测试结果' },
      { from: 80, to: 85, content: '这一项是白天的亮度表现' },
      { from: 100, to: 105, content: '接下来看看夜间的使用效果' },
      { from: 120, to: 125, content: '续航测试已经完成' },
      { from: 140, to: 145, content: '下面是其他机型的对照结果' }
    ],
    danmaku: [
      { time: 80, textContent: '买了' },
      { time: 110, textContent: '已经下单' },
      { time: 130, textContent: '期待发货' }
    ]
  });
  assert.equal((await h.detectAllAndAttach('auto')).length, 0);
  h.tick(80);
  h.advanceTimers(10000);
  assert.deepEqual(Array.from(h.video.seeks), []);
});

test('an isolated sponsor credit is kept wherever it occurs in the video', async () => {
  for (const start of [35, 240]) {
    const h = harness({
      subtitles: [
        { from: start - 5, to: start, content: '我们继续刚才的故事' },
        { from: start, to: start + 3, content: '感谢某品牌对本期视频的赞助' },
        { from: start + 3, to: start + 8, content: '现在回到视频' },
        { from: start + 8, to: start + 13, content: '主角随后来到城市的另一边' },
        { from: start + 13, to: start + 18, content: '故事还有很多没有解释的细节' }
      ]
    });
    assert.equal((await h.detectAllAndAttach('auto')).length, 0, `credit at ${start}`);
    h.tick(start);
    h.advanceTimers(10000);
    assert.deepEqual(Array.from(h.video.seeks), []);
  }
});

test('sponsor credit followed by a full promotion remains a complete skip interval', async () => {
  const h = harness({
    subtitles: [
      { from: 75, to: 80, content: '接下来先暂停一下刚才的故事' },
      { from: 80, to: 83, content: '感谢某品牌对本期视频的赞助' },
      { from: 83, to: 88, content: '这款产品可以完成多种功能' },
      { from: 88, to: 94, content: '新用户可以领取优惠券并免费试用' },
      { from: 94, to: 100, content: '现在点击评论区链接购买下单' },
      { from: 100, to: 105, content: '现在回到视频' },
      { from: 105, to: 110, content: '我们继续分析故事中的人物' }
    ],
    danmaku: [
      { time: 86, textContent: '买了' },
      { time: 96, textContent: '下单了' }
    ]
  });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 80);
  assert.equal(segments[0].end, 100);
  h.tick(80);
  assert.deepEqual(Array.from(h.video.seeks), [100.05]);
});

test('a timestamp aligns to the next nearby subtitle phrase without skipping the preceding sentence', async () => {
  const h = harness({
    subtitles: [
      { from: 75, to: 82, content: '我们先把刚才的故事完整讲完' },
      { from: 83.2, to: 88, content: '新用户可以领取优惠券' },
      { from: 88, to: 94, content: '这款产品可以完成多种功能' },
      { from: 94, to: 100, content: '点击评论区链接领取优惠' },
      { from: 100, to: 120, content: '接着介绍本次活动的细节' },
      { from: 120, to: 126, content: '我们继续讲故事' }
    ],
    danmaku: [{ time: 80.4, textContent: '跳过广告2:00' }]
  });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 83.2);
  assert.equal(segments[0].end, 120);
  h.tick(80.4);
  h.tick(83.199);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.tick(83.2);
  assert.deepEqual(Array.from(h.video.seeks), [120.05]);
});

test('a lone anticipatory jump cannot pull a repeated local timestamp cluster into the story', async () => {
  const h = harness({ danmaku: [
    { time: 105, textContent: '跳伞2:40' },
    { time: 65, textContent: '空降2:40' },
    { time: 60, textContent: '看看2:40的画面' },
    { time: 100, textContent: '空降2:40' }
  ] });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 100);
  assert.equal(segments[0].end, 160);
  h.tick(65);
  h.tick(99.999);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.tick(100);
  assert.deepEqual(Array.from(h.video.seeks), [160.05]);
});

test('a generic jump across ordinary subtitles remains manual and still accepts a user click', async () => {
  const h = harness({
    subtitles: [
      { from: 70, to: 80, content: '这一关需要等待角色走完楼梯' },
      { from: 80, to: 90, content: '现在检查房间的左侧' },
      { from: 90, to: 100, content: '然后从另一扇门出去' },
      { from: 100, to: 120, content: '最后沿着原来的路线返回' },
      { from: 120, to: 130, content: '下一关马上开始' }
    ],
    danmaku: [{ time: 80, textContent: '空降2:00' }]
  });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 80);
  assert.equal(segments[0].end, 120);
  assert.equal(segments[0].requiresConfirmation, true);
  h.tick(80);
  h.tick(90);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.button.click();
  assert.deepEqual(Array.from(h.video.seeks), [120.05]);
});

test('a local promotion plus its route corroborates a generic jump; either signal alone does not', async () => {
  for (const [promotion, route, automatic] of [[true, false, false], [false, true, false], [true, true, true]]) {
    const h = harness({
      subtitles: [
        // An unrelated earlier promotion must not corroborate this interval.
        { from: 10, to: 14, content: '平台正在周年大促' },
        { from: 70, to: 80, content: '这一段即将开始' },
        { from: 80, to: 90, content: promotion ? '平台正在周年大促' : '现在检查房间的左侧' },
        { from: 90, to: 100, content: '下面展示具体的内容' },
        { from: 100, to: 110, content: route ? '点击视频下方的链接' : '然后从另一扇门出去' },
        { from: 110, to: 120, content: '这一部分就介绍到这里' },
        { from: 120, to: 130, content: '下一段马上开始' }
      ],
      danmaku: [{ time: 80, textContent: '空降2:00' }]
    });
    const segments = await h.detectAllAndAttach('auto');
    assert.equal(segments.length, 1, `promotion=${promotion}, route=${route}`);
    assert.equal(segments[0].requiresConfirmation, !automatic);
    assert.equal(segments[0].start, 80);
    assert.equal(segments[0].end, 120);
    h.tick(80);
    assert.deepEqual(Array.from(h.video.seeks), automatic ? [120.05] : []);
  }
});

const ordinaryJumpInput = (reactions = []) => ({
  subtitles: [
    { from: 70, to: 80, content: '这一关需要等待角色走完楼梯' },
    { from: 80, to: 90, content: '现在检查房间的左侧' },
    { from: 90, to: 100, content: '然后从另一扇门出去' },
    { from: 100, to: 120, content: '最后沿着原来的路线返回' },
    { from: 120, to: 130, content: '下一关马上开始' }
  ],
  danmaku: [{ time: 80, textContent: '空降2:00' }, ...reactions]
});

test('complete-detector failure retains the refined manual fallback for a generic jump', async () => {
  const h = harness(ordinaryJumpInput());
  h.context.BiliSegmentDetector = { detectSegments() { throw new Error('regression: detector failure'); } };
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 80);
  assert.equal(segments[0].end, 120);
  assert.equal(segments[0].requiresConfirmation, true);
  assert.ok(h.logs.some(log => log.level === 'warn' && String(log.args[0]).includes('complete-segment detection failed')));
  h.tick(80);
  h.tick(90);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.button.click();
  assert.deepEqual(Array.from(h.video.seeks), [120.05]);
});

test('negative advertisement reactions cannot authorize an otherwise unsupported automatic jump', async () => {
  for (const textContent of ['不含广告', '非广告', '拒绝商单']) {
    const h = harness(ordinaryJumpInput([{ time: 90, textContent }]));
    const segments = await h.detectAllAndAttach('auto');
    assert.equal(segments.length, 1, textContent);
    assert.equal(segments[0].requiresConfirmation, true, textContent);
    h.tick(80);
    h.tick(90);
    h.advanceTimers(10000);
    assert.deepEqual(Array.from(h.video.seeks), [], textContent);
  }
});

test('explicit promotion-start and return clusters retain their complete manual interval', async () => {
  const h = harness({ danmaku: [
    { time: 100, textContent: '开始推广' },
    { time: 102, textContent: '开始推广啦' },
    { time: 150, textContent: '回归正片' },
    { time: 152, textContent: '回归正片了' }
  ] });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 100);
  assert.equal(segments[0].end, 152);
  assert.equal(segments[0].requiresConfirmation, true);
  h.tick(100);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.button.click();
  assert.deepEqual(Array.from(h.video.seeks), [152.05]);
});

test('a distant advertisement reaction cannot outweigh a locally repeated earlier destination', async () => {
  const h = harness({ danmaku: [
    { time: 90, textContent: '空降03:40' },
    { time: 100, textContent: '空降03:00' },
    { time: 101, textContent: '跳伞03:00' },
    { time: 102, textContent: '空降03:00' },
    { time: 200, textContent: '广告来了' }
  ] });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 100);
  assert.equal(segments[0].end, 180);
  h.tick(90);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.tick(100);
  assert.deepEqual(Array.from(h.video.seeks), [180.05]);
});

test('a support credit followed by product explanation and an outro retains the whole manual break', async () => {
  const h = harness({ subtitles: [
    { from: 70, to: 80, content: '故事到这里就告一段落了' },
    { from: 80, to: 83, content: '感谢某品牌对本期视频的支持' },
    { from: 83, to: 88, content: '这款产品采用原创设计' },
    { from: 88, to: 95, content: '它的智能化配置提供更多定制选项' },
    { from: 95, to: 100, content: '让日常操作更加方便' },
    { from: 100, to: 105, content: '今天的视频就结束了' },
    { from: 105, to: 110, content: '我们下次再见' }
  ] });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 80);
  assert.equal(segments[0].end, 100);
  assert.equal(segments[0].requiresConfirmation, true);
  h.tick(80);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.button.click();
  assert.deepEqual(Array.from(h.video.seeks), [100.05]);
});

test('an isolated support thank-you cannot open an ad over the remaining story', async () => {
  const h = harness({ subtitles: [
    { from: 70, to: 80, content: '接下来继续分析人物的动机' },
    { from: 80, to: 83, content: '感谢大家对本期视频的支持' },
    { from: 83, to: 90, content: '我们回顾一下刚才发生的事情' },
    { from: 90, to: 100, content: '主角其实一直都知道答案' },
    { from: 100, to: 105, content: '今天的视频就结束了' }
  ] });
  assert.equal((await h.detectAllAndAttach('auto')).length, 0);
  h.tick(80);
  h.tick(90);
  assert.deepEqual(Array.from(h.video.seeks), []);
});

test('a request to like the video before the product pitch cannot truncate the sponsor break', async () => {
  const h = harness({ subtitles: [
    { from: 70, to: 80, content: '接下来介绍本期的合作伙伴' },
    { from: 80, to: 83, content: '本视频由某品牌赞助' },
    { from: 83, to: 87, content: '如果你喜欢本视频请继续关注' },
    { from: 87, to: 94, content: '这款产品采用原创设计' },
    { from: 94, to: 102, content: '智能化配置可以提供更多定制选项' },
    { from: 102, to: 112, content: '看起来简洁也方便收纳' },
    { from: 112, to: 116, content: '感谢观看' }
  ] });
  const segments = await h.detectAllAndAttach('auto');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 80);
  assert.equal(segments[0].end, 112);
  assert.equal(segments[0].requiresConfirmation, true);
  h.tick(80);
  assert.deepEqual(Array.from(h.video.seeks), []);
  h.button.click();
  assert.deepEqual(Array.from(h.video.seeks), [112.05]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

const line = (from, content, length = 2) => ({ from, to: from + length, content });
const detect = (subtitles, danmaku = []) => createHarness().context.detectFromSubtitles(subtitles, danmaku);

test('ordinary free/search/purchase/cooperation words do not establish an ad', () => {
  for (const subtitles of [
    [line(79, '这个工具是免费的'), line(99, '搜索你想了解的内容')],
    [line(141.38, '你拿金币购买的武器'), line(261.789, '一部分可购买资源'), line(263.589, '一部分不可购买资源'), line(367.34, '只能购买六个')],
    [line(835.2, '日本从英国和法国购买的装甲巡洋舰'), line(850, '两国合作建造军舰')],
    [line(100, '欢迎在评论区讨论'), line(108, '点赞关注推荐给大家')],
    [line(100, '点击链接查看免费教程'), line(108, '评论区下载资料')]
  ]) assert.equal(detect(subtitles), null);
});

test('local sponsorship plus a concrete offer retains a manual candidate', () => {
  const result = detect([line(100, '本期视频由某品牌赞助'), line(114, '新用户专属优惠券')]);
  assert.ok(result);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.reason, 'subtitle-sponsor-offer');
  assert.deepEqual([result.start, result.end], [100, 116]);
});

test('a sponsorship mention without a nearby offer does not bridge a topic', () => {
  assert.equal(detect([line(100, '本期视频由某品牌赞助'), line(150, '注册免费体验课程')]), null);
  assert.equal(detect([line(100, '这里讨论商业赞助'), line(110, '新用户有优惠券')]), null);
});

test('a single explicit CTA produces only a bounded manual hint, independent of danmaku', async () => {
  const subtitles = [line(323.91, '现在点击下方评论区链接就能直达服饰会场', 3.43)];
  const danmaku = [{ time: 207.593, textContent: '我女票买了同款' }];
  const result = detect(subtitles, danmaku);
  assert.equal(result.start, 318.91);
  assert.ok(Math.abs(result.end - 332.34) < 0.001);
  assert.equal(result.boundaryPaddingSeconds, 5);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.reason, 'subtitle-local-cta');
  const h = createHarness({ subtitles, danmaku });
  const selected = await h.detectAndAttach('auto');
  assert.equal(selected.source, 'subtitles');
  h.tick(selected.start);
  h.advanceTimers(10_000);
  assert.deepEqual(h.video.seeks, []);
  const manual = createHarness({ subtitles, danmaku });
  const manualSegment = await manual.detectAndAttach('auto');
  manual.tick(manualSegment.start);
  manual.button.click();
  assert.deepEqual(manual.video.seeks, [manualSegment.end + 0.05]);
});

test('single transaction instructions are retained without a brand dictionary', () => {
  const result = detect([line(196.6, '一键下单就能通通打包带走', 2.28)]);
  assert.ok(result);
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.end - result.start < 13);
  assert.equal(detect([line(196.6, '我刚刚下单了'), line(202, '他也购买了')]), null);
});

test('a CTA split across adjacent subtitle rows is recognized', () => {
  const result = detect([line(100, '请点击'), line(102, '评论区置顶链接'), line(104, '领取专属优惠券')]);
  assert.ok(result);
  assert.ok(result.matchedKeywords.some(value => value.includes('点击评论区置顶链接')));
  assert.equal(result.requiresConfirmation, true);
});

test('distant rows cannot be combined into one artificial CTA', () => {
  assert.equal(detect([line(100, '请点击'), line(130, '评论区置顶链接')]), null);
});

test('negated sponsor and purchase instructions are not positive evidence', () => {
  for (const text of [
    '本期视频不是由任何公司赞助',
    '本期视频没有赞助',
    '不要点击评论区链接领取优惠券',
    '千万别点击评论区链接',
    '禁止点击链接购买'
  ]) assert.equal(detect([line(100, text)]), null, text);
  assert.equal(detect([line(100, '千万不要'), line(102, '点击链接购买商品')]), null);
});

test('English sponsorship survives whitespace normalization', () => {
  const result = detect([line(100, 'This video is sponsored by Example'), line(110, '新用户优惠券')]);
  assert.ok(result);
  assert.equal(result.reason, 'subtitle-sponsor-offer');
  assert.equal(result.requiresConfirmation, true);
});

test('a generic route needs nearby commercial evidence', () => {
  assert.equal(detect([line(100, '点击下方链接')]), null);
  const result = detect([line(100, '点击下方链接'), line(110, '领取新用户优惠券')]);
  assert.ok(result);
  assert.equal(result.requiresConfirmation, true);
});

test('a negative clause does not erase an independent positive clause', () => {
  const result = detect([line(100, '不要乱买，点击下方蓝链领取优惠券')]);
  assert.ok(result);
  assert.equal(result.requiresConfirmation, true);
});

test('real sausage-history purchase cannot extend the preceding promotion', () => {
  // Reduced actual subtitle phrases/times from BV1a5N4zxEQe; not a full gold label.
  const subtitles = [
    line(220.1, '叠加新人优惠到手更是低至60出头', 2.82),
    line(231.96, '全场包邮', 0.84),
    line(232.8, '快来点击置顶评论区链接', 1.6),
    line(234.4, '直接领券', 0.78),
    line(244.96, '快来点击置顶评论区链接吧', 1.78),
    line(252.42, '在汉堡包以外'),
    line(256.68, '其实是各式各样的香肠制品'),
    line(293.5, '纽约洋基体育场内有个小贩大声的叫卖吆喝'),
    line(297.18, '鼓动观众趁热购买自家的腊肠犬香肠', 3.14)
  ];
  const result = detect(subtitles);
  assert.equal(result.end, 246.74);
  assert.equal(result.boundaryPaddingSeconds, 0);
});

test('long neutral passages split evidence even when subtitle timing is dense', () => {
  const subtitles = [line(100, '本期视频由某品牌赞助'),
    ...Array.from({ length: 9 }, (_, index) => line(102 + index, '下面讨论历史正文', 1)),
    line(111, '专属优惠券')];
  assert.equal(detect(subtitles), null);
});

test('two local CTA groups remain separate and the stronger group wins', () => {
  const result = detect([
    line(100, '点击下方链接'),
    line(190, '点击评论区领取优惠券'),
    line(202, '立即下单')
  ]);
  assert.deepEqual([result.start, result.end], [190, 204]);
});

test('invalid subtitle times are ignored and input ordering is not mutated', () => {
  const subtitles = [line(120, '现在下单'), null, line(NaN, '点击链接'), line(-1, '点击链接'),
    { from: 10, to: 9, content: '点击链接' }, line(100, '今天聊别的')];
  const copy = [...subtitles];
  const result = detect(subtitles);
  assert.ok(result);
  assert.equal(result.start, 115);
  assert.deepEqual(subtitles, copy);
  assert.equal(detect(null), null);
});

test('explicit danmaku timestamps retain priority over a subtitle CTA', async () => {
  const h = createHarness({ subtitles: [line(100, '点击评论区领取优惠券')],
    danmaku: [{ time: 74, textContent: '跳过广告 2:00' }] });
  const segment = await h.detectAndAttach('auto');
  assert.equal(segment.source, 'danmaku-time');
  assert.equal(segment.requiresConfirmation, false);
  h.tick(segment.start);
  assert.deepEqual(h.video.seeks, [120.05]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

// Commercial passages found in the transcript alone. They are always offered
// for confirmation: wording can show that a passage is an ad, not exactly where
// it starts and ends.
const line = (from, content, length = 2) => ({ from, to: from + length, content });
const plain = value => JSON.parse(JSON.stringify(value));
const detect = async (subtitles, danmaku = [], extra = {}) => plain(await createHarness({ subtitles, danmaku, ...extra }).detectAllAndAttach());
const evidence = text => plain(createHarness().context.BiliAdSignals.commercialEvidence(text));
const pitch = start => [
  line(start, '说到这里就不得不提今天的合作伙伴'),
  line(start + 2, '这款按摩仪我自己用了大半年'),
  line(start + 4, '力度很足而且可以热敷')
];

test('ordinary free/search/purchase/cooperation words do not establish an ad', async () => {
  for (const subtitles of [
    [line(79, '这个工具是免费的'), line(99, '搜索你想了解的内容')],
    [line(141.38, '你拿金币购买的武器'), line(261.789, '一部分可购买资源'), line(263.589, '一部分不可购买资源'), line(367.34, '只能购买六个')],
    [line(835.2, '日本从英国和法国购买的装甲巡洋舰'), line(850, '两国合作建造军舰')],
    [line(100, '欢迎在评论区讨论'), line(108, '点赞关注推荐给大家')],
    [line(100, '点击链接查看免费教程'), line(108, '评论区下载资料')],
    [line(100, '项目链接放在简介了'), line(102, '代码可以免费下载'), line(104, '感兴趣的朋友可以去看看')],
    [line(100, '这款显卡的性价比很高'), line(102, '我强烈推荐'), line(104, '到手之后体验不错')]
  ]) assert.deepEqual(await detect(subtitles, [], { videoInfo: { duration: 900 } }), []);
});

test('commercial phrases do not fire inside look-alike words', () => {
  for (const text of ['那它到底价值多少呢', '确保价格稳定', '物质保障很重要', '证券公司的研报']) {
    assert.deepEqual(evidence(text), { decisive: 0, strong: 0, matched: [] }, text);
  }
  for (const text of ['保价大促送运费险', '到手都是底价', '一年质保', '特别是现在下单还送运费险', '长按识别二维码领取优惠券']) {
    assert.ok(evidence(text).decisive > 0, text);
  }
});

test('routing is decisive only next to something to buy or claim', () => {
  for (const text of ['点击下方链接', '评论区置顶链接', '链接放在简介了', '评论区下载资料', '扫描屏幕下方的二维码']) {
    assert.equal(evidence(text).decisive, 0, text);
  }
  for (const text of ['点击评论区链接领取优惠券', '评论区置顶蓝链下单', '下方链接有专属福利', '领券的链接在评论区', '点击视频下方置顶蓝链直达会场']) {
    assert.ok(evidence(text).decisive > 0, text);
  }
});

test('negated sponsor and purchase instructions are not positive evidence', () => {
  for (const text of ['本期视频不是由任何公司赞助', '本期视频没有赞助', '不要点击评论区链接领取优惠券',
    '千万别点击评论区链接领券', '禁止点击链接购买', '本视频无广告', '这不是推广']) {
    assert.deepEqual(evidence(text), { decisive: 0, strong: 0, matched: [] }, text);
  }
  // "别忘了 / 不要错过" urge the viewer on; they are not denials.
  for (const text of ['不要忘了去评论区领券购买', '千万别错过评论区的优惠券']) assert.ok(evidence(text).decisive > 0, text);
});

test('a negative clause does not erase an independent positive clause', async () => {
  assert.ok(evidence('不要乱买，点击下方蓝链领取优惠券').decisive > 0);
  const [segment] = await detect([...pitch(94), line(100, '不要乱买，点击下方蓝链领取优惠券'), line(102, '现在下单还送运费险')]);
  assert.equal(segment.requiresConfirmation, true);
});

test('a sponsor read with an offer is one manual candidate from its first to its last line', async () => {
  const subtitles = [line(60, '我们继续讲刚才的历史'), ...pitch(100), line(106, '现在评论区领取我的专属优惠券'),
    line(108, '到手只要一百多还送运费险'), line(112, '说回当年的那场战役')];
  const h = createHarness({ subtitles });
  const segments = plain(await h.detectAllAndAttach());
  assert.equal(segments.length, 1);
  assert.equal(segments[0].source, 'subtitles');
  assert.equal(segments[0].reason, 'commercial-subtitle-block');
  assert.ok(segments[0].start >= 100 && segments[0].start <= 102, `start ${segments[0].start}`);
  assert.equal(segments[0].end, 110);
  assert.equal(segments[0].requiresConfirmation, true);
  assert.ok(segments[0].matchedKeywords.some(text => text.includes('优惠券')));
  h.tick(segments[0].start);
  h.advanceTimers(10_000);
  assert.deepEqual(h.video.seeks, [], 'transcript wording alone never seeks');
  const manual = createHarness({ subtitles });
  await manual.detectAllAndAttach();
  manual.tick(104);
  manual.button.click();
  assert.deepEqual(manual.video.seeks, [110.05]);
});

test('one commercial sentence is a credit, not a read', async () => {
  for (const subtitles of [
    [line(95, '我们继续刚才的故事'), line(100, '感谢某品牌对本期视频的赞助'), line(103, '现在回到视频'), line(108, '主角随后来到城市的另一边')],
    [line(323.91, '现在点击下方评论区链接就能直达服饰会场', 3.43)],
    [line(196.6, '一键下单就能通通打包带走', 2.28)],
    [line(100, '本期视频由某品牌赞助'), line(150, '注册免费体验课程')],
    [line(100, '这里讨论商业赞助'), line(140, '新用户有优惠券')]
  ]) assert.deepEqual(await detect(subtitles), []);
});

test('a short recap is kept when it is dense with commercial phrases or closes the video', async () => {
  const recap = [line(100, '另外想要视频同款耳机的小伙伴'), line(102, '不要忘了去评论区领券购买'), line(104, '才能享受到我的专属福利哦')];
  const [dense] = await detect(recap);
  assert.deepEqual([dense.start, dense.end], [100, 106]);
  // One decisive sentence with a little lead-in (reduced from BV19osheaEZu):
  // kept only in the sign-off before the video ends.
  const signOff = at => [line(at - 3, '允许你奔向广阔的世界成为你自己'), line(at, '另外大家记得淘宝搜索活动口令', 2.8),
    line(at + 2.8, '可以去淘宝活动会场逛逛淘宝', 2.5), line(at + 5.3, '我是小椰子感谢大家的三连')];
  const [closing] = await detect(signOff(570));
  assert.deepEqual([closing.start, closing.end], [570, 575.3]);
  assert.equal((await detect(signOff(300))).length, 0);
});

test('a CTA split across adjacent subtitle rows is recognized; distant rows are not combined', async () => {
  const context = createHarness().context;
  const score = rows => plain(context.BiliAdSignals.scoreLines(rows, 600, null));
  const wrapped = score([line(100, '点击评论区置顶链接'), line(102, '领取专属的见面礼')]);
  assert.ok(wrapped[0].decisive > 0, 'route + something to claim, read together');
  const distant = score([line(100, '点击评论区置顶链接'), line(130, '领取专属的见面礼')]);
  assert.equal(distant[0].decisive, 0);
});

test('English sponsorship survives whitespace normalization', async () => {
  assert.ok(evidence('This video is sponsored by Example').decisive > 0);
  assert.ok(evidence('Use my promo code for a discount').strong > 0);
  assert.deepEqual(evidence('This shader is not sponsored'), { decisive: 0, strong: 1, matched: ['sponsor'] });
});

test('real sausage-history purchase cannot extend the preceding promotion', async () => {
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
  const segments = await detect(subtitles);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].end, 246.74);
});

test('long neutral passages keep commercial phrases in separate passages', async () => {
  const story = (start, count) => Array.from({ length: count }, (_, index) => line(start + index * 4, '主角随后来到城市的另一边继续调查', 4));
  const segments = await detect([...pitch(100), line(106, '点击评论区链接领取优惠券'), line(108, '到手只要九十九'),
    ...story(110, 20), ...pitch(190), line(196, '评论区置顶蓝链下单'), line(198, '还有七天无理由和运费险'), ...story(200, 10)]);
  assert.equal(segments.length, 2);
  assert.ok(segments[0].end <= 112 && segments[1].start >= 186, JSON.stringify(segments.map(s => [s.start, s.end])));
});

test('invalid subtitle times are ignored and input ordering is not mutated', async () => {
  const subtitles = [line(106, '现在评论区领取我的专属优惠券'), null, line(NaN, '点击评论区链接领券'), line(-1, '点击评论区链接领券'),
    { from: 10, to: 9, content: '点击评论区链接领券' }, ...pitch(100), line(108, '到手只要一百多还送运费险'), { from: 700, to: 705, content: '点击评论区链接领券' }];
  const copy = [...subtitles];
  const h = createHarness({ subtitles });
  const segments = plain(await h.detectAllAndAttach());
  assert.equal(segments.length, 1);
  assert.ok(segments[0].start >= 100 && segments[0].end === 110);
  assert.deepEqual(subtitles, copy);
  assert.deepEqual(plain(h.context.BiliAdSignals.detect({ duration: 600, subtitles: null, danmaku: null })), []);
  assert.deepEqual(plain(h.context.BiliAdSignals.detect({ duration: NaN, subtitles, danmaku: [] })), []);
});

test('the viewers\' destination ends a transcript passage; their thanks on arrival do too', async () => {
  const subtitles = [...pitch(100), line(106, '现在评论区领取我的专属优惠券'), line(108, '到手只要一百多还送运费险'),
    line(110, '两年内质量问题免费换新'), line(112, '给家里人也安排上'), line(114, '说回当年的那场战役')];
  // Destination comment: the jump owns both ends and, corroborated by the transcript, is automatic.
  const h = createHarness({ subtitles, danmaku: [{ time: 101, textContent: '空降1:54' }] });
  const [jump] = plain(await h.detectAllAndAttach());
  assert.deepEqual([jump.source, jump.start, jump.end, jump.requiresConfirmation], ['danmaku-time', 100, 114, false]);
  h.tick(101);
  assert.deepEqual(h.video.seeks, [114.05]);
  // No destination, but two viewers thank the guide as the video resumes.
  const [block] = await detect(subtitles, [{ time: 114.4, textContent: '感谢指路的课代表' }, { time: 115, textContent: '欢迎回来' }]);
  assert.deepEqual([block.source, block.end, block.boundaryEvidence.end.kind], ['subtitles', 114, 'danmaku-arrival']);
});

test('without the pitch table a passage still spans its commercial phrases', () => {
  const context = createHarness().context;
  const subtitles = [...pitch(100), line(106, '现在评论区领取我的专属优惠券'), line(108, '到手只要一百多还送运费险'), line(112, '说回当年的那场战役')];
  const [block] = plain(context.BiliAdSignals.detect({ duration: 600, subtitles, danmaku: [] }, { model: null }));
  assert.deepEqual([block.start, block.end], [106, 110]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { detectSegments } = require('../scr/segment-detector.js');
const { createHarness } = require('./harness.cjs');
const helpers = createHarness().context;
const line = (from, to, content) => ({ from, to, content });
const input = subtitles => ({ duration: 500, title: '星空为什么发光', subtitles, danmaku: [], chapters: [] });
function ad(start = 40) {
  return [line(start, start + 3, '本视频由测试赞助商赞助播出'),
    line(start + 3, start + 8, '这款产品采用一种不同的设计'),
    line(start + 8, start + 23, '下面解释内部工作原理和各个部件的连接方式'),
    line(start + 23, start + 28, '整个过程包括三个步骤'),
    line(start + 28, start + 33, '现在可以免费试用全部功能'),
    line(start + 33, start + 38, '点击评论区链接领取优惠券'),
    line(start + 40, start + 44, '现在回到视频')];
}

test('a sponsor break retains neutral explanation and ends before the return sentence', () => {
  const [segment] = detectSegments(input(ad()), helpers);
  assert.deepEqual([segment.start, segment.end], [40, 78]);
  assert.equal(segment.autoEligible, true); assert.equal(segment.requiresConfirmation, false);
  assert.equal(segment.skipDecision, 'skip'); assert.equal(segment.boundaryEvidence.end.kind, 'explicit-return');
  assert.ok(segment.observedLineCount >= 6);
});

test('neutral product explanation may exceed twenty seconds without fragmenting a known sponsor break', () => {
  const rows = [line(50, 53, '这个视频由某服务赞助'), line(53, 80, '接下来解释学习时知识怎样被组织起来'),
    line(80, 112, '你可以按顺序练习并观察每一步的反馈'), line(112, 118, '可免费体验全部功能'),
    line(118, 126, '使用下方链接获取专属优惠'), line(128, 132, '现在回到视频')];
  const [segment] = detectSegments(input(rows));
  assert.deepEqual([segment.start, segment.end], [50, 126]); assert.equal(segment.autoEligible, true);
});

test('independent commercial chapter recovers setup before sponsorship without relying on its title', () => {
  const record = input([line(100, 120, '为什么会产生这个问题呢'), ...ad(150)]);
  record.chapters = [{ from: 0, to: 100, content: '星空' }, { from: 100, to: 190, content: '🙂' }, { from: 190, to: 500, content: '正文' }];
  const [segment] = detectSegments(record, helpers);
  assert.equal(segment.start, 100); assert.equal(segment.end, 190); assert.equal(segment.autoEligible, true);
  assert.equal(segment.boundaryEvidence.start.kind, 'chapter-start');
});

test('a chapter with a commercial chain and no sponsor remains a full manual proposal', () => {
  const record = input([line(100, 120, '先介绍一个问题'), line(160, 165, '这款产品享有专属优惠'),
    line(178, 184, '点击评论区链接领取优惠券')]);
  record.chapters = [{ from: 0, to: 100 }, { from: 100, to: 190, content: '🙂' }, { from: 190, to: 500 }];
  const [segment] = detectSegments(record, helpers);
  assert.deepEqual([segment.start, segment.end], [100, 190]); assert.equal(segment.requiresConfirmation, true);
  assert.equal(segment.autoEligible, false);
});

test('an explicit local time destination supports a sponsor ending without a CTA-sized start', () => {
  const record = input(ad().slice(0, -1)); record.danmaku = [{ time: 42, textContent: '120工程' }];
  const [segment] = detectSegments(record, helpers);
  assert.deepEqual([segment.start, segment.end], [40, 80]); assert.equal(segment.autoEligible, true);
  assert.equal(segment.boundaryEvidence.end.kind, 'explicit-danmaku-end');
});

test('conflicting timestamp destinations are exposed and cannot authorize automatic fusion', () => {
  const record = input(ad().slice(0, -1)); record.danmaku = [
    { time: 42, textContent: '120工程' }, { time: 44, textContent: '200工程' }];
  const [segment] = detectSegments(record, helpers);
  assert.equal(segment.requiresConfirmation, true); assert.ok(segment.reviewReasons.includes('conflicting-time-destinations'));
  assert.deepEqual(segment.boundaryEvidence.alternativeEnds.map(value => value.end), [120]);
});

test('decorated isolated instructions are supported without stripping narrative or negation', () => {
  for (const textContent of ['░░120工程░░', '120工程']) {
    const record = input(ad().slice(0, -1)); record.danmaku = [{ time: 42, textContent }];
    assert.equal(detectSegments(record, helpers)[0].autoEligible, true);
  }
  for (const textContent of ['░120工程是辆好车░', '不要空降1:20', '他说1:20是开始', '1:20']) {
    const record = input(ad().slice(0, -1)); record.danmaku = [{ time: 42, textContent }];
    assert.equal(detectSegments(record, helpers)[0].autoEligible, false, textContent);
  }
});

test('two sponsor breaks separated by normal content remain separate and never consume the middle', () => {
  const segments = detectSegments(input([...ad(40), line(88, 120, '普通的天文知识解释'), ...ad(150)]));
  assert.deepEqual(segments.map(segment => [segment.start, segment.end]), [[40, 78], [150, 188]]);
  assert.ok(segments.every(segment => segment.autoEligible));
});

test('a single opening sponsorship statement is kept and cannot connect to a later advertisement', () => {
  const segments = detectSegments(input([line(0.08, 2.4, '本视频由测试品牌赞助'),
    line(3, 18, '下面介绍链表的数据结构'), line(18, 35, '我们首先讨论内存的组织方式'), ...ad(150)]));
  assert.deepEqual(segments.map(segment => [segment.start, segment.end, segment.skipDecision]), [[0.08, 2.4, 'keep'], [150, 188, 'skip']]);
  assert.equal(segments[0].autoEligible, false); assert.equal(segments[1].autoEligible, true);
});

test('product-themed commercial content and course introductions do not become automatic ads', () => {
  const themed = { ...input(ad().slice(0, -1)), title: '新产品开箱试吃' };
  assert.equal(detectSegments(themed)[0].skipDecision, 'keep');
  const course = input([line(0, 4, '本课程的第一课将介绍教学目标'), ...ad(40)]); course.title = '编程课程入门';
  assert.equal(detectSegments(course)[0].autoEligible, true, 'a separate explicitly bounded sponsor break can occur inside a tutorial');
  assert.deepEqual(detectSegments({ ...course, subtitles: [line(0, 5, '本课程介绍学习方法'), line(5, 15, '免费搜索教程和购买教材')] }), []);
});

test('ordinary purchase, free search, a lone teaching link and advertising discussion invent no break', () => {
  for (const content of ['免费搜索教程，推荐给大家', '点击链接查看免费教程', '他购买香肠之后回到家里',
    '他说本视频由某商家赞助', '“本视频由某商家赞助”是常见的广告词', '本视频没有商家赞助']) {
    assert.deepEqual(detectSegments(input([line(40, 45, content), line(45, 50, '今天价格只要100元'), line(50, 55, '现在回到视频')])), [], content);
  }
});

test('gratitude without explicit sponsor identity is manual even when its commercial continuation is clear', () => {
  const rows = ad(); rows[0].content = '感谢一下某商家的催更';
  const [segment] = detectSegments(input(rows));
  assert.equal(segment.requiresConfirmation, true); assert.ok(segment.reviewReasons.includes('weak-sponsor-identity'));
});

test('subtitle wrapping repairs sponsor wording without absorbing an unrelated previous sentence', () => {
  const rows = ad(); rows.splice(0, 1, line(37, 40, '刚才讲的是星球'), line(40, 41, '本视频由某商家'), line(41, 43, '赞助播出'));
  assert.equal(detectSegments(input(rows))[0].start, 40);
  const negative = input([line(39, 40, '没有'), line(40, 43, '本视频由商家赞助'), ...ad().slice(1)]);
  assert.deepEqual(detectSegments(negative), []);
});

test('post-offer weak transitions close a full manual range rather than inheriting the following tutorial', () => {
  const rows = ad(); rows.at(-1).content = '让我们从夏季常遇到的问题开始';
  const [segment] = detectSegments(input(rows));
  assert.deepEqual([segment.start, segment.end], [40, 78]); assert.equal(segment.autoEligible, false);
  assert.equal(segment.boundaryEvidence.end.kind, 'post-offer-transition');
});

test('search duration is a confidence bound, not an automatic crop boundary', () => {
  const rows = [line(40, 43, '本视频由商家赞助'), line(60, 100, '这款产品工作原理'),
    line(150, 180, '可免费试用'), line(320, 330, '点击评论区领优惠券'), line(400, 410, '现在回到视频')];
  assert.ok(detectSegments(input(rows)).every(segment => !segment.autoEligible));
});

test('every explicit ad chapter is returned even with no subtitle track', () => {
  const record = { ...input([]), chapters: [{ from: 0, to: 50, content: '开场' },
    { from: 50, to: 80, content: '广告' }, { from: 80, to: 180, content: '正文' },
    { from: 180, to: 220, content: '赞助环节' }, { from: 220, to: 500, content: '正文' }] };
  assert.deepEqual(detectSegments(record, helpers).map(segment => [segment.start, segment.end, segment.autoEligible]), [[50, 80, true], [180, 220, true]]);
});

test('invalid input, overlapping chapter envelopes and duplicate rows do not produce invalid ranges', () => {
  assert.deepEqual(detectSegments(null), []); assert.deepEqual(detectSegments({ duration: NaN }), []);
  const record = input([...ad(), ...ad(), line(NaN, 80, '本视频由商家赞助')]);
  const before = JSON.stringify(record); const result = detectSegments(record);
  assert.equal(result.length, 1); assert.equal(result[0].observedLineCount, 6); assert.equal(JSON.stringify(record), before);
  const overlapping = input([line(130, 134, '点击评论区领优惠券'), line(140, 145, '专属优惠')]);
  overlapping.chapters = [{ from: 0, to: 120 }, { from: 100, to: 150 }, { from: 150, to: 500 }];
  assert.deepEqual(detectSegments(overlapping), []);
});

test('browser script exposes the same synchronous dependency-free API', () => {
  const browser = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scr/segment-detector.js'), 'utf8'), browser);
  const result = browser.BiliSegmentDetector.detectSegments(input(ad()));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), detectSegments(input(ad())));
});

test('a single complete offer CTA can support a whole manual chapter but never automatic skipping', () => {
  const record = input([line(100, 120, '先铺垫一个问题'), line(178, 184, '点击评论区领优惠券')]);
  record.chapters = [{ from: 0, to: 100 }, { from: 100, to: 190 }, { from: 190, to: 500 }];
  const [segment] = detectSegments(record);
  assert.deepEqual([segment.start, segment.end], [100, 190]); assert.equal(segment.autoEligible, false);
});

test('commercial gratitude requires multiple transaction sentences and a separate explicit timestamp for auto', () => {
  const rows = ad().slice(0, -1); rows[0].content = '感谢某商家的催更'; rows[1].content = '这个产品到手价只要100元';
  const record = input(rows); record.danmaku = [{ time: 42, textContent: '120工程' }];
  assert.equal(detectSegments(record)[0].autoEligible, true);
  rows[0].content = '感谢观众的催更';
  assert.deepEqual(detectSegments(record), [], 'ordinary viewer gratitude is not sponsor identity');
});

test('an instruction ending during an observed later offer cannot shorten it or become automatic', () => {
  const rows = ad().slice(0, -1); rows[1].content = '这个产品到手价只要100元';
  rows[2].content = '平台提供专属优惠';
  const record = input(rows); record.danmaku = [{ time: 42, textContent: '110工程' }];
  const [segment] = detectSegments(record);
  assert.equal(segment.end, 78); assert.equal(segment.autoEligible, false);
  assert.ok(segment.reviewReasons.includes('commercial-content-after-time-destination'));
});

test('a timestamp near a closing subtitle boundary does not consume the next ordinary sentence', () => {
  const rows = ad().slice(0, -1); rows.push(line(78, 79, '好就是这样'), line(79, 84, '接着讲星球的组成'));
  const record = input(rows); record.danmaku = [{ time: 42, textContent: '120工程' }];
  const [segment] = detectSegments(record);
  assert.equal(segment.end, 79); assert.equal(segment.boundaryEvidence.timeReferences[0].end, 80);
  assert.equal(segment.autoEligible, true);
});

test('a middle chapter needs a personal commercial relationship, a complete CTA and distinct affirmative reactions for auto', () => {
  const record = input([line(100, 120, '先铺垫这个问题'), line(145, 150, '我们合作4年了'),
    line(160, 166, '这款产品有很多功能'), line(178, 184, '点击评论区领优惠券')]);
  record.chapters = [{ from: 0, to: 100 }, { from: 100, to: 190 }, { from: 190, to: 500 }];
  record.danmaku = [{ time: 140, textContent: '感谢甲方爸爸' }, { time: 142, textContent: '甲方这文案真有意思' }];
  assert.equal(detectSegments(record)[0].autoEligible, true);
  record.danmaku[1].textContent = '感谢甲方爸爸';
  assert.equal(detectSegments(record)[0].autoEligible, false, 'duplicate wording is not independent corroboration');
  record.danmaku[1].textContent = '不是甲方这文案';
  assert.equal(detectSegments(record)[0].autoEligible, false);
  record.danmaku[1].textContent = '甲方这文案真有意思'; record.title = '新产品开箱评测';
  assert.equal(detectSegments(record)[0].autoEligible, false, 'a main product-review chapter needs further evidence of an insertion');
});

test('a later sponsor and its return cannot authorize an unresolved earlier sponsor across ordinary body', () => {
  const record = input([line(100, 103, '本视频由某商家赞助'), line(103, 110, '这款产品可免费试用'),
    line(110, 118, '点击评论区领取优惠券'), line(118, 180, '这里已经回到普通天文学原理的连续解释'), ...ad(200)]);
  const segments = detectSegments(record);
  assert.deepEqual(segments.map(segment => [segment.start, segment.end, segment.autoEligible]), [[100, 118, false], [200, 238, true]]);
  assert.equal(segments[0].boundaryEvidence.end.kind, 'unresolved-before-next-sponsor');
  record.danmaku = [{ time: 102, textContent: '400工程' }];
  assert.equal(detectSegments(record)[0].autoEligible, false, 'a timestamp cannot bridge another sponsor start either');
});

test('an opening credit followed by ordinary material price cannot inherit a later ad commercial chain', () => {
  const record = input([line(0.08, 2.4, '本视频由某品牌赞助'), line(3, 18, '最初实验的材料价格是100元'),
    line(18, 60, '我们首先讨论实验的科学原理'), line(60, 140, '接下来分析实验数据并重建整个过程'), ...ad(150)]);
  const segments = detectSegments(record);
  assert.deepEqual(segments.map(segment => [segment.start, segment.end, segment.skipDecision]), [[0.08, 2.4, 'keep'], [150, 188, 'skip']]);
  assert.ok(segments.filter(segment => segment.autoEligible).every(segment => segment.start >= 150));
});

test('an earlier weak return ends its own manual break even when a later ad has a stronger return', () => {
  const record = input([line(40, 43, '本视频由某品牌赞助'), line(43, 50, '可免费试用全部功能'),
    line(50, 58, '点击评论区链接领取优惠券'), line(58, 64, '让我们从夏季常遇到的问题开始'),
    line(64, 140, '普通电动气泵拆机'), ...ad(150)]);
  const segments = detectSegments(record);
  assert.deepEqual(segments.map(segment => [segment.start, segment.end, segment.autoEligible]), [[40, 58, false], [150, 188, true]]);
});

test('a legitimate early sponsor break can retain neutral product explanation before a later offer', () => {
  const record = input([line(0.08, 2.4, '本视频由某品牌赞助'), line(3, 20, '这款产品的内部设计包括三个部分'),
    line(20, 50, '各个部件通过反馈调节整个过程'), line(50, 56, '可免费试用全部功能'),
    line(56, 63, '点击评论区领优惠券'), line(64, 68, '现在回到视频')]);
  const [segment] = detectSegments(record);
  assert.deepEqual([segment.start, segment.end, segment.autoEligible], [0.08, 63, true]);
});

test('an advertising example introduced in a preceding subtitle is not a real sponsorship', () => {
  const record = input([line(35, 40, '下面是广告词的一种示例：'), ...ad(40)]);
  assert.deepEqual(detectSegments(record), []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The evidence module is plain JavaScript without browser dependencies, so its
// parsing and clustering rules are exercised directly. End-to-end behaviour
// (buttons, seeks, confidence) is covered through the harness in the other files.
const signals = require(path.join(require('./source-directory.cjs'), 'ad-signals.js'));
const read = (textContent, time = 74) => signals.readComment({ time, textContent });
const comment = (textContent, time = 74) => ({ time, textContent });
const detect = (danmaku, extra = {}) => signals.detect({ duration: 600, danmaku, subtitles: [], ...extra });

test('playback destinations are read from the formats viewers actually type', () => {
  for (const [text, seconds, kind] of [
    ['5:30', 330, 'clock'], ['空降 05：30', 330, 'clock'], ['跳伞5;30', 330, 'clock'], ['4∶26', 266, 'clock'],
    ['五分三十秒', 330, 'clock'], ['5分30', 330, 'clock'], ['七分09 求点赞', 429, 'clock'], ['折跃目标：6分13秒', 373, 'clock'],
    ['我是三分零五郎', 185, 'clock'], ['两分十秒', 130, 'clock'], ['十分二十秒', 620, 'clock'],
    ['705工程', 425, 'code'], ['0705工程', 425, 'code'], ['7.05工程真不错', 425, 'code'], ['310认证成功', 190, 'code'],
    ['░░░░░░░░░░136工程░░░', 96, 'code'], ['128工程即将启动', 88, 'code'], ['跳伞248', 168, 'code'], ['空降0326', 206, 'code'],
    ['空降到248', 168, 'code'], ['空降：05:32', 332, 'clock'], ['跳伞:04:18', 258, 'clock'], ['跳过广告：05:44', 344, 'clock'],
    ['跳伞00:05:32', 332, 'clock'], ['十分二十秒', 620, 'clock'],
    ['1.46', 106, 'decimal'], ['2,40', 160, 'decimal'], ['空降7.10', 430, 'decimal'],
    ['1:02:03', 3723, 'clock']
  ]) {
    const result = read(text, 20);
    assert.equal(result.pointer?.destination, seconds, text);
    assert.equal(result.pointer.kind, kind, text);
  }
});

test('arrow-key counts point five seconds ahead per press, relative to the comment', () => {
  for (const [text, time, destination] of [['向右13下', 158.9, 223.9], ['电脑端向右24下', 79.8, 199.8], ['→23下', 113.2, 228.2],
    ['右按11下等10秒左右', 476.3, 541.3], ['右键7次', 100, 135]]) {
    const { pointer } = read(text, time);
    assert.ok(Math.abs(pointer.destination - destination) < 1e-6, text);
    assert.equal(pointer.kind, 'presses');
    assert.ok(pointer.cue);
  }
  assert.equal(read('感谢向右19下', 313.6).pointer, undefined, 'thanks for a key count is an arrival');
  assert.ok(read('感谢向右19下', 313.6).arrival);
});

test('dates, prices, scores, model numbers and long remarks are not destinations', () => {
  for (const text of ['2026年10:31的2月2日12人出来', '晚上8点20:00开播', '1.46算便宜的。坐标北京，经常1.7元', '这才3.50元一斤', '5090，8888',
    '666', '1999', '在的扣1', '2:99', '11105工程', '比分2:10', '感谢9.10', '3块钱 2.50', '啥？3.36亿', '-7.34%', '十分一般', '十分十二寸',
    '空降成功2333', '左右各10次', '左右各10下', '方向键左5下', '按方向键左键5次',
    '这段从头到尾讲得非常详细我个人觉得5:30之后的部分才是整期视频里最值得反复看的内容']) {
    assert.equal(read(text, 20)?.pointer, undefined, text);
  }
  assert.equal(signals.readComment({ time: NaN, textContent: '空降5:30' }), null);
  assert.equal(signals.readComment({ time: -1, textContent: '空降5:30' }), null);
  assert.equal(signals.readComment(null), null);
});

test('an instruction is explicit only when it tells viewers to go; a denial is no witness at all', () => {
  for (const text of ['空降5:30', '跳伞 5:30', '跳过广告5:30', '指路5:30', '传送5:30', '我是5分30君，你猜我为啥在这', '5分30不用谢',
    '陛下请移驾5分30秒 空降', '5:30广告结束', '非常感谢，空降5:30']) {
    assert.ok(read(text, 20).pointer?.cue, text);
  }
  for (const text of ['5:30', '看看5:30的细节', '七分09 求点赞']) {
    assert.equal(read(text, 20).pointer.cue, null, text);
  }
  for (const text of ['不要跳过 5:30', '别跳5:30', '不要直接空降5:30', '5:30不是广告结束', '没必要跳到5:30', '5:30 高能 不许跳过']) {
    assert.equal(read(text, 20).pointer, undefined, text);
  }
  // A courtesy is not a prohibition, and 别 inside 特别 is not "don't".
  for (const text of ['不用谢，空降5:30', '别谢我 空降 5:30', '特别好用 530工程', '5.30工程真不错']) {
    assert.ok(read(text, 20).pointer?.cue, text);
  }
});

test('thanks and returns are arrivals: they confirm a destination without pointing to one', () => {
  for (const [text, destination] of [['感谢3分10秒侠', 190], ['谢谢 3分09 郎', 189], ['感谢310工程', 190], ['谢谢4.10大哥', 250]]) {
    const result = read(text, destination + 2);
    assert.equal(result.pointer, undefined, text);
    assert.equal(result.arrival.destination, destination, text);
  }
  for (const text of ['感谢指路的课代表', '谢谢空降兵', '欢迎回来', '空降成功', '广告结束了']) assert.ok(read(text).arrival, text);
  // Ordinary speech: "回来了" is usually narrative ("耳机已经买回来了"), and thanks in general are not thanks to a guide.
  for (const text of ['感谢大家的三连', '结束了', '他终于落地了', '他终于回来了', '耳机已经买回来了', '谢谢喵', '感谢大佬']) {
    assert.equal(read(text).arrival, undefined, text);
  }
});

test('ad reactions exclude denials, questions and remarks about an ad', () => {
  for (const text of ['恭喜接广', '感谢金主催更', '甲方登场', '这广告一打，前面一大段都变私货了', '恰饭时间', '广子来了', '恭喜接推广', '推广位来了']) {
    assert.equal(read(text).adReaction, true, text);
  }
  for (const text of ['居然没广告', '这不是广告', '这是不是广告', '以为要接广告了', '广告里讲的游戏', '非恰饭', '无广', '丝滑', '来了来了',
    '建议全国推广', '这个方法值得推广']) {
    assert.equal(read(text).adReaction, false, text);
  }
});

test('comments naming nearby seconds form one cluster; the majority second is its end', () => {
  const clusters = signals.pointerClusters(signals.collectSignals([
    comment('空降7:04', 318), comment('7:04', 317.8), comment('空降07:05', 324), comment('跳伞7:04', 334), comment('7:06', 320),
    comment('感谢7分04秒侠', 425), comment('感谢指路', 426), comment('空降9:30', 400)
  ]), 900);
  assert.equal(clusters.length, 2);
  const [ad] = clusters;
  assert.equal(ad.end, 424);
  assert.equal(ad.count, 5);
  assert.equal(ad.cueCount, 3);
  assert.equal(ad.arrivals, 2);
});

test('approximate formats locate a destination only when nobody named the exact second', () => {
  const end = danmaku => signals.pointerClusters(signals.collectSignals(danmaku), 900)[0].end;
  assert.equal(end([comment('向右20下', 100), comment('右20下', 100.5), comment('3:22', 101)]), 202);
  assert.equal(end([comment('向右20下', 100)]), 200);
});

test('a key-press count is a witness for the nearby named second, not a rival destination', () => {
  // Reduced from BV1dw4m1i7kD: the reviewed ad ends at 5:48.2. Twenty-four presses
  // from 4:06.8 would land at 6:06.8, eighteen seconds into the next topic.
  const danmaku = [comment('前方注意向右24下', 246.8), comment('5.50', 249.7), comment('五分四十九秒', 250.8), comment('感谢指路', 348.7)];
  const clusters = signals.pointerClusters(signals.collectSignals(danmaku), 900);
  assert.equal(clusters.length, 1);
  assert.deepEqual([clusters[0].end, clusters[0].count, clusters[0].cueCount], [349, 3, 1]);
  const [segment] = detect(danmaku, { duration: 900 });
  assert.deepEqual([segment.end, segment.requiresConfirmation], [349, false]);
  // Too far from any named second, or from a different part of the video: its own destination.
  assert.equal(signals.pointerClusters(signals.collectSignals([comment('向右24下', 246.8), comment('5:10', 250)]), 900).length, 2);
  assert.equal(signals.pointerClusters(signals.collectSignals([comment('向右6下', 320), comment('5:49', 100)]), 900).length, 2);
});

test('the start follows the densest burst of comments, not the earliest one', () => {
  const start = times => signals.pointerClusters(signals.collectSignals(times.map(time => comment('空降7:04', time))), 900)[0].start;
  // Real shape (BV1zdE76YEW3): a few viewers post ahead, most as the ad begins.
  assert.equal(start([354.3, 356.7, 359.9, 360.2, 360.2, 361.7, 361.7, 362.4, 363, 363.6, 363.7, 365.4]), 359.9);
  assert.equal(start([330, 360, 361, 362]), 360);
  assert.equal(start([360]), 360);
  // Two lone comments: together they agree on the first; far apart, only the later is safe.
  assert.equal(start([356, 360]), 356);
  assert.equal(start([340, 360]), 360);
});

test('when nobody posts together an explicit instruction, not a passing mention, sets the start', () => {
  const [cluster] = signals.pointerClusters(signals.collectSignals([
    comment('看看7:04的画面', 300), comment('空降7:04', 320), comment('跳伞7:04', 345), comment('7:04', 380)
  ]), 900);
  assert.equal(cluster.start, 320);
});

test('one comment needs corroboration to be taken unprompted; several kinds count', () => {
  const state = danmaku => { const [segment] = detect(danmaku); return segment ? (segment.requiresConfirmation ? 'manual' : 'auto') : null; };
  assert.equal(state([comment('空降3:10')]), 'manual');
  assert.equal(state([comment('3:10')]), null);
  assert.equal(state([comment('3:10'), comment('3:10', 75)]), null, 'a repeated bare time is not several witnesses');
  assert.equal(state(Array.from({ length: 4 }, (_, index) => comment('3:10', 74 + index))), 'manual');
  assert.equal(state([comment('空降3:10'), comment('3:11', 76)]), 'auto');
  assert.equal(state([comment('空降3:10'), comment('感谢3分10侠', 191)]), 'auto');
  assert.equal(state([comment('空降3:10'), comment('恭喜接广', 78)]), 'auto');
  assert.equal(state([comment('空降3:10'), comment('恭喜接广', 180)]), 'manual', 'a reaction two minutes later is not about this jump');
  assert.equal(state([comment('跳过广告3:10')]), 'auto', 'the instruction itself names the ad');
});

test('a list of jump targets is a table of contents: single comments are left to the viewer', () => {
  const targets = [[60, '1:20'], [130, '2:40'], [200, '3:50'], [270, '5:00'], [340, '6:10']];
  const toc = detect(targets.flatMap(([time, target]) => [comment(`空降${target}`, time), comment('广告X2', time + 3)]));
  assert.equal(toc.length, 5);
  assert.ok(toc.every(segment => segment.requiresConfirmation));
  const three = detect(targets.slice(0, 3).flatMap(([time, target]) => [comment(`空降${target}`, time), comment('恭喜接广', time + 3)]));
  assert.ok(three.every(segment => !segment.requiresConfirmation));
});

test('overlapping destinations: the better-supported one is kept, the other dropped', () => {
  const segments = detect([comment('空降3:10', 74), comment('跳伞3:10', 75), comment('3:10', 76), comment('感谢3分10秒', 191),
    comment('空降2:55', 80), comment('空降8:00', 400)]);
  assert.deepEqual(segments.map(segment => [segment.start, segment.end]), [[74, 190], [400, 480]]);
});

test('line features are character pairs and Latin words; digits never leak in', () => {
  assert.deepEqual([...signals.lineFeatures('现在只要199元，Link在评论区!')].sort(),
    ['现在', '在只', '只要', 'link', '在评', '评论', '论区'].sort());
  assert.deepEqual([...signals.lineFeatures('')], []);
  assert.deepEqual([...signals.lineFeatures(null)], []);
});

test('the pitch table only shapes extent: scores add its weights, clipped, plus phrase bonuses', () => {
  const model = { bias: -1, unit: 0.1, pairs: { 20: '按摩热敷', '-30': '战役' }, words: { sponsor: 15 } };
  const [pitch, story, cta, loud] = signals.scoreLines([
    { from: 0, to: 2, content: '这款按摩仪可以热敷' }, { from: 2, to: 4, content: '说回那场战役' },
    { from: 4, to: 6, content: '评论区领取优惠券' }, { from: 6, to: 8, content: '按摩 按摩 热敷 sponsor sponsor' }
  ], 600, model);
  assert.ok(Math.abs(pitch.score - (-1 + 2 + 2 + 0.3)) < 1e-9);
  assert.ok(Math.abs(story.score - (-1 - 3 + 0.3)) < 1e-9);
  assert.ok(cta.decisive > 0 && Math.abs(cta.score - (-1 + 0.3 + 3)) < 1e-9);
  assert.ok(Math.abs(loud.score - (4 + 0.3 + 1.5)) < 1e-9, 'each feature counts once and the table part is clipped at 4');
  // No table: nothing but commercial phrases can be positive.
  assert.ok(signals.scoreLines([{ from: 0, to: 2, content: '这款按摩仪可以热敷' }], 600, null)[0].score < 0);
});

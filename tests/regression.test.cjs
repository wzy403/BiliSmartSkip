const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');
const { transcript, weakSubtitles, strongSubtitles, timestamp } = require('./fixtures.cjs');

function diagnostic(harness, message) {
  return harness.logs.find(log => log.level === 'log' &&
    log.args[0] === '[BiliSmartSkip]' && log.args[1] === message)?.args[2];
}

test('真实字幕回归：历史叙事中的购买不能把广告自动延长到 300 秒', async () => {
  // BV1a5N4zxEQe, logged-in AI subtitles collected 2026-09-30.
  // Reduced to actual commercial evidence/times, not a copy of the full transcript:
  // 297.18–300.32 describes buying sausages in a 1901 historical anecdote.
  // The promotion has already ended; the topic resumes at 252.42 seconds.
  const subtitles = [
    { from: 197.96, to: 200.58, content: '加上现在得物准备的超高新客福利' },
    { from: 200.58, to: 203.62, content: '注册就能领最高520元无门槛优惠券' },
    { from: 231.96, to: 232.8, content: '全场包邮' },
    { from: 232.8, to: 234.4, content: '快来点击置顶评论区链接' },
    { from: 234.4, to: 235.18, content: '直接领券' },
    { from: 244.96, to: 246.74, content: '快来点击置顶评论区链接吧' },
    { from: 297.18, to: 300.32, content: '鼓动观众趁热购买自家的腊肠犬香肠' }
  ];
  const subtitleOnly = createHarness({ subtitles });
  const candidate = await subtitleOnly.detectAndAttach();
  assert.ok(candidate);
  assert.ok(candidate.end < 252.42, 'candidate must end before the historical narrative resumes');
  assert.equal(candidate.requiresConfirmation, true);
  subtitleOnly.tick(candidate.start);
  assert.deepEqual(subtitleOnly.video.seeks, []);

  // Actual public XML: explicit destination preserves the user-provided end.
  const crossChecked = createHarness({ subtitles, danmaku: [timestamp('空降 4:12', 183.811)] });
  const segment = await crossChecked.detectAndAttach();
  assert.equal(segment.source, 'danmaku-time');
  assert.equal(segment.end, 252);
  crossChecked.tick(segment.start);
  assert.deepEqual(crossChecked.video.seeks, [252.05]);
});

test('真实弹幕回归：短广告的明确跳伞指令不被 30 秒前置门槛丢弃', async () => {
  // Public XML captured 2026-09-30. Community reference ends: 156.201 / 147.965.
  for (const [bvid, time, text, end] of [
    ['BV1yMQrBSE5H', 137.001, '跳伞02：36', 156],
    ['BV1H8iCBEEGG', 128.111, '跳伞2:28', 148]
  ]) {
    // One comment with nothing to back it up is offered, never taken unprompted:
    // on the 438 reviewed videos such lone instructions were ads about 58% of the time.
    const alone = createHarness({ danmaku: [timestamp(text, time)] });
    const candidate = await alone.detectAndAttach();
    assert.ok(candidate, bvid);
    assert.equal(candidate.start, time, bvid);
    assert.equal(candidate.end, end, bvid);
    assert.equal(candidate.requiresConfirmation, true, bvid);
    alone.tick(time);
    assert.deepEqual(alone.video.seeks, [], bvid);
    alone.button.click();
    assert.deepEqual(alone.video.seeks, [end + 0.05], bvid);

    // A viewer thanking the guide on arrival is independent corroboration.
    const thanked = createHarness({ danmaku: [timestamp(text, time), timestamp('感谢跳伞指路', end + 1)] });
    const segment = await thanked.detectAndAttach();
    assert.equal(segment.start, time, bvid);
    assert.equal(segment.requiresConfirmation, false, bvid);
    thanked.tick(time - 0.001);
    assert.deepEqual(thanked.video.seeks, [], bvid);
    thanked.tick(time);
    assert.deepEqual(thanked.video.seeks, [end + 0.05], bvid);
  }
});

test('短时轴放宽仅适用于明确指令，仍遵守 10 秒区间下限', async () => {
  for (const [time, text] of [[137.001, '看看02：36'], [147, '跳伞02：36']]) {
    const h = createHarness({ danmaku: [timestamp(text, time)] });
    assert.equal(await h.detectAndAttach(), null);
    h.tick(time + 5);
    assert.deepEqual(h.video.seeks, []);
  }
});

test('真实弹幕回归：中文零补位保留个位秒数', () => {
  const h = createHarness();
  assert.equal(h.context.extractTimeFromText('我是三分零五郎').time, 185);
  assert.equal(h.context.extractTimeFromText('感谢八分零五郎').time, 485);
  assert.equal(h.context.extractTimeFromText('在下八分零三郎').time, 483);
});

test('79 秒宽泛字幕且没有弹幕：自动模式不 seek', async () => {
  const h = createHarness({ subtitles: weakSubtitles });
  const segment = await h.detectAndAttach();
  assert.equal(segment, null, 'ordinary 免费/搜索 no longer produce an ad candidate');
  h.tick(79);
  h.advanceTimers(10_000);
  assert.deepEqual(h.video.seeks, []);
});

test('明显广告字幕保留候选，只有点击才跳过', async () => {
  const h = createHarness({ subtitles: strongSubtitles }, { debug: true });
  const segment = await h.detectAndAttach();
  assert.ok(segment, '明显赞助/CTA 应保留手动召回');
  assert.equal(segment.source, 'subtitles');
  assert.equal(segment.requiresConfirmation, true);
  h.tick(segment.start);
  assert.equal(h.video.seeks.length, 0);
  assert.match(h.button.textContent, /疑似广告/);
  h.button.click();
  assert.deepEqual(h.video.seeks, [segment.end + 0.05]);
  const skip = diagnostic(h, 'skip:');
  assert.ok(skip);
  assert.equal(skip.trigger, 'manual');
  assert.equal(skip.source, 'subtitles');
});

test('普通教程链接不再回退猜测广告起点', async () => {
  const subtitles = transcript('点击链接查看免费教程', '搜索资料', 139, 161);
  subtitles[2].to = 142;
  const h = createHarness({ subtitles });
  const segment = await h.detectAndAttach();
  assert.equal(segment, null);
  h.tick(82);
  assert.equal(h.video.seeks.length, 0);
});

test('字幕的低置信度标记不因全局状态被重置而允许 auto', async () => {
  const h = createHarness({ subtitles: strongSubtitles });
  const segment = await h.detectAndAttach();
  assert.ok(segment);
  h.evaluate('isSuspiciousAd = false');
  h.tick(segment.start);
  assert.equal(h.video.seeks.length, 0);
});

test('明确弹幕时轴优先于宽泛字幕并使用用户填写的终点', async () => {
  const h = createHarness({ subtitles: weakSubtitles, danmaku: [timestamp()] }, { debug: true });
  const segment = await h.detectAndAttach();
  assert.ok(segment);
  assert.equal(segment.source, 'danmaku-time');
  assert.equal(segment.confidence, 'high');
  assert.equal(segment.requiresConfirmation, false);
  assert.equal(segment.end, 120);
  h.tick(79);
  assert.deepEqual(h.video.seeks, [120.05]);
  const skip = diagnostic(h, 'skip:');
  assert.ok(skip);
  assert.equal(skip.trigger, 'auto');
  assert.equal(skip.source, 'danmaku-time');
});

test('普通孤立时间引用不构成跳过提示', async () => {
  // A remark about a moment in the video is not an instruction; it used to
  // raise a "疑似广告" prompt over ordinary content.
  const h = createHarness({ danmaku: [timestamp('看看 2:00 的细节')] });
  assert.equal(await h.detectAndAttach(), null);
  h.tick(79);
  assert.equal(h.video.seeks.length, 0);
  assert.equal(h.button.parentElement, null);
});

test('无关的时间引用不与字幕广告合并成更大区间', async () => {
  const h = createHarness({ subtitles: strongSubtitles, danmaku: [timestamp('看看 5:00', 235)] });
  const segments = await h.detectAllAndAttach();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].source, 'subtitles');
  assert.ok(segments[0].end <= 110, 'the transcript block stays local');
  assert.equal(segments[0].requiresConfirmation, true);
  h.tick(79);
  h.tick(235);
  assert.equal(h.video.seeks.length, 0);
});

test('重复裸时间引用不能冒充独立投票升级 auto', async () => {
  const h = createHarness({ danmaku: Array.from({ length: 12 }, (_, i) => timestamp('2:00', 70 + i)) });
  const segment = await h.detectAndAttach();
  assert.ok(segment);
  assert.equal(segment.requiresConfirmation, true);
  h.tick(79);
  assert.equal(h.video.seeks.length, 0);
});

test('商业字幕和普通时间引用重合也不能升级 auto', async () => {
  const h = createHarness({ subtitles: strongSubtitles, danmaku: [timestamp('看看 1:43', 70)] });
  const segment = await h.detectAndAttach();
  assert.ok(segment);
  assert.equal(segment.end, 103, 'the transcript gives the bare timestamp its meaning');
  assert.equal(segment.requiresConfirmation, true);
  h.tick(79);
  assert.equal(h.video.seeks.length, 0);
});

for (const text of ['不要跳过 2:00', '不要直接空降03:10', '03:10不是广告结束', '别跳03:10']) {
  test(`否定的跳过指令既不自动跳过也不独自成为提示：${text}`, async () => {
    const h = createHarness({ danmaku: [timestamp(text)] });
    assert.equal(await h.detectAndAttach(), null);
    h.tick(79);
    assert.equal(h.video.seeks.length, 0);
    // Even next to a real instruction a denial adds no trust.
    const mixed = createHarness({ danmaku: [timestamp(text), timestamp('空降03:10', 76)] });
    const segment = await mixed.detectAndAttach();
    assert.equal(segment.requiresConfirmation, true);
    mixed.tick(79);
    assert.equal(mixed.video.seeks.length, 0);
  });
}

for (const text of ['03:10展示传送功能', '03:10的空降兵很厉害']) {
  test(`提到跳转词的普通描述最多只是手动候选：${text}`, async () => {
    const h = createHarness({ danmaku: [timestamp(text)] });
    const segment = await h.detectAndAttach();
    if (segment) assert.equal(segment.requiresConfirmation, true);
    h.tick(74);
    assert.equal(h.video.seeks.length, 0);
  });
}

for (const text of ['跳过广告到03:10', '3:10广告结束', '恭喜接广，空降03:10']) {
  test(`点明是广告的明确指令可自动跳过：${text}`, async () => {
    const h = createHarness({ danmaku: [timestamp(text)] });
    const segment = await h.detectAndAttach();
    assert.ok(segment);
    assert.equal(segment.source, 'danmaku-time');
    assert.equal(segment.start, 74);
    assert.equal(segment.end, 190);
    assert.equal(segment.requiresConfirmation, false);
    h.tick(73.999);
    assert.equal(h.video.seeks.length, 0);
    h.tick(74);
    assert.deepEqual(h.video.seeks, [190.05]);
  });
}

test('只说“空降”的单条指令需要佐证才自动跳过', async () => {
  const alone = createHarness({ danmaku: [timestamp('空降03:10')] });
  const candidate = await alone.detectAndAttach();
  assert.deepEqual([candidate.start, candidate.end, candidate.requiresConfirmation], [74, 190, true]);
  alone.tick(74);
  assert.equal(alone.video.seeks.length, 0);
  assert.match(alone.button.textContent, /疑似广告/);

  for (const [name, extra] of [
    ['second viewer', timestamp('3:10', 77)],
    ['thanks on arrival', timestamp('感谢3分10秒侠', 191)],
    ['arrow-key count', timestamp('向右23下', 75)],
    ['ad reaction', timestamp('恭喜接广', 80)]
  ]) {
    const h = createHarness({ danmaku: [timestamp('空降03:10'), extra] });
    const segment = await h.detectAndAttach();
    assert.equal(segment.requiresConfirmation, false, name);
    assert.equal(segment.end, 190, name);
    h.tick(78);
    assert.deepEqual(h.video.seeks, [190.05], name);
  }
});

test('时刻解析支持两位分钟且不从超长工程数字截取后缀', () => {
  const h = createHarness();
  const parsed = h.context.extractTimeFromText('空降10分20秒');
  assert.equal(parsed.time, 620);
  assert.equal(parsed.reference, '10分20秒');
  assert.equal(h.context.extractTimeFromText('11105工程'), null);
});

test('普通时间引用不能把可靠时轴的起点向前扩展', async () => {
  const h = createHarness({ danmaku: [timestamp('看看 2:30', 60), timestamp('跳过广告 2:30', 95)] });
  const segment = await h.detectAndAttach();
  assert.ok(segment);
  assert.equal(segment.start, 95);
  h.tick(94.999);
  assert.equal(h.video.seeks.length, 0);
  h.tick(95);
  assert.deepEqual(h.video.seeks, [150.05]);
});

test('大量普通时间引用不会压过另一目标的明确指令', async () => {
  const h = createHarness({ danmaku: [
    ...Array.from({ length: 12 }, (_, i) => timestamp('看看 2:00', 70 + i)),
    timestamp('跳过广告 3:00', 100)
  ] });
  const segment = await h.detectAndAttach();
  assert.equal(segment.end, 180);
  assert.equal(segment.requiresConfirmation, false);
  h.tick(105);
  assert.deepEqual(h.video.seeks, [180.05]);
});

test('无效时刻和无效区间不产生候选', async () => {
  for (const danmaku of [
    [timestamp('跳过广告 2:99')],
    [timestamp('跳过广告 2:00', NaN)],
    [timestamp('跳过广告 2:00', Infinity)],
    [timestamp('跳过广告 2:00', -5)],
    [timestamp('空降 2:00', 20)],          // opening jump without any sign of an ad
    [timestamp('跳过广告 1:19', 70)],      // nine seconds: shorter than any sponsor read
    [timestamp('跳过广告 6:15', 74)],      // longer than five minutes
    [timestamp('跳过广告 11:00', 500)],    // beyond the end of a 600-second video
    [timestamp('跳过广告 1:00', 74)]       // backwards
  ]) {
    const h = createHarness({ danmaku });
    assert.equal(await h.detectAndAttach(), null, danmaku[0].textContent);
    h.tick(79);
    h.tick(505);
    assert.equal(h.video.seeks.length, 0);
  }
});

test('区间长度边界：10 秒到 300 秒', async () => {
  for (const [text, time, expected] of [
    ['跳过广告 1:24', 74, 84], ['跳过广告 1:23', 74, null],
    ['跳过广告 6:14', 74, 374], ['跳过广告 6:15', 74, null]
  ]) {
    const segment = await createHarness({ danmaku: [timestamp(text, time)] }).detectAndAttach();
    assert.equal(segment?.end ?? null, expected, text);
  }
});

test('片尾广告：指向视频结尾的指令不再被丢弃', async () => {
  // Sixty-five reviewed ads sit in the last seconds of their video; the old
  // "not within 20 s of the end" rule discarded every one of them.
  const h = createHarness({ danmaku: [timestamp('跳过广告 10:00', 500)] });
  const segment = await h.detectAndAttach();
  assert.deepEqual([segment.start, segment.end], [500, 600]);
  const beyond = await createHarness({ danmaku: [timestamp('跳过广告 9:50', 500)] }).detectAndAttach();
  assert.equal(beyond.end, 590);
});

test('没有显式可信标记的区间默认禁止自动跳过', () => {
  const h = createHarness();
  h.setMode('auto');
  h.evaluate('currentVideo = __video; isSuspiciousAd = false; attachSkipper({ start: 79, end: 103 })');
  h.tick(79);
  assert.equal(h.video.seeks.length, 0);
  assert.match(h.button.textContent, /疑似广告/);
});

test('没有字幕和弹幕时不检测、不 seek', async () => {
  const h = createHarness();
  assert.equal(await h.detectAndAttach(), null);
  h.tick(79);
  assert.deepEqual(h.video.seeks, []);
});

test('没有字幕时仍能使用明确弹幕时轴', async () => {
  const h = createHarness({ danmaku: [timestamp()] });
  const segment = await h.detectAndAttach();
  assert.ok(segment);
  assert.equal(h.subtitleFetches, 0);
  h.tick(79);
  assert.deepEqual(h.video.seeks, [120.05]);
});

test('章节优先于简介、弹幕和字幕', async () => {
  const h = createHarness({
    chapters: [{ from: 70, to: 135, content: '广告' }],
    videoInfo: { desc: '1:10 广告\n2:20 正片' },
    danmaku: [timestamp()], subtitles: strongSubtitles
  });
  const segment = await h.detectAndAttach();
  assert.equal(segment.source, 'chapters');
  assert.equal(segment.requiresConfirmation, false);
  assert.equal(segment.end, 135);
  h.tick(79);
  assert.deepEqual(h.video.seeks, [135.05]);
});

test('简介时轴优先于弹幕和字幕', async () => {
  const h = createHarness({
    videoInfo: { desc: '1:10 广告\n2:20 正片' },
    danmaku: [timestamp()], subtitles: strongSubtitles
  });
  const segment = await h.detectAndAttach();
  assert.equal(segment.source, 'description');
  assert.equal(segment.end, 140);
  h.tick(79);
  assert.deepEqual(h.video.seeks, [140.05]);
});

test('manual 切到 auto：可靠时轴开始自动跳过', async () => {
  const h = createHarness({ danmaku: [timestamp()] });
  await h.detectAndAttach('manual');
  h.tick(79);
  assert.equal(h.video.seeks.length, 0);
  assert.ok(h.button.parentElement);
  h.setMode('auto');
  h.tick(80);
  assert.deepEqual(h.video.seeks, [120.05]);
});

test('auto 切到 manual：可靠时轴等点击', async () => {
  const h = createHarness({ danmaku: [timestamp()] });
  await h.detectAndAttach();
  h.setMode('manual');
  h.tick(79);
  assert.equal(h.video.seeks.length, 0);
  h.button.click();
  assert.deepEqual(h.video.seeks, [120.05]);
});

test('manual 切到 auto 不会把字幕升级成可靠时轴', async () => {
  const h = createHarness({ subtitles: strongSubtitles });
  const segment = await h.detectAndAttach('manual');
  h.tick(segment.start);
  h.setMode('auto');
  h.tick(segment.start + 1);
  assert.equal(h.video.seeks.length, 0);
});

test('timeupdate 重入和回看均只自动跳过一次', async () => {
  const h = createHarness({ danmaku: [timestamp()] });
  await h.detectAndAttach();
  h.tick(79);
  h.tick(80); // Seek completion is deliberately delayed.
  h.video.dispatch('seeked');
  h.advanceTimers(2_000);
  h.tick(79); // User seeks backwards into the segment.
  assert.deepEqual(h.video.seeks, [120.05]);
});

test('疑似广告倒计时结束不会触发 seek', async () => {
  const h = createHarness({ subtitles: strongSubtitles });
  const segment = await h.detectAndAttach();
  h.tick(segment.start);
  h.advanceTimers(10_000);
  assert.equal(h.video.seeks.length, 0);
  assert.equal(h.button.parentElement, null);
});

test('DEBUG 显式关闭时检测与跳过不输出诊断日志', async () => {
  const h = createHarness({ subtitles: strongSubtitles, danmaku: [timestamp('看看 1:43', 70)] }, { debug: false });
  assert.equal(h.evaluate('DEBUG'), false);
  const startupLogCount = h.logs.length;
  const segments = await h.detectAllAndAttach();
  assert.ok(segments.length);
  h.tick(segments[0].start);
  h.button.click();
  assert.equal(h.video.seeks.length, 1);
  assert.deepEqual(h.logs.slice(startupLogCount), []);
});

test('DEBUG 显式开启时检测日志包含来源、置信度、依据和命中关键词', async () => {
  const h = createHarness({ subtitles: strongSubtitles }, { debug: true });
  assert.equal(h.evaluate('DEBUG'), true);
  await h.detectAndAttach();
  const detail = diagnostic(h, 'detection:');
  assert.ok(detail, 'DEBUG=true 时需有可诊断日志');
  assert.equal(detail.bvid, 'BV_fixture');
  assert.equal(detail.cid, 14);
  assert.equal(detail.source, 'subtitles');
  assert.equal(detail.confidence, 'low');
  assert.equal(detail.requiresConfirmation, true);
  assert.equal(detail.reason, 'commercial-subtitle-block');
  assert.ok(detail.matchedKeywords.some(phrase => phrase.includes('优惠券')));
  assert.equal(detail.boundaryEvidence.start.kind, 'first-pitch-line');
});

test('合成矩阵：宽泛字幕的词对/位置/间隔均不能 auto', async t => {
  const phrases = ['这个工具是免费的', '搜索这段文字', '推荐给大家学习', '点击这个菜单', '下载示例文件'];
  let scenarios = 0;
  for (const first of phrases) for (const second of phrases) {
    for (const start of [79, 210]) for (const gap of [12, 60, 121]) {
      const h = createHarness({ subtitles: transcript(first, second, start, gap) });
      await h.detectAndAttach();
      h.tick(start);
      h.tick(start + gap);
      h.advanceTimers(10_000);
      assert.equal(h.video.seeks.length, 0, `${first} / ${second}, start=${start}, gap=${gap}`);
      scenarios++;
    }
  }
  t.diagnostic(`${scenarios} synthetic scenarios; not measurements from real videos`);
});

test('合成矩阵：明确跳过意图保留常见时间格式召回', async t => {
  let scenarios = 0;
  const formats = [['2:00', 120], ['2：00', 120], ['2;00', 120], ['2；00', 120], ['2∶00', 120],
    ['二分十秒', 130], ['2分0秒', 120], ['两分零五', 125], ['2分05', 125]];
  for (const intent of ['跳过广告', '空降', '跳伞', '指路', '传送', '正片开始', '跳转', '我是']) {
    for (const [time, end] of formats) {
      const text = intent === '我是' ? `我是${time}君` : `${intent} ${time}`;
      // Alone: always found with the viewer's destination; taken unprompted only
      // when the comment itself says it is an ad.
      const alone = createHarness({ danmaku: [timestamp(text)] });
      const candidate = await alone.detectAndAttach();
      assert.ok(candidate, text);
      assert.equal(candidate.end, end, text);
      assert.equal(candidate.requiresConfirmation, intent !== '跳过广告', text);
      // With a second viewer naming the same second: taken in auto mode.
      const h = createHarness({ danmaku: [timestamp(text), timestamp(`${Math.floor(end / 60)}:${String(end % 60).padStart(2, '0')}`, 76)] });
      const segment = await h.detectAndAttach();
      assert.equal(segment.requiresConfirmation, false, text);
      h.tick(79);
      assert.deepEqual(h.video.seeks, [end + 0.05], text);
      scenarios++;
    }
  }
  for (const text of ['200工程', '0200工程', '2.00工程', '░░200工程░░', '200认证成功', '跳伞200', '空降0200']) {
    const candidate = await createHarness({ danmaku: [timestamp(text)] }).detectAndAttach();
    assert.equal(candidate?.end, 120, text);
    const h = createHarness({ danmaku: [timestamp(text), timestamp('感谢200工程', 121)] });
    assert.ok(await h.detectAndAttach(), text);
    h.tick(79);
    assert.deepEqual(h.video.seeks, [120.05], text);
    scenarios++;
  }
  t.diagnostic(`${scenarios} synthetic explicit-timestamp scenarios; not real-video recall`);
});

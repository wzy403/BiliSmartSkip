const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const verifier = require(path.join(require('./source-directory.cjs'), 'heatmap-verifier.js'));

const plain = value => JSON.parse(JSON.stringify(value));
const pbp = (values, step = 10) => ({ modules: [{ name: 'pbp', params: { data: {
  step_sec: step, events: { default: values }
} } }] });
const heatmap = (level = 10) => pbp(Array.from({ length: 20 }, (_, index) => index === 15 ? 100 : level));
const candidate = overrides => ({ start: 40, end: 60, source: 'segment-detector', requiresConfirmation: true, ...overrides });
const input = subtitles => ({ duration: 200, subtitles: subtitles || [] });
const helpers = { getSubtitleEvidence: content => ({ categories: {
  '本期视频由某品牌赞助': ['sponsor'],
  '领取优惠券': ['offer'],
  '点击链接下单': ['cta']
}[content] || [] }) };
const verify = (segments, source = input(), curve = heatmap(), policy = 'weighted-50') =>
  verifier.verify(segments, source, curve, policy, helpers);
const body = [
  { from: 40, to: 60, content: '这里介绍普通历史背景' },
  { from: 60, to: 80, content: '接着讨论这个历史事件' }
];

test('author-labelled boundaries are protected even under a cold heatmap', () => {
  for (const segment of [candidate({ source: 'chapters', requiresConfirmation: false }),
    candidate({ source: 'description', requiresConfirmation: false }),
    candidate({ reason: 'explicit-ad-chapter' })]) {
    for (const policy of ['cold-50', 'weighted-50', 'weighted-50-review']) {
      const result = verify([segment], input(), heatmap(), policy);
      assert.equal(result.segments.length, 1);
      assert.equal(result.decisions[0].action, 'keep');
      assert.equal(result.decisions[0].evidence.authorLabel, true);
      assert.equal(result.segments[0].requiresConfirmation, segment.requiresConfirmation);
    }
  }
});

test('sponsor plus distinct commercial evidence retains a cold candidate', () => {
  const subtitles = [
    { from: 40, to: 44, content: '本期视频由某品牌赞助' },
    { from: 44, to: 50, content: '领取优惠券' },
    { from: 50, to: 60, content: '点击链接下单' }
  ];
  const result = verify([candidate()], input(subtitles));
  assert.equal(result.segments.length, 1);
  assert.equal(result.decisions[0].evidence.level, 2);
  assert.equal(result.decisions[0].score, 1);
  assert.equal(result.decisions[0].action, 'keep');
});

test('observed sponsor and commercial roles also protect a cold candidate', () => {
  const segment = candidate({ observedEvidence: [
    { roles: ['sponsorIntro'] }, { roles: ['offer'] }, { roles: ['cta'] }
  ] });
  const result = verify([segment]);
  assert.equal(result.segments.length, 1);
  assert.equal(result.decisions[0].evidence.level, 2);
});

test('explicit ad jump text and corroborating ad reactions retain cold candidates', () => {
  for (const segment of [
    candidate({ source: 'danmaku-time', matchedKeywords: ['跳过广告'] }),
    candidate({ source: 'danmaku-time', explicitCount: 1, adReactionCount: 2 })
  ]) {
    assert.equal(verify([segment]).decisions[0].action, 'keep');
  }
});

test('a weak manual candidate in a cold segment and cold destination is suppressed', () => {
  const result = verify([candidate()]);
  assert.equal(result.segments.length, 0);
  assert.equal(result.decisions[0].action, 'suppress');
  assert.equal(result.decisions[0].reason, 'weak-ad-evidence-and-cold-heatmap');
  assert.equal(result.decisions[0].peak, 0.1);
  assert.equal(result.decisions[0].endPeak, 0.1);
});

test('a peak just after the destination rescues a cold manual candidate', () => {
  const response = heatmap();
  response.modules[0].params.data.events.default[7] = 100;
  const result = verify([candidate()], input(), response);
  assert.equal(result.segments.length, 1);
  assert.equal(result.decisions[0].peak, 0.1);
  assert.equal(result.decisions[0].endPeak, 1);
  assert.equal(result.decisions[0].heatWeight, 0.5);
  assert.equal(result.decisions[0].action, 'keep');
});

test('high heat adds supporting weight without promoting manual candidates or moving boundaries', () => {
  const segment = candidate({ start: 140, end: 160, confidence: 'low', autoEligible: false });
  const result = verify([segment]);
  const retained = result.segments[0];
  assert.equal(result.decisions[0].heatWeight, 0.5);
  assert.equal(result.decisions[0].score, 1.5);
  assert.equal(retained.requiresConfirmation, true);
  assert.equal(retained.autoEligible, false);
  assert.equal(retained.confidence, 'low');
  assert.equal(retained.start, 140);
  assert.equal(retained.end, 160);
});

test('missing, flat, truncated and malformed heatmap data is neutral', () => {
  const segment = candidate();
  const invalid = [null, {}, { modules: [] }, pbp([0, 0]), pbp(Array(20).fill(1)),
    pbp([0, 1]), pbp([1, NaN, 3]), pbp([1, -1, 3]), pbp([1, '2', 3]),
    pbp([0, 1], 0), pbp([0, 1], -10), pbp([0, 1], '100')];
  const repeated = heatmap();
  repeated.modules.push(repeated.modules[0]);
  invalid.push(repeated);
  for (const response of invalid) {
    const result = verify([segment], input(), response);
    assert.equal(result.available, false);
    assert.deepEqual(result.segments, [segment]);
    assert.equal(result.decisions[0].reason, 'no-heatmap-veto');
  }
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.equal(verifier.parseCurve(heatmap(), duration), null);
  }
});

test('verification leaves candidates, evidence, subtitles and raw response unchanged', () => {
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const segments = freeze([candidate(), candidate({ start: 140, end: 160 })]);
  const source = freeze(input(body));
  const response = freeze(heatmap());
  const before = plain({ segments, source, response });
  const result = verify(segments, source, response);
  assert.equal(result.segments.length, 1);
  assert.notEqual(result.segments[0], segments[1]);
  assert.deepEqual(plain({ segments, source, response }), before);
});

test('generic automatic jumps are downgraded only by the review policy with very low heat and known body content', () => {
  const segment = candidate({ end: 80, source: 'danmaku-time', requiresConfirmation: false,
    matchedKeywords: ['空降'], autoEligible: true, confidence: 'high' });
  for (const policy of ['cold-25', 'cold-50', 'weighted-25', 'weighted-50']) {
    assert.equal(verify([segment], input(body), heatmap(), policy).segments[0].requiresConfirmation, false);
  }
  const result = verify([segment], input(body), heatmap(), 'weighted-50-review');
  assert.equal(result.decisions[0].action, 'review');
  assert.equal(result.segments[0].requiresConfirmation, true);
  assert.equal(result.segments[0].autoEligible, false);
  assert.equal(result.segments[0].start, segment.start);
  assert.equal(result.segments[0].end, segment.end);
  assert.equal(verify([segment], input(body), heatmap(30), 'weighted-50-review').segments[0].requiresConfirmation, false);
  assert.equal(verify([segment], input(body), heatmap(25), 'weighted-50-review').segments[0].requiresConfirmation, false);
  assert.equal(verify([{ ...segment, source: 'segment-detector' }], input(body), heatmap(),
    'weighted-50-review').segments[0].requiresConfirmation, false);
});

test('missing or sparsely covered subtitles cannot downgrade a generic automatic jump', () => {
  const segment = candidate({ end: 80, source: 'danmaku-time', requiresConfirmation: false });
  for (const subtitles of [[], [{ from: 40, to: 80, content: '单行不能证明正文' }],
    [{ from: 40, to: 43, content: '正文片段' }, { from: 50, to: 53, content: '另一片段' }]]) {
    const result = verify([segment], input(subtitles), heatmap(), 'weighted-50-review');
    assert.equal(result.decisions[0].action, 'keep');
    assert.equal(result.segments[0].requiresConfirmation, false);
  }
  const noHelper = verifier.verify([segment], input(body), heatmap(), 'weighted-50-review');
  assert.equal(noHelper.segments[0].requiresConfirmation, false);
});

test('overlapping subtitle rows cannot manufacture known body coverage for an automatic downgrade', () => {
  const segment = candidate({ end: 80, source: 'danmaku-time', requiresConfirmation: false });
  const subtitles = [{ from: 40, to: 51, content: '普通正文第一行' }, { from: 40, to: 51, content: '重复时段第二行' }];
  const result = verify([segment], input(subtitles), heatmap(), 'weighted-50-review');
  assert.equal(result.decisions[0].evidence.knownNonCommercial, false);
  assert.equal(result.segments[0].requiresConfirmation, false);
});

test('separate candidates receive independent heatmap decisions', () => {
  const cold = candidate(), hot = candidate({ start: 140, end: 160 });
  const result = verify([cold, hot]);
  assert.deepEqual(result.decisions.map(decision => decision.action), ['suppress', 'keep']);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].start, hot.start);
  assert.equal(result.segments[0].end, hot.end);
});

test('window peaks interpolate both interval edges, include sampled peaks and hold the final sample', () => {
  const curve = verifier.parseCurve(pbp([0, 100, 0, 50]), 40);
  assert.equal(verifier.windowPeak(curve, 2, 4), 0.4);
  assert.equal(verifier.windowPeak(curve, 9, 11), 1);
  assert.equal(verifier.windowPeak(curve, 20, 25), 0.25);
  assert.equal(verifier.windowPeak(curve, 35, 40), 0.5);
  assert.equal(verifier.windowPeak(curve, 0, 10), 1);
  for (const [start, end] of [[10, 10], [-1, 10], [20, 41], [NaN, 10], [10, Infinity]]) {
    assert.equal(verifier.windowPeak(curve, start, end), null);
  }
});

test('sample positions span the video as i / n even when declared step overstates its duration', () => {
  // The public PBP renderer places samples by percentage i / n. step_sec is
  // retained as a coverage sanity check, not a reason to discard valid tails.
  const curve = verifier.parseCurve(pbp([0, 100, 0, 50], 20), 40);
  assert.ok(curve);
  assert.equal(verifier.windowPeak(curve, 2, 4), 0.4);
  assert.equal(verifier.windowPeak(curve, 9, 11), 1);
  assert.equal(verifier.windowPeak(curve, 35, 40), 0.5);
  assert.equal(verifier.parseCurve(pbp([0, 100, 0, 50], 5), 40), null,
    'normalization must not fill a genuinely truncated source with imaginary data');
});

test('off preserves every candidate even when a cold curve is available', () => {
  const segment = candidate();
  const result = verify([segment], input(), heatmap(), 'off');
  assert.deepEqual(result.segments, [segment]);
  assert.equal(result.decisions[0].action, 'keep');
});

test('selected default suppresses only a weak keyword candidate with observed ordinary content', () => {
  assert.equal(verifier.DEFAULT_POLICY, 'keyword-context-25');
  const segment = candidate({ end: 80, source: 'danmaku-keywords' });
  const result = verifier.verify([segment], input(body), heatmap(), undefined, helpers);
  assert.equal(verifier.needsHeatmap([segment], input(body), helpers), true);
  assert.equal(result.decisions[0].action, 'suppress');
  assert.equal(result.segments.length, 0);
  assert.equal(verifier.verify([segment], input(body), heatmap(25), undefined, helpers).segments.length, 1);
});

test('selected default protects timestamps, subtitle evidence, sponsor, promotion and unknown context', () => {
  const weak = candidate({ end: 80, source: 'danmaku-keywords' });
  const cases = [
    { segment: { ...weak, source: 'danmaku-time' }, subtitles: body },
    { segment: { ...weak, source: 'subtitles' }, subtitles: body },
    { segment: { ...weak, source: 'segment-detector' }, subtitles: body },
    { segment: weak, subtitles: [] },
    { segment: weak, subtitles: [{ from: 40, to: 80, content: '正文但仅一行' }] },
    { segment: weak, subtitles: [body[0], { from: 60, to: 80, content: '本期视频由某品牌赞助' }] },
    { segment: weak, subtitles: [body[0], { from: 60, to: 80, content: '领取优惠券' }] },
    { segment: { ...weak, requiresConfirmation: false }, subtitles: body }
  ];
  for (const { segment, subtitles } of cases) {
    assert.equal(verifier.needsHeatmap([segment], input(subtitles), helpers), false);
    const result = verifier.verify([segment], input(subtitles), heatmap(), undefined, helpers);
    assert.equal(result.decisions[0].action, 'keep');
    assert.equal(result.segments[0].requiresConfirmation, segment.requiresConfirmation);
    assert.equal(result.segments[0].start, segment.start);
    assert.equal(result.segments[0].end, segment.end);
  }
});

test('selected default treats high heat only as supporting weight and preserves manual choice and boundaries', () => {
  const segment = candidate({ start: 140, end: 160, source: 'danmaku-keywords', confidence: 'low' });
  const subtitles = [{ from: 140, to: 150, content: '这是普通正文' }, { from: 150, to: 160, content: '这里继续普通正文' }];
  const result = verifier.verify([segment], input(subtitles), heatmap(), undefined, helpers);
  assert.equal(result.decisions[0].heatWeight, 0.5);
  assert.equal(result.segments[0].requiresConfirmation, true);
  assert.equal(result.segments[0].confidence, 'low');
  assert.equal(result.segments[0].start, segment.start);
  assert.equal(result.segments[0].end, segment.end);
});

test('null and invalid subtitle rows cannot fail optional verification or supply body coverage', () => {
  const segment = candidate({ end: 80, source: 'danmaku-keywords', observedEvidence: [null] });
  const invalidRows = [null, undefined, {}, 'not a subtitle',
    { from: 40, to: 80, content: null }, { from: NaN, to: 80, content: '未知' },
    { from: -1, to: 80, content: '错误时间' }, { from: 60, to: 40, content: '逆序时间' }];
  for (const subtitles of [null, {}, 'unavailable', invalidRows]) {
    const source = { duration: 200, subtitles };
    assert.equal(verifier.needsHeatmap([segment], source, helpers), false);
    const result = verifier.verify([segment], source, heatmap(), undefined, helpers);
    assert.equal(result.decisions[0].action, 'keep');
    assert.equal(result.decisions[0].evidence.knownNonCommercial, false);
    assert.equal(result.segments[0].start, segment.start);
    assert.equal(result.segments[0].end, segment.end);
  }
  const source = input([...invalidRows, ...body]);
  assert.equal(verifier.needsHeatmap([segment], source, helpers), true);
  assert.equal(verifier.verify([segment], source, heatmap(), undefined, helpers).decisions[0].action, 'suppress');
});

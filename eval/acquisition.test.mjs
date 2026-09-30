import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCorpus, toJSONL, subtitleURL, createRequester, enrichRecord } from './acquisition.mjs';

const seed = () => ({
  bvid: 'BV1Qy411v7VK', cid: 25686575266, title: '测试视频', duration: 671,
  creator: { mid: 42, name: '测试作者' }, subtitles: [], chapters: [],
  danmaku: [{ time: 288.984, textContent: '跳伞5:17' }],
  annotations: { status: 'unreviewed', segments: [] },
  references: [{ source: 'community', segments: [{ start: 288, end: 317 }] }],
  acquisition: { metadata: 'available', danmaku: 'available', subtitles: 'unavailable', method: 'public-collector' }
});
const lines = [{ from: 1, to: 3, content: '正文', ignored: 'not-exported' }];
const track = { lan: 'ai-zh', type: 1, subtitle_url: '//aisubtitle.hdslb.com/test.json?private-signature=secret' };
const player = extra => ({ code: 0, data: {
  cid: seed().cid, bvid: seed().bvid, subtitle: { subtitles: [track] },
  view_points: [{ from: 288, to: 317, content: '广告' }], accountPrivate: 'not-exported', ...extra
} });

test('JSONL imports preserve corpus fields and reject invalid identities/duplicates', () => {
  const item = seed();
  assert.deepEqual(parseCorpus(toJSONL([item])), [item]);
  assert.deepEqual(parseCorpus(JSON.stringify({ videos: [item] })), [item]);
  assert.deepEqual(parseCorpus(JSON.stringify([item])), [item]);
  assert.throws(() => parseCorpus(toJSONL([item, item])), /重复/);
  assert.throws(() => parseCorpus(JSON.stringify({ ...item, bvid: 'not-a-bvid' })), /BV/);
  for (const cid of [0, -1, 1.5, true, null, '1&bad=1', '9007199254740993']) {
    assert.throws(() => parseCorpus(JSON.stringify({ ...item, cid })), /CID/);
  }
});

test('successful enrichment retains annotations/references and exports only transcript/chapter fields', async () => {
  const original = seed();
  const before = structuredClone(original), calls = [];
  const result = await enrichRecord(original, { now: () => 'fixed-time', request: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? player() : { body: lines };
  } });
  assert.equal(result.status, 'available');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[1].options.credentials, 'omit');
  assert.equal(new URL(calls[0].url).searchParams.get('cid'), String(original.cid));
  assert.deepEqual(original, before);
  for (const key of ['creator', 'danmaku', 'annotations', 'references']) assert.deepEqual(result.record[key], before[key]);
  assert.deepEqual(result.record.subtitles, [{ from: 1, to: 3, content: '正文' }]);
  assert.deepEqual(result.record.chapters, [{ from: 288, to: 317, content: '广告' }]);
  assert.equal(result.record.acquisition.metadata, 'available');
  assert.equal(result.record.acquisition.danmaku, 'available');
  assert.equal(result.record.acquisition.method, 'public-collector');
  assert.equal(result.record.acquisition.subtitleSource, 'ai');
  assert.equal(result.record.acquisition.subtitleFetchedAt, 'fixed-time');
  assert.doesNotMatch(toJSONL([result.record]), /private-signature|not-exported|subtitle_url/);
});

test('subtitle selection matches production API order for AI/human Chinese tracks and fallback', async () => {
  const human = { lan: 'zh-CN', type: 0, subtitle_url: 'https://i1.hdslb.com/human.json' };
  const english = { lan: 'en', type: 0, subtitle_url: 'https://i1.hdslb.com/english.json' };
  for (const [tracks, expectedTrack] of [
    [[track, human], track], [[human, track], human], [[english, track, human], track], [[english], english]
  ]) {
    const urls = [];
    const result = await enrichRecord(seed(), { request: async url => {
      urls.push(url);
      return urls.length === 1 ? player({ subtitle: { subtitles: tracks } }) : { body: lines };
    } });
    assert.equal(result.status, 'available');
    assert.equal(urls[1], subtitleURL(expectedTrack.subtitle_url));
    assert.equal(result.record.acquisition.subtitleLanguage, expectedTrack.lan);
  }
});

test('existing subtitles are retained without network', async () => {
  const record = { ...seed(), subtitles: lines };
  const result = await enrichRecord(record, { request: () => assert.fail('must not request') });
  assert.equal(result.record, record);
  assert.equal(result.reason, 'existing-subtitles');
});

test('login and API risk controls pause without requesting the subtitle body', async () => {
  for (const [response, status] of [[player({ need_login_subtitle: true }), 'login-required'],
    [{ code: -101 }, 'login-required'], [{ code: -352 }, 'error']]) {
    let calls = 0;
    const result = await enrichRecord(seed(), { request: async () => { calls++; return response; } });
    assert.equal(calls, 1); assert.equal(result.status, status); assert.equal(result.pause, true);
    assert.equal(result.record.acquisition.danmaku, 'available');
  }
});

test('empty, unsupported and request errors remain distinct', async () => {
  for (const [response, expected] of [[player({ subtitle: { subtitles: [] } }), 'empty'],
    [player({ subtitle: null }), 'unsupported'], [{ code: -400 }, 'error'], [{ something: 'else' }, 'unsupported']]) {
    const result = await enrichRecord(seed(), { request: async () => response });
    assert.equal(result.status, expected); assert.equal(result.pause, false);
  }
  let calls = 0;
  const result = await enrichRecord(seed(), { request: async () => ++calls === 1 ? player() : { body: [{ from: 1, to: 0, content: 'invalid' }] } });
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.record.subtitles, []);
});

test('unexpected part identity and non-allowlisted URLs do not trigger a second request', async () => {
  for (const data of [player({ cid: 123 }), player({ subtitle: { subtitles: [{ ...track, subtitle_url: 'https://example.com/private' }] } })]) {
    let calls = 0;
    const result = await enrichRecord(seed(), { request: async () => { calls++; return data; } });
    assert.equal(calls, 1); assert.notEqual(result.status, 'available');
  }
  for (const url of ['http://i0.hdslb.com/a', 'https://i0.hdslb.com.evil.test/a', 'https://user:secret@i0.hdslb.com/a', 'https://i0.hdslb.com:8443/a', 'javascript:alert(1)']) {
    assert.throws(() => subtitleURL(url));
  }
});

test('HTTP access restrictions pause, and fetch rejects redirects without exposing credentials', async () => {
  for (const code of [401, 403, 412, 429]) {
    const request = createRequester({ intervalMs: 0, fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error'); return { ok: false, status: code };
    } });
    const result = await enrichRecord(seed(), { request });
    assert.equal(result.pause, true);
    assert.equal(result.reason, `http-${code}`);
  }
});

test('stop aborts in-flight request and produces a resumable record', async () => {
  const controller = new AbortController();
  let signalSeen;
  const request = createRequester({ intervalMs: 0, fetchImpl: async (url, options) => {
    signalSeen = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort',
      () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const pending = enrichRecord(seed(), { request, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(signalSeen.aborted, true);
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.pause, true);
});

test('stop cancels throttle waiting without starting another request', async () => {
  let calls = 0;
  const request = createRequester({ intervalMs: 1500, fetchImpl: async () => {
    calls++; return { ok: true, json: async () => player() };
  } });
  await request('https://api.bilibili.com/test');
  const controller = new AbortController();
  const pending = request('https://api.bilibili.com/test', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

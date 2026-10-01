const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = name => readFileSync(path.join(__dirname, '../scr', name), 'utf8');
const apiSource = source('api.js');
const bridgeSource = source('page-data.js');
const bvid = 'BV1iQeM6uEEH';
const sample = overrides => ({
  bvid, cid: 101, title: 'Video', desc: '', duration: 600,
  pages: [{ page: 1, cid: 101, duration: 240 }, { page: 2, cid: 102, duration: 360 }],
  ...overrides
});
const plain = value => JSON.parse(JSON.stringify(value));
const jsonResponse = data => ({ ok: true, status: 200, json: async () => data });
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ video = sample(), search = '', bridgeError = false, holdBridge = false,
  fetchImpl = async () => { throw new Error('Unexpected network request'); } } = {}) {
  const requests = [], scripts = [];
  const location = { pathname: `/video/${bvid}/`, search };
  const context = vm.createContext({
    window: { location }, location, URL, URLSearchParams, AbortController, TextDecoder,
    setTimeout, clearTimeout, console: { info() {}, warn() {}, log() {} }, log() {},
    chrome: { runtime: { getURL: resource => `chrome-extension://test/${resource}` },
      storage: { local: { get() {} }, onChanged: { addListener() {} } } },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchImpl(url, options);
    },
    document: {
      createElement(tag) {
        assert.equal(tag, 'script');
        return { dataset: {}, removed: false, remove() { this.removed = true; } };
      },
      head: { appendChild(script) {
        scripts.push(script);
        if (!holdBridge) queueMicrotask(() => completeBridge(script));
      } }
    }
  });
  function completeBridge(script = scripts.at(-1)) {
    if (bridgeError) return script.onerror();
    vm.runInNewContext(bridgeSource, { document: { currentScript: script }, window: {
      __INITIAL_STATE__: video ? { videoData: video } : undefined
    } });
    script.onload();
  }
  vm.runInContext(apiSource, context);
  return { context, location, requests, scripts, completeBridge };
}

function protobuf(time, text) {
  function varint(value) {
    const bytes = [];
    do { bytes.push((value % 128) | (value >= 128 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
    return bytes;
  }
  const content = [...Buffer.from(text)];
  const element = [16, ...varint(time * 1000), 58, ...varint(content.length), ...content];
  const buffer = Uint8Array.from([10, ...varint(element.length), ...element]).buffer;
  return { ok: true, status: 200, arrayBuffer: async () => buffer };
}

test('page bridge supplies metadata without calling view and removes its script', async () => {
  const h = harness();
  assert.deepEqual(plain(await h.context.fetchVideoInfo(bvid)), {
    cid: 101, title: 'Video', desc: '', duration: 240
  });
  assert.equal(h.requests.length, 0);
  assert.equal(h.scripts[0].src, 'chrome-extension://test/scr/page-data.js');
  assert.equal(h.scripts[0].removed, true);
});

test('bridge failure falls back to a credentialed view API request', async () => {
  const h = harness({ bridgeError: true, fetchImpl: async () => jsonResponse({ code: 0, data: sample() }) });
  assert.equal((await h.context.fetchVideoInfo(bvid)).cid, 101);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /\/x\/web-interface\/view\?bvid=BV1iQeM6uEEH$/);
  assert.equal(h.requests[0].options.credentials, 'include');
  assert.equal(h.scripts[0].removed, true);
});

test('HTTP 412 returns null without trying to decode its HTML as JSON', async () => {
  let parsed = false;
  const h = harness({ video: null, fetchImpl: async () => ({
    ok: false, status: 412, json() { parsed = true; throw new Error('HTML is not JSON'); }
  }) });
  assert.equal(await h.context.fetchVideoInfo(bvid), null);
  assert.equal(parsed, false);
  assert.equal(h.requests.length, 1);
});

test('P2 uses its own CID and duration; missing P2 never falls back to P1', async () => {
  const h = harness({ search: '?p=2' });
  assert.deepEqual(plain(await h.context.fetchVideoInfo(bvid)), {
    cid: 102, title: 'Video', desc: '', duration: 360
  });
  const missing = sample({ pages: [{ page: 1, cid: 101, duration: 240 }] });
  const absent = harness({ video: missing, search: '?p=2',
    fetchImpl: async () => jsonResponse({ code: 0, data: missing }) });
  assert.equal(await absent.context.fetchVideoInfo(bvid), null);
  assert.equal(absent.context.normalizeVideoInfo(sample({ pages: [] }), bvid, 2), null);
});

test('page selection is snapshotted before awaiting bridge and API responses', async () => {
  const response = deferred();
  const h = harness({ search: '?p=2', bridgeError: true, holdBridge: true,
    fetchImpl: () => response.promise });
  const pending = h.context.fetchVideoInfo(bvid);
  h.location.search = '?p=1';
  h.completeBridge();
  await tick();
  h.location.search = '?p=3';
  response.resolve(jsonResponse({ code: 0, data: sample() }));
  assert.equal((await pending).cid, 102);
});

test('stale BV metadata is rejected from both the page and API', async () => {
  const stale = sample({ bvid: 'BV1otherVideo' });
  const h = harness({ video: stale, fetchImpl: async () => jsonResponse({ code: 0, data: stale }) });
  assert.equal(await h.context.fetchVideoInfo(bvid), null);
  assert.equal(h.requests.length, 1);
});

test('successful protobuf segments survive another segment failing and are sorted', async () => {
  const h = harness({ fetchImpl: async url => {
    assert.equal(new URL(url).hostname, 'api.bilibili.com');
    const index = Number(new URL(url).searchParams.get('segment_index'));
    if (index === 2) throw new Error('Temporary network failure');
    return protobuf(index === 1 ? 12 : 5, `segment-${index}`);
  } });
  assert.deepEqual(plain(await h.context.fetchDanmakuWithTime(101, 1080)), [
    { time: 5, textContent: 'segment-3' }, { time: 12, textContent: 'segment-1' }
  ]);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(request => request.options.credentials === 'include'));
});

test('protobuf fetching stays at two concurrent requests', async () => {
  let active = 0, peak = 0;
  const h = harness({ fetchImpl: async url => {
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
    const index = Number(new URL(url).searchParams.get('segment_index'));
    return protobuf(index, `segment-${index}`);
  } });
  assert.equal((await h.context.fetchDanmakuWithTime(101, 1800)).length, 5);
  assert.equal(peak, 2);
  assert.equal(h.requests.length, 5);
});

test('a 412 stops new protobuf requests while retaining the other in-flight result', async () => {
  const first = deferred(), second = deferred();
  const h = harness({ fetchImpl: url => {
    const index = Number(new URL(url).searchParams.get('segment_index'));
    assert.ok(index <= 2, 'no requests after the two already in flight');
    return index === 1 ? first.promise : second.promise;
  } });
  const pending = h.context.fetchDanmakuWithTime(101, 3600);
  assert.equal(h.requests.length, 2);
  first.resolve({ ok: false, status: 412 });
  await tick();
  assert.equal(h.requests.length, 2);
  second.resolve(protobuf(400, 'kept'));
  assert.deepEqual(plain(await pending), [{ time: 400, textContent: 'kept' }]);
  assert.equal(h.requests.length, 2);
});

test('XML failure returns an empty list and the public XML request omits credentials', async () => {
  const h = harness({ fetchImpl: async url => {
    if (new URL(url).hostname === 'api.bilibili.com') return { ok: false, status: 412 };
    throw new Error('XML network failure');
  } });
  assert.deepEqual(plain(await h.context.fetchDanmakuWithTime(101, 600)), []);
  const xml = h.requests.filter(request => request.url.endsWith('.xml'));
  assert.equal(xml.length, 1);
  assert.equal(xml[0].options.credentials, 'omit');
});

for (const sourceName of ['chapters', 'description']) {
  test(`${sourceName} detection still succeeds when both danmaku sources fail`, async () => {
    const h = harness({ video: sample({ desc: sourceName === 'description'
      ? '00:00 正片\n01:30 广告\n02:00 正片' : '' }), fetchImpl: async url => {
      if (url.includes('/x/player/')) return jsonResponse({ code: 0, data: {
        view_points: sourceName === 'chapters' ? [{ from: 90, to: 120, content: '广告' }] : [],
        subtitle: { subtitles: [] }
      } });
      if (url.includes('/x/v2/dm/')) return { ok: false, status: 412 };
      throw new Error('XML unavailable');
    } });
    for (const file of ['constants.js', 'utils.js', 'detectors.js', 'content.js']) {
      vm.runInContext(source(file), h.context);
    }
    const inputs = {};
    const result = await h.context.getSkipSegment(inputs);
    assert.equal(result.source, sourceName);
    assert.equal(result.start, 90);
    assert.equal(result.end, 120);
    assert.equal(result.requiresConfirmation, false);
    assert.deepEqual(plain(inputs.danmaku), []);
    assert.equal(inputs.cid, 101);
  });
}

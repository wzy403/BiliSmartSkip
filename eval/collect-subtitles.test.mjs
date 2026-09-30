import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuthenticatedRequester, runCollection } from './collect-subtitles.mjs';

const seed = cid => ({
  bvid: 'BV1Qy411v7VK', cid, duration: 671, title: '测试', creator: { mid: 42 },
  subtitles: [], chapters: [], danmaku: [{ time: 1, textContent: '保留弹幕' }],
  annotations: { status: 'unreviewed', segments: [] },
  references: [{ source: 'community', segments: [{ start: 288, end: 317 }] }],
  acquisition: { metadata: 'available', danmaku: 'available', subtitles: 'unavailable' }
});
const lines = [{ from: 2, to: 3, content: '正文' }];
const player = cid => ({ code: 0, data: { cid, bvid: 'BV1Qy411v7VK',
  accountInfo: 'must-not-export', view_points: [{ from: 288, to: 317, content: '广告' }],
  subtitle: { subtitles: [{ lan: 'ai-zh', type: 1,
    subtitle_url: `https://aisubtitle.hdslb.com/${cid}.json?signature=secret` }] } } });
const fakeRequest = async url => new URL(url).hostname === 'api.bilibili.com'
  ? player(Number(new URL(url).searchParams.get('cid'))) : { body: lines };

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bilismartskip-subtitles-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'corpus.jsonl');
}
const readOutput = async output => (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);

test('100-record corpus retains all 9 public failures without requests or field loss', async t => {
  const output = await temporary(t), records = Array.from({ length: 100 }, (_, i) => seed(i + 1));
  for (const record of records.slice(91)) Object.assign(record.acquisition, { metadata: 'failed', danmaku: 'failed', error: 'public-failure' });
  const before = structuredClone(records), progress = [];
  let calls = 0;
  const result = await runCollection(records, { outputPath: output,
    request: async (...args) => { calls++; return fakeRequest(...args); }, onProgress: item => progress.push(item) });
  assert.equal(calls, 182);
  assert.equal(result.summary.attempted, 91);
  assert.equal(result.summary.skippedFailed, 9);
  assert.equal(result.summary.processed, 100);
  assert.equal(result.records.length, 100);
  assert.deepEqual(records, before);
  assert.deepEqual(result.records.slice(91), before.slice(91));
  const exported = await readOutput(output);
  assert.deepEqual(exported, result.records);
  for (let i = 0; i < 91; i++) {
    for (const key of ['creator', 'danmaku', 'annotations', 'references']) assert.deepEqual(exported[i][key], before[i][key]);
    assert.deepEqual(exported[i].subtitles, lines);
    assert.equal(exported[i].acquisition.metadata, 'available');
    assert.equal(exported[i].acquisition.subtitleMethod, 'cli-legacy-player-api');
  }
  const files = await fs.readdir(`${output}.checkpoints`);
  assert.equal(files.length, 91);
  const checkpoint = await fs.readFile(path.join(`${output}.checkpoints`, files[0]), 'utf8');
  assert.doesNotMatch(checkpoint, /secret|signature|accountInfo|must-not-export|danmaku|annotations|references/);
  assert.doesNotMatch(JSON.stringify(progress), /secret|signature|https:|Cookie/);
});

test('pause preserves all records and resume merges only enrichment over latest input labels', async t => {
  const output = await temporary(t), records = [seed(1), seed(2), seed(3)];
  let calls = 0;
  const first = await runCollection(records, { outputPath: output, request: async (...args) => {
    calls++; return calls === 3 ? { code: -352 } : fakeRequest(...args);
  } });
  assert.equal(calls, 3); assert.equal(first.summary.paused, true); assert.equal(first.summary.nextIndex, 1);
  assert.equal((await readOutput(output)).length, 3);
  assert.deepEqual(first.records[2], records[2]);
  const updatedInput = structuredClone(records);
  updatedInput[0].annotations = { status: 'reviewed', segments: [], reviewedRanges: [{ start: 0, end: 20 }] };
  updatedInput[0].references.push({ source: 'new-reference' });
  let resumedCalls = 0;
  const second = await runCollection(updatedInput, { outputPath: output, request: async (...args) => {
    resumedCalls++; return fakeRequest(...args);
  } });
  assert.equal(resumedCalls, 4); assert.equal(second.summary.resumed, 1); assert.equal(second.summary.paused, false);
  assert.deepEqual(second.records[0].annotations, updatedInput[0].annotations);
  assert.deepEqual(second.records[0].references, updatedInput[0].references);
  assert.deepEqual(second.records.map(record => record.subtitles), [lines, lines, lines]);
});

test('pre-aborted resume still restores all later checkpoints into full export', async t => {
  const output = await temporary(t), records = [seed(1), seed(2), seed(3)];
  await runCollection(records, { outputPath: output, request: fakeRequest });
  const controller = new AbortController(); controller.abort();
  const result = await runCollection(records, { outputPath: output, signal: controller.signal,
    request: () => assert.fail('cancelled run must not request') });
  assert.equal(result.summary.cancelled, true);
  assert.deepEqual((await readOutput(output)).map(record => record.subtitles), [lines, lines, lines]);
});

test('in-flight cancellation checkpoints the failed attempt and retains untouched records', async t => {
  const output = await temporary(t), controller = new AbortController();
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const pending = runCollection([seed(1), seed(2)], { outputPath: output, signal: controller.signal,
    request: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      began();
    }) });
  await started; controller.abort();
  const result = await pending;
  assert.equal(result.summary.cancelled, true);
  assert.equal(result.records[0].acquisition.subtitleReason, 'cancelled');
  assert.deepEqual(result.records[1], seed(2));
  assert.equal((await fs.readdir(`${output}.checkpoints`)).length, 1);
});

test('existing subtitles never request and cached empty results can be explicitly retried', async t => {
  const output = await temporary(t), existing = { ...seed(1), subtitles: lines };
  let calls = 0;
  const request = async url => { calls++; return { code: 0, data: { cid: 2, subtitle: { subtitles: [] } } }; };
  const first = await runCollection([existing, seed(2)], { outputPath: output, request });
  assert.equal(calls, 1); assert.deepEqual(first.records[0], existing);
  await runCollection([existing, seed(2)], { outputPath: output, request: () => assert.fail('use completed cache') });
  const retried = await runCollection([existing, seed(2)], { outputPath: output, request: fakeRequest, retryUnavailable: true });
  assert.equal(retried.summary.attempted, 1);
  assert.deepEqual(retried.records[1].subtitles, lines);
});

test('in-memory auth reaches only fixed HTTPS player API, never subtitle hosts or redirects', async () => {
  const calls = [], cookieHeader = 'SESSDATA=in-memory-secret';
  const request = createAuthenticatedRequester({ cookieHeader, intervalMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({}) };
  } });
  await request('https://api.bilibili.com/x/player/wbi/v2?bvid=BV1Qy411v7VK&cid=1');
  await request('https://aisubtitle.hdslb.com/public.json?signature=secret');
  assert.equal(calls[0].options.headers.Cookie, cookieHeader);
  assert.equal(calls[0].options.headers['User-Agent'], 'BiliSmartSkip-Eval/0.1');
  assert.equal(calls[1].options.headers.Cookie, undefined);
  assert.equal(calls[1].options.credentials, 'omit');
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  for (const url of ['https://example.com/a', 'http://api.bilibili.com/x/player/wbi/v2',
    'https://api.bilibili.com/other', 'https://evil:secret@api.bilibili.com/x/player/wbi/v2']) {
    await assert.rejects(request(url));
  }
  assert.equal(calls.length, 2);
  assert.throws(() => createAuthenticatedRequester({ cookieHeader: 'bad\r\nsecret' }), /Invalid/);
});

test('HTTP access limits stop the full batch and do not expose thrown network messages', async t => {
  for (const code of [401, 403, 412, 429]) {
    const output = await temporary(t);
    let calls = 0;
    const request = createAuthenticatedRequester({ cookieHeader: 'SESSDATA=secret', intervalMs: 0,
      fetchImpl: async () => { calls++; return { ok: false, status: code }; } });
    const result = await runCollection([seed(1), seed(2)], { outputPath: output, request });
    assert.equal(calls, 1); assert.equal(result.summary.paused, true);
    assert.deepEqual(result.records[1], seed(2));
    assert.doesNotMatch(await fs.readFile(output, 'utf8'), /SESSDATA|secret/);
  }
  const output = await temporary(t);
  const request = createAuthenticatedRequester({ cookieHeader: 'SESSDATA=secret', intervalMs: 0,
    fetchImpl: async () => { throw new Error('https://private?signature=secret SESSDATA=secret'); } });
  await runCollection([seed(1)], { outputPath: output, request });
  assert.doesNotMatch(await fs.readFile(output, 'utf8'), /SESSDATA|signature|secret/);
});

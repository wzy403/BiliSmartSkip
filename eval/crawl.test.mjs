import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main, parseArguments } from './crawl.mjs';

test('crawler requires separate input/output and rejects unknown options', () => {
  assert.throws(() => parseArguments(['--input', 'a', '--out', 'a']), /must-differ/);
  assert.throws(() => parseArguments(['--input', 'a', '--cookie', 'secret']), /invalid/);
  assert.equal(parseArguments(['--input', 'a', '--out', 'b', '--retry-unavailable']).retryUnavailable, true);
});

test('login refusal pauses the whole corpus after one attempt and retains pending records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bili-crawl-test-'));
  const input = path.join(directory, 'input.jsonl'), output = path.join(directory, 'output.jsonl');
  const records = [1, 2].map(cid => ({ bvid: 'BV1a5N4zxEQe', cid, duration: 600,
    subtitles: [], chapters: [], danmaku: [], annotations: { status: 'unreviewed', segments: [] },
    acquisition: { metadata: 'available', danmaku: 'available', subtitles: 'unavailable' } }));
  await writeFile(input, records.map(JSON.stringify).join('\n'));
  const originalFetch = globalThis.fetch, originalLog = console.log, exitCode = process.exitCode;
  let calls = 0;
  const logs = [];
  globalThis.fetch = async () => { calls++; return { ok: false, status: 412 }; };
  console.log = value => logs.push(value);
  try {
    const result = await main(['--input', input, '--out', output]);
    assert.equal(calls, 1);
    assert.equal(result.summary.paused, true);
    assert.equal(result.summary.attempted, 1);
    const saved = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].acquisition.subtitleReason, 'login-http-412');
    assert.deepEqual(saved[1], records[1]);
    assert.doesNotMatch(logs.join('\n'), /Cookie|SESSDATA|qrcode_key/);
  } finally {
    globalThis.fetch = originalFetch; console.log = originalLog; process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

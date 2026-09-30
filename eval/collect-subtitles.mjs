#!/usr/bin/env node
// No browser/cookie-file access. Parent code may supply an authenticated requester in memory.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  CollectionError, createRequester, enrichRecord, parseCorpus, subtitleURL, toJSONL, validateRecord
} from './acquisition.mjs';

const API_ORIGIN = 'https://api.bilibili.com';
const API_PATH = '/x/player/wbi/v2';
const ACQUISITION_FIELDS = ['subtitles', 'subtitleReason', 'subtitleFetchedAt', 'subtitleMethod',
  'subtitleLanguage', 'subtitleSource', 'chapters', 'chaptersFetchedAt'];
const COMPLETE = new Set(['available', 'empty', 'unsupported']);

/** Cookie remains in this closure, is never returned, and is only sent to the fixed player API. */
export function createAuthenticatedRequester({ cookieHeader = '', fetchImpl = globalThis.fetch,
  intervalMs = 1500, timeoutMs = 20000 } = {}) {
  if (typeof cookieHeader !== 'string' || /[\r\n\0]/.test(cookieHeader)) throw new Error('Invalid in-memory authentication header');
  return createRequester({ intervalMs, timeoutMs, fetchImpl: (value, options) => {
    let url;
    try { url = new URL(value); }
    catch { throw new CollectionError('unsupported-request-url', { status: 'unsupported' }); }
    const api = url.origin === API_ORIGIN && url.pathname === API_PATH && !url.username && !url.password;
    if (!api) subtitleURL(url.href); // Throws before fetch for any other API/host/protocol.
    const headers = { Accept: 'application/json', Referer: 'https://www.bilibili.com/', 'User-Agent': 'BiliSmartSkip-Eval/0.1' };
    if (api && cookieHeader) headers.Cookie = cookieHeader;
    return fetchImpl(url.href, { ...options, credentials: api ? 'include' : 'omit', headers, redirect: 'error' });
  } });
}

const identity = record => `${record.bvid}:${record.cid}`;
const failedPublicRecord = record => ['failed', 'error'].includes(record.acquisition?.metadata)
  || ['failed', 'error'].includes(record.acquisition?.danmaku);

async function atomicWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

function checkpointOf(record) {
  return {
    schemaVersion: 1, bvid: record.bvid, cid: record.cid,
    subtitles: record.subtitles || [],
    ...(Array.isArray(record.chapters) ? { chapters: record.chapters } : {}),
    acquisition: Object.fromEntries(ACQUISITION_FIELDS.filter(key => Object.hasOwn(record.acquisition || {}, key))
      .map(key => [key, record.acquisition[key]]))
  };
}

async function readCheckpoint(filename, record) {
  let text;
  try { text = await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let cached;
  try { cached = JSON.parse(text); }
  catch { throw new Error(`Invalid checkpoint JSON for ${identity(record)}`); }
  if (cached.schemaVersion !== 1 || identity(cached) !== identity(record)
    || !Array.isArray(cached.subtitles) || !cached.acquisition
    || !['available', 'empty', 'login-required', 'error', 'unsupported'].includes(cached.acquisition.subtitles)) {
    throw new Error(`Invalid checkpoint schema for ${identity(record)}`);
  }
  return cached;
}

function applyCheckpoint(record, cached) {
  return {
    ...record, subtitles: cached.subtitles,
    ...(Array.isArray(cached.chapters) ? { chapters: cached.chapters } : {}),
    acquisition: { ...record.acquisition,
      ...Object.fromEntries(ACQUISITION_FIELDS.filter(key => Object.hasOwn(cached.acquisition, key))
        .map(key => [key, cached.acquisition[key]])) }
  };
}

/**
 * Checkpoints are small per-record enrichment files in `${outputPath}.checkpoints/`.
 * Output is the complete input corpus, atomically written on completion/pause/error.
 * Resume never replaces input annotations/references/creator/danmaku with cached copies.
 * Set retryUnavailable to retry cached empty/unsupported responses after conditions change.
 */
export async function runCollection(records, { request = createAuthenticatedRequester(), outputPath,
  signal, onProgress = () => {}, retryUnavailable = false } = {}) {
  if (!Array.isArray(records) || !records.length) throw new Error('Provide a nonempty corpus array');
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('Provide outputPath');
  const seen = new Set();
  for (const record of records) {
    validateRecord(record);
    if (seen.has(identity(record))) throw new Error(`Duplicate BV/CID: ${identity(record)}`);
    seen.add(identity(record));
  }
  const output = path.resolve(outputPath), cacheDir = `${output}.checkpoints`;
  const enriched = structuredClone(records);
  const summary = { total: records.length, processed: 0, attempted: 0, skippedExisting: 0,
    skippedFailed: 0, resumed: 0, paused: false, cancelled: false, nextIndex: 0 };
  const emit = (record, status, reason) => onProgress({
    ...summary, bvid: record.bvid, cid: record.cid, status, reason
  });
  // Restore all cached enrichment before starting: pausing early must not remove later
  // completed records from a previous run's full export.
  const cachedByIndex = new Map();
  for (let index = 0; index < enriched.length; index++) {
    const record = enriched[index];
    if (failedPublicRecord(record) || record.subtitles?.length) continue;
    const cached = await readCheckpoint(path.join(cacheDir, `${record.bvid}-${record.cid}.json`), record);
    if (cached) {
      cachedByIndex.set(index, cached);
      enriched[index] = applyCheckpoint(record, cached);
    }
  }
  // Establish an export containing every input record before the first request.
  await atomicWrite(output, toJSONL(enriched));
  try {
    for (let index = 0; index < enriched.length; index++) {
      summary.nextIndex = index;
      if (signal?.aborted) { summary.cancelled = true; summary.paused = true; break; }
      let record = enriched[index];
      if (failedPublicRecord(record)) {
        summary.skippedFailed++; summary.processed++; summary.nextIndex = index + 1;
        await emit(record, 'skipped', 'public-acquisition-failed');
        continue;
      }
      if (records[index].subtitles?.length) {
        summary.skippedExisting++; summary.processed++; summary.nextIndex = index + 1;
        await emit(record, 'available', 'existing-subtitles');
        continue;
      }
      const cacheFile = path.join(cacheDir, `${record.bvid}-${record.cid}.json`);
      const cached = cachedByIndex.get(index);
      if (cached) {
        if (COMPLETE.has(cached.acquisition.subtitles)
          && !(retryUnavailable && cached.acquisition.subtitles !== 'available')) {
          summary.resumed++; summary.processed++; summary.nextIndex = index + 1;
          await emit(record, cached.acquisition.subtitles, 'checkpoint');
          continue;
        }
      }
      summary.attempted++;
      const result = await enrichRecord(record, { request, signal });
      result.record.acquisition.subtitleMethod = 'cli-legacy-player-api';
      enriched[index] = result.record;
      await atomicWrite(cacheFile, JSON.stringify(checkpointOf(result.record)) + '\n');
      if (result.pause || signal?.aborted) {
        summary.paused = true;
        summary.cancelled = !!signal?.aborted || result.reason === 'cancelled';
        await emit(result.record, result.status, result.reason);
        break;
      }
      summary.processed++; summary.nextIndex = index + 1;
      await emit(result.record, result.status, result.reason);
    }
  } finally {
    // Includes untouched/failed/pending records even when a request or progress callback aborts.
    await atomicWrite(output, toJSONL(enriched));
  }
  return { records: enriched, summary };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('node eval/collect-subtitles.mjs --input corpus.jsonl --out enriched.jsonl\nAuthentication is supplied in memory by a parent script via createAuthenticatedRequester({cookieHeader}). No browser or cookie-file access.');
      return;
    }
    if (!['--input', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Expected --input <corpus.jsonl> --out <enriched.jsonl>');
    }
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.input || !options.out) throw new Error('Expected --input <corpus.jsonl> --out <enriched.jsonl>');
  const records = parseCorpus(await fs.readFile(options.input, 'utf8'));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const result = await runCollection(records, { outputPath: options.out, signal: controller.signal,
      onProgress: progress => console.log(JSON.stringify(progress)) });
    console.log(JSON.stringify(result.summary));
    if (result.summary.paused) process.exitCode = result.summary.cancelled ? 130 : 2;
    return result;
  } finally { process.removeListener('SIGINT', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

const SUBTITLE_HOSTS = new Set(['aisubtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com']);

export function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !/^BV[\da-zA-Z]{10}$/.test(record.bvid || '')) {
    throw new Error('记录必须包含有效的 BV 号。');
  }
  const cid = record.cid;
  if (!((typeof cid === 'number' && Number.isSafeInteger(cid) && cid > 0)
    || (typeof cid === 'string' && /^[1-9]\d*$/.test(cid)
      && Number.isSafeInteger(Number(cid))))) {
    throw new Error(`${record.bvid} 的 CID 必须是正整数。`);
  }
  for (const field of ['subtitles', 'chapters', 'danmaku']) {
    if (record[field] != null && !Array.isArray(record[field])) {
      throw new Error(`${record.bvid} 的 ${field} 必须是数组。`);
    }
  }
  if (record.acquisition != null && (typeof record.acquisition !== 'object'
    || Array.isArray(record.acquisition))) throw new Error(`${record.bvid} 的 acquisition 必须是对象。`);
  return record;
}

export function parseCorpus(text) {
  if (!text.trim()) throw new Error('文件为空。');
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* Multiple JSONL records are parsed below. */ }
  let records;
  if (Array.isArray(parsed)) records = parsed;
  else if (Array.isArray(parsed?.videos)) records = parsed.videos;
  else if (parsed) records = [parsed];
  else records = text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { throw new Error(`第 ${index + 1} 行不是有效 JSON。`); }
  });
  if (!records.length) throw new Error('没有可采集的记录。');
  const seen = new Set();
  records.forEach(record => {
    validateRecord(record);
    const key = `${record.bvid}:${record.cid}`;
    if (seen.has(key)) throw new Error(`重复的 BV/CID：${key}。请先合并去重。`);
    seen.add(key);
  });
  return records;
}

export function toJSONL(records) {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

export class CollectionError extends Error {
  constructor(reason, { status = 'error', pause = false } = {}) {
    super(reason);
    this.status = status;
    this.pause = pause;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function wait(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// The queue calls this serially. Every request, including subtitle bodies, is spaced.
// Fetch errors are reduced to fixed codes: URLs and credentials never enter exports.
export function createRequester({ fetchImpl = globalThis.fetch, intervalMs = 1500, timeoutMs = 20000 } = {}) {
  let lastRequest = null;
  return async (url, { signal, credentials = 'omit' } = {}) => {
    throwIfAborted(signal);
    if (lastRequest !== null) await wait(Math.max(0, intervalMs - (Date.now() - lastRequest)), signal);
    throwIfAborted(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    lastRequest = Date.now();
    try {
      const response = await fetchImpl(url, { signal: controller.signal, credentials, redirect: 'error' });
      if (!response.ok) {
        throw new CollectionError(`http-${response.status}`, {
          status: response.status === 401 ? 'login-required' : 'error',
          pause: [401, 403, 412, 429].includes(response.status)
        });
      }
      try { return await response.json(); }
      catch (error) {
        throwIfAborted(signal);
        if (timedOut) throw new CollectionError('request-timeout');
        throw new CollectionError('non-json-response', { status: 'unsupported' });
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof CollectionError) throw error;
      throw new CollectionError(timedOut ? 'request-timeout' : 'network-error');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

export function subtitleURL(value) {
  let url;
  try { url = new URL(value?.startsWith('//') ? `https:${value}` : value); }
  catch { throw new CollectionError('missing-or-invalid-subtitle-url', { status: 'unsupported' }); }
  if (url.protocol !== 'https:' || !SUBTITLE_HOSTS.has(url.hostname)
    || url.port || url.username || url.password) {
    throw new CollectionError('unsupported-subtitle-host', { status: 'unsupported' });
  }
  return url.href;
}

function validLines(lines) {
  return Array.isArray(lines) && lines.every(line => line && Number.isFinite(line.from)
    && Number.isFinite(line.to) && line.from >= 0 && line.to > line.from && typeof line.content === 'string');
}

export async function enrichRecord(record, { request, signal, now = () => new Date().toISOString() }) {
  validateRecord(record);
  // Existing transcripts are retained without a request; failed refreshes cannot destroy them.
  if (record.subtitles?.length) return { record, status: 'available', reason: 'existing-subtitles', pause: false };
  const next = { ...record, acquisition: { ...record.acquisition } };
  const finish = (status, reason, pause = false) => {
    Object.assign(next.acquisition, {
      subtitles: status, subtitleReason: reason,
      subtitleFetchedAt: now(), subtitleMethod: 'extension-legacy-player-api'
    });
    return { record: next, status, reason, pause };
  };
  try {
    throwIfAborted(signal);
    const url = new URL('https://api.bilibili.com/x/player/wbi/v2');
    url.searchParams.set('bvid', record.bvid);
    url.searchParams.set('cid', String(record.cid));
    const player = await request(url.href, { credentials: 'include', signal });
    if (player?.code === -352) return finish('error', 'risk-control--352', true);
    if (player?.code === -101) return finish('login-required', 'api-login-required', true);
    if (player?.code !== 0 || !player.data || typeof player.data !== 'object') {
      return finish(typeof player?.code === 'number' ? 'error' : 'unsupported',
        typeof player?.code === 'number' ? `api-code-${player.code}` : 'missing-player-schema');
    }
    const data = player.data;
    if ((data.cid != null && String(data.cid) !== String(record.cid))
      || (data.bvid != null && data.bvid !== record.bvid)) return finish('error', 'player-identity-mismatch');
    if (Array.isArray(data.view_points) && validLines(data.view_points)) {
      next.chapters = data.view_points.map(({ from, to, content }) => ({ from, to, content }));
      next.acquisition.chapters = next.chapters.length ? 'available' : 'empty';
      next.acquisition.chaptersFetchedAt = now();
    }
    if (data.need_login_subtitle) return finish('login-required', 'need-login-subtitle', true);
    const tracks = data.subtitle?.subtitles;
    if (!Array.isArray(tracks)) return finish('unsupported', 'missing-subtitle-track-schema');
    if (!tracks.length) return finish('empty', 'legacy-api-no-tracks-not-proof-of-no-subtitles');
    // Match content.js: use the first Chinese track in API order, then the first track.
    const track = tracks.find(t => t?.lan === 'zh-CN' || t?.lan === 'ai-zh') || tracks[0];
    const body = await request(subtitleURL(track?.subtitle_url), { credentials: 'omit', signal });
    if (!validLines(body?.body)) return finish('unsupported', 'invalid-subtitle-body');
    next.subtitles = body.body.map(({ from, to, content }) => ({ from, to, content }));
    next.acquisition.subtitleLanguage = typeof track.lan === 'string' ? track.lan : 'unknown';
    next.acquisition.subtitleSource = track.type === 1 || (typeof track.lan === 'string' && track.lan.startsWith('ai-')) ? 'ai'
      : track.type === 0 ? 'human' : 'unknown';
    return finish(next.subtitles.length ? 'available' : 'empty', next.subtitles.length ? null : 'empty-subtitle-body');
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') return finish('error', 'cancelled', true);
    if (error instanceof CollectionError) return finish(error.status, error.message, error.pause);
    return finish('error', 'unexpected-collection-error');
  }
}

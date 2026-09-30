#!/usr/bin/env node
// Public, anonymous corpus collector. Never reads browser cookies or stores page HTML.
const fs = require('node:fs/promises');
const path = require('node:path');

function initialState(html) {
  const marker = 'window.__INITIAL_STATE__=';
  let start = html.indexOf(marker);
  if (start < 0) throw new Error('Video metadata not present in public page');
  start = html.indexOf('{', start + marker.length);
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('Incomplete video metadata');
}

function decodeXml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] !== '#') return named[entity];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function parseDanmaku(xml) {
  if (!/<i[>\s]/.test(xml)) throw new Error('Response is not danmaku XML');
  return [...xml.matchAll(/<d\s+[^>]*p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g)]
    .map(([, params, content]) => ({
      time: Number(params.split(',')[0]),
      textContent: content.startsWith('<![CDATA[') ? content.slice(9, -3) : decodeXml(content)
    }))
    .filter(d => Number.isFinite(d.time))
    .sort((a, b) => a.time - b.time);
}

async function collect(seeds, output, { limit = 100, delay = 1200 } = {}) {
  await fs.mkdir(output, { recursive: true });
  const summary = { attempted: 0, cached: 0, collected: 0, failed: [], stopped: false };
  let lastRequest = 0;
  const request = async url => {
    const wait = delay - (Date.now() - lastRequest);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequest = Date.now();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'BiliSmartSkip-public-evaluation/1.0', Referer: 'https://www.bilibili.com/' }
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.stop = [401, 403, 412, 429].includes(response.status);
      throw error;
    }
    return response.text();
  };

  for (const seed of seeds.slice(0, limit)) {
    if (!/^BV[\da-zA-Z]{10}$/.test(seed.bvid)) throw new Error(`Invalid bvid: ${seed.bvid}`);
    const filename = path.join(output, `${seed.bvid}.json`);
    try { await fs.access(filename); summary.cached++; continue; } catch {}
    summary.attempted++;
    const item = {
      bvid: seed.bvid, cid: seed.cid ? Number(seed.cid) : null, title: seed.title || '',
      creator: seed.creator || null, category: seed.category || 'unknown',
      duration: seed.duration || seed.videoDuration || 0, desc: '',
      chapters: [], subtitles: [], danmaku: [],
      annotations: { status: 'unreviewed', segments: [] },
      references: seed.references || [{
        source: 'BilibiliSponsorBlock', sourceUrl: seed.source,
        collectedAt: new Date().toISOString(),
        segments: (seed.communityRows || []).filter(row =>
          String(row.cid) === String(seed.cid) && row.actionType === 'skip' &&
          !row.hidden && !row.shadowHidden && (row.votes >= 3 || row.locked))
          .map(row => ({start: row.segment[0], end: row.segment[1], category: row.category,
            votes: row.votes, locked: !!row.locked, uuid: row.UUID}))
      }],
      sampling: { stratum: seed.samplingStratum, group: seed.samplingGroup },
      acquisition: {
        capturedAt: new Date().toISOString(), method: 'anonymous-public-page-and-xml',
        metadata: 'pending', danmaku: 'pending', chapters: 'unavailable',
        subtitles: 'unavailable', subtitleReason: 'not-exposed-in-public-page'
      }
    };
    try {
      const state = initialState(await request(`https://www.bilibili.com/video/${seed.bvid}/`));
      const video = state.videoData;
      if (!video || video.bvid !== seed.bvid) throw new Error('Unexpected or missing video identity');
      // Only collect the requested part. Do not attach one part's annotations to another CID.
      const page = seed.cid ? video.pages?.find(p => String(p.cid) === String(seed.cid)) : video.pages?.[0];
      if (seed.cid && !page) throw new Error('Reference CID not present in this video');
      Object.assign(item, {
        cid: page?.cid || video.cid, page: page?.page || 1, title: video.title, desc: video.desc || '',
        duration: page?.duration || video.duration,
        creator: { mid: video.owner?.mid || seed.creator || `unknown:${seed.bvid}`, name: video.owner?.name || '' },
        category: video.tname_v2 || video.tname || item.category
      });
      if (seed.videoDuration && Math.abs(item.duration - seed.videoDuration) > 2) {
        item.acquisition.referenceWarning = 'Video duration changed; references excluded from agreement scoring';
        item.unusableReferences = item.references;
        item.references = [];
      }
      item.acquisition.metadata = 'available';
      const xml = await request(`https://comment.bilibili.com/${item.cid}.xml`);
      item.danmaku = parseDanmaku(xml);
      item.acquisition.danmaku = 'available';
      // Empty public subtitle lists mean unavailable to this collector, never "no subtitles".
      const tracks = video.subtitle?.list || [];
      const track = tracks.find(t => ['zh-CN', 'ai-zh'].includes(t.lan));
      if (track?.subtitle_url) {
        const url = new URL(track.subtitle_url, 'https://www.bilibili.com');
        if (url.protocol !== 'https:' || !/^(?:aisubtitle|i0|i1)\.hdslb\.com$/.test(url.hostname)) {
          throw new Error('Unexpected subtitle host; left unavailable');
        }
        const subtitles = JSON.parse(await request(url.href));
        if (!Array.isArray(subtitles.body)) throw new Error('Subtitle body missing');
        item.subtitles = subtitles.body.map(({from, to, content}) => ({from, to, content}));
        item.acquisition.subtitles = 'available';
        item.acquisition.subtitleReason = null;
      }
      summary.collected++;
    } catch (error) {
      item.acquisition.error = error.message;
      if (item.acquisition.metadata === 'pending') item.acquisition.metadata = 'failed';
      if (item.acquisition.danmaku === 'pending') item.acquisition.danmaku = 'failed';
      summary.failed.push({ bvid: seed.bvid, error: error.message });
      summary.stopped = !!error.stop;
    }
    await fs.writeFile(filename, JSON.stringify(item, null, 2) + '\n');
    if (summary.attempted % 10 === 0 || summary.stopped) console.log(JSON.stringify(summary));
    // Respect access restrictions/rate limits; do not retry through alternative endpoints.
    if (summary.stopped) break;
  }
  await fs.writeFile(path.join(output, 'collection-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (require.main === module) {
  const [seedFile, output, limit = '100'] = process.argv.slice(2);
  if (!seedFile || !output) {
    console.error('Usage: node eval/collect-public.cjs seeds.json output-directory [limit=100]');
    process.exitCode = 1;
  } else {
    fs.readFile(seedFile, 'utf8').then(JSON.parse).then(data => collect(Array.isArray(data) ? data : data.seeds || data.videos, output, {limit:Number(limit)}))
      .then(summary => console.log(JSON.stringify(summary, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { initialState, parseDanmaku, collect };

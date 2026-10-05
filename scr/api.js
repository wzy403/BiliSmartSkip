// == BiliSmartSkip: API & Data Fetching ==

function getBvidFromPage() {
  return window.location.pathname.match(/^\/video\/(BV[\da-zA-Z]+)(?:\/|$)/)?.[1] || null;
}

function getVideoPage() {
  const page = Number(new URLSearchParams(window.location.search).get('p') || 1);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

// Read only public video metadata through a packaged page script. Content scripts
// cannot access the site's JS globals, and Bilibili may remove its hydration script.
function readPageVideoInfo(bvid) {
  return new Promise(resolve => {
    const script = document.createElement('script');
    let timer;
    const finish = data => {
      clearTimeout(timer);
      script.remove();
      resolve(data);
    };
    script.dataset.bvid = bvid;
    script.onload = () => {
      try {
        finish(JSON.parse(script.dataset.videoInfo || 'null'));
      } catch (_) {
        finish(null);
      }
    };
    script.onerror = () => finish(null);
    timer = setTimeout(() => finish(null), 1500);
    try {
      script.src = chrome.runtime.getURL('scr/page-data.js');
      (document.head || document.documentElement).appendChild(script);
    } catch (_) {
      finish(null);
    }
  });
}

function normalizeVideoInfo(data, bvid, pageNumber) {
  if (!data || data.bvid !== bvid) return null;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const page = pages.find(item => Number(item.page) === pageNumber);
  // Never reuse P1's CID or the total duration for another part.
  if (!page && (pages.length || pageNumber !== 1)) return null;
  const cid = Number(page ? page.cid : data.cid);
  if (!Number.isSafeInteger(cid) || cid <= 0) return null;
  const duration = Number(page ? page.duration : data.duration);
  const aid = Number(data.aid);
  return {
    cid,
    ...(Number.isSafeInteger(aid) && aid > 0 ? { aid } : {}),
    title: typeof data.title === 'string' ? data.title : '',
    desc: typeof data.desc === 'string' ? data.desc : '',
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0
  };
}

// Time out both the request and its body. Report HTTP errors before trying to
// parse a risk-control HTML response as JSON/protobuf/XML; do not retry 412s.
async function fetchBiliData(url, bodyType = 'json', credentials = 'include', timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials, signal: controller.signal });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} (${new URL(url).pathname})`);
      error.status = res.status;
      throw error;
    }
    return await res[bodyType]();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVideoInfo(bvid, pageNumber = getVideoPage()) {
  const pageInfo = normalizeVideoInfo(await readPageVideoInfo(bvid), bvid, pageNumber);
  if (pageInfo) {
    log('video metadata: page', { bvid, page: pageNumber, cid: pageInfo.cid });
    return pageInfo;
  }
  try {
    const json = await fetchBiliData(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    if (json.code !== 0) throw new Error(`Video API code ${json.code}`);
    return normalizeVideoInfo(json.data, bvid, pageNumber);
  } catch (e) {
    console.warn('fetchVideoInfo failed:', e);
    return null;
  }
}

async function fetchPlayerInfo(bvid, cid) {
  try {
    const json = await fetchBiliData(
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`
    );
    if (json.code !== 0 || !json.data) throw new Error(`Player API code ${json.code}`);
    return {
      viewPoints: Array.isArray(json.data.view_points) ? json.data.view_points : [],
      subtitles: Array.isArray(json.data.subtitle?.subtitles) ? json.data.subtitle.subtitles : []
    };
  } catch (e) {
    console.warn('fetchPlayerInfo failed:', e);
    return { viewPoints: [], subtitles: [] };
  }
}

async function fetchSubtitleBody(subtitleUrl) {
  try {
    const url = subtitleUrl.startsWith('//') ? 'https:' + subtitleUrl : subtitleUrl;
    const json = await fetchBiliData(url, 'json', 'omit');
    return Array.isArray(json.body) ? json.body : [];
  } catch (e) {
    console.warn('fetchSubtitleBody failed:', e);
    return [];
  }
}

async function fetchVideoHeatmap(bvid, aid, cid) {
  if (!/^BV[\da-zA-Z]+$/.test(bvid) || !Number.isSafeInteger(aid) || aid <= 0
    || !Number.isSafeInteger(cid) || cid <= 0) return null;
  try {
    // Optional public corroboration. Keep its latency bounded and omit cookies;
    // an unavailable curve must not remove an otherwise detected ad.
    return await fetchBiliData(`https://bvc.bilivideo.com/pbp/data?aid=${aid}&cid=${cid}&bvid=${encodeURIComponent(bvid)}&r=loader`,
      'json', 'omit', 1500);
  } catch (error) {
    log('heatmap unavailable:', String(error));
    return null;
  }
}

// === Protobuf danmaku decoder (no external dependency) ===

function decodeDanmakuProto(buffer) {
  const view = new DataView(buffer);
  const results = [];
  let offset = 0;

  function readVarint() {
    let result = 0, shift = 0;
    while (offset < view.byteLength) {
      const byte = view.getUint8(offset++);
      result |= (byte & 0x7F) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    return result;
  }

  function readBytes() {
    const len = readVarint();
    const bytes = new Uint8Array(buffer, offset, len);
    offset += len;
    return bytes;
  }

  function decodeDanmakuElem(elemBuffer) {
    const elem = { progress: 0, content: '' };
    const elemView = new DataView(elemBuffer.buffer, elemBuffer.byteOffset, elemBuffer.byteLength);
    let pos = 0;

    function readElemVarint() {
      let result = 0, shift = 0;
      while (pos < elemBuffer.byteLength) {
        const byte = elemView.getUint8(pos++);
        result |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) return result;
        shift += 7;
      }
      return result;
    }

    while (pos < elemBuffer.byteLength) {
      const tag = readElemVarint();
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x7;

      if (wireType === 0) {
        const val = readElemVarint();
        if (fieldNum === 2) elem.progress = val;
      } else if (wireType === 2) {
        const len = readElemVarint();
        if (fieldNum === 7) {
          elem.content = new TextDecoder().decode(
            new Uint8Array(elemBuffer.buffer, elemBuffer.byteOffset + pos, len)
          );
        }
        pos += len;
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 1) {
        pos += 8;
      } else {
        break;
      }
    }
    return elem;
  }

  while (offset < view.byteLength) {
    const tag = readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;

    if (wireType === 2) {
      const bytes = readBytes();
      if (fieldNum === 1) {
        const elem = decodeDanmakuElem(bytes);
        if (elem.content) {
          results.push({
            time: elem.progress / 1000,
            textContent: elem.content
          });
        }
      }
    } else if (wireType === 0) {
      readVarint();
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return results;
}

async function fetchDanmakuSegment(cid, segmentIndex) {
  const url = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${segmentIndex}`;
  const buffer = await fetchBiliData(url, 'arrayBuffer');
  return decodeDanmakuProto(buffer);
}

async function fetchDanmakuWithTime(cid, duration) {
  const segmentCount = Math.ceil((Number.isFinite(duration) && duration > 0 ? duration : 600) / 360);
  const danmaku = [];
  let nextSegment = 1;
  let blocked = false;
  async function worker() {
    while (!blocked && nextSegment <= segmentCount) {
      const index = nextSegment++;
      try {
        danmaku.push(...await fetchDanmakuSegment(cid, index));
      } catch (e) {
        // Keep successful segments, cap concurrency, and stop scheduling requests
        // when the server asks us to stop. XML remains an independent fallback.
        if ([401, 403, 412, 429].includes(e.status)) blocked = true;
        console.warn(`[BiliSmartSkip] danmaku segment ${index} failed:`, e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, segmentCount) }, worker));
  if (danmaku.length > 0) {
    danmaku.sort((a, b) => a.time - b.time);
    log(`danmaku fetched via protobuf: ${danmaku.length} (${segmentCount} segments)`);
    return danmaku;
  }

  try {
    // The public XML CDN does not need a login and may use wildcard CORS.
    const text = await fetchBiliData(`https://comment.bilibili.com/${cid}.xml`, 'text', 'omit');
    const danmakuXML = new DOMParser().parseFromString(text, 'text/xml');
    if (danmakuXML.querySelector('parsererror') || danmakuXML.documentElement?.tagName !== 'i') {
      throw new Error('Invalid danmaku XML');
    }
    const fallback = Array.from(danmakuXML.getElementsByTagName('d')).map(d => ({
      time: parseFloat((d.getAttribute('p') || '').split(',')[0]),
      textContent: d.textContent
    })).filter(d => Number.isFinite(d.time) && d.time >= 0 && d.textContent);
    fallback.sort((a, b) => a.time - b.time);
    log(`danmaku fetched via XML fallback: ${fallback.length}`);
    return fallback;
  } catch (e) {
    console.warn('[BiliSmartSkip] danmaku unavailable; continuing with other sources:', e);
    return [];
  }
}

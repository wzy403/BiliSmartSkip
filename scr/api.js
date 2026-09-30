// == BiliSmartSkip: API & Data Fetching ==

function getBvidFromPage() {
  return window.location.pathname.split('/')[2] || null;
}

async function fetchVideoInfo(bvid) {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    const json = await res.json();
    if (json.code !== 0 || !json.data) return null;
    const d = json.data;
    return {
      cid: d.pages?.[0]?.cid || null,
      title: d.title || '',
      desc: d.desc || '',
      duration: d.duration || 0
    };
  } catch (e) {
    console.warn('fetchVideoInfo failed:', e);
    return null;
  }
}

async function fetchPlayerInfo(bvid, cid) {
  try {
    const res = await fetch(
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`,
      { credentials: 'include' }
    );
    const json = await res.json();
    if (json.code !== 0 || !json.data) return { viewPoints: [], subtitles: [] };
    return {
      viewPoints: json.data.view_points || [],
      subtitles: json.data.subtitle?.subtitles || []
    };
  } catch (e) {
    console.warn('fetchPlayerInfo failed:', e);
    return { viewPoints: [], subtitles: [] };
  }
}

async function fetchSubtitleBody(subtitleUrl) {
  try {
    const url = subtitleUrl.startsWith('//') ? 'https:' + subtitleUrl : subtitleUrl;
    const res = await fetch(url);
    const json = await res.json();
    return json.body || [];
  } catch (e) {
    console.warn('fetchSubtitleBody failed:', e);
    return [];
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
  const res = await fetch(url);
  if (!res.ok) return [];
  const buffer = await res.arrayBuffer();
  return decodeDanmakuProto(buffer);
}

async function fetchDanmakuWithTime(cid, duration) {
  try {
    const segmentCount = Math.ceil((duration || 600) / 360);
    const promises = [];
    for (let i = 1; i <= segmentCount; i++) {
      promises.push(fetchDanmakuSegment(cid, i));
    }
    const segments = await Promise.all(promises);
    const danmaku = segments.flat();
    if (danmaku.length > 0) {
      danmaku.sort((a, b) => a.time - b.time);
      log(`danmaku fetched via protobuf: ${danmaku.length} (${segmentCount} segments)`);
      return danmaku;
    }
  } catch (e) {
    console.warn('Protobuf danmaku failed, falling back to XML:', e);
  }

  const url = `https://comment.bilibili.com/${cid}.xml`;
  const res = await fetch(url);
  const text = await res.text();
  const danmakuXML = new DOMParser().parseFromString(text, 'text/xml');
  const danmaku = Array.from(danmakuXML.getElementsByTagName("d")).map(d => ({
    time: parseFloat(d.getAttribute("p").split(",")[0]),
    textContent: d.textContent
  }));
  danmaku.sort((a, b) => a.time - b.time);
  log(`danmaku fetched via XML fallback: ${danmaku.length}`);
  return danmaku;
}

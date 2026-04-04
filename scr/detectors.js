// == BiliSmartSkip: Ad Detection Algorithms ==

// === Detection: Chapter markers ===
function detectFromChapters(viewPoints) {
  if (!viewPoints || viewPoints.length === 0) return null;
  const adKeywords = ["广告", "ad", "sponsor", "赞助", "商单", "恰饭", "推广"];

  for (const chapter of viewPoints) {
    const label = (chapter.content || '').toLowerCase();
    if (adKeywords.some(kw => label.includes(kw))) {
      return { start: chapter.from, end: chapter.to };
    }
  }
  return null;
}

// === Detection: Description timestamps ===
function detectFromDescription(desc, duration) {
  if (!desc) return null;

  const entries = [];
  const re = /(?:^|\n)\s*(\d{1,2}):(\d{2})\s+(.+)/g;
  let m;
  while ((m = re.exec(desc)) !== null) {
    entries.push({
      time: parseInt(m[1]) * 60 + parseInt(m[2]),
      label: m[3].trim()
    });
  }

  if (entries.length < 2) return null;

  const adKeywords = ["广告", "ad", "sponsor", "赞助", "商单", "恰饭", "推广"];

  for (let i = 0; i < entries.length; i++) {
    const label = entries[i].label.toLowerCase();
    if (adKeywords.some(kw => label.includes(kw))) {
      const start = entries[i].time;
      const end = (i + 1 < entries.length) ? entries[i + 1].time : duration;
      return { start, end };
    }
  }
  return null;
}

// === Detection: Subtitle content analysis (time-clustering) ===
function detectFromSubtitles(subtitleLines, danmaku) {
  if (!subtitleLines || subtitleLines.length < 5) return null;

  const hits = [];
  subtitleLines.forEach(line => {
    const text = (line.content || '').toLowerCase();
    const matched = [];
    for (const kw of AD_CONTENT_KEYWORDS) {
      if (text.includes(kw)) matched.push(kw);
    }
    if (matched.length > 0) {
      hits.push({ from: line.from, to: line.to, content: line.content, matched });
    }
  });

  log(`subtitle: ${hits.length}/${subtitleLines.length} lines hit keywords`);
  hits.forEach(h => {
    log(`  ${formatTime(h.from)} "${h.content}" → [${h.matched.join(', ')}]`);
  });

  if (hits.length < 2) return null;

  // Find the densest cluster within a 120-second window
  const MAX_AD_WINDOW = 120;
  let bestCount = 0, bestStart = -1, bestEnd = -1;
  let i = 0;
  for (let j = 0; j < hits.length; j++) {
    while (hits[j].from - hits[i].from > MAX_AD_WINDOW) i++;
    const count = j - i + 1;
    if (count > bestCount) {
      bestCount = count;
      bestStart = hits[i].from;
      bestEnd = hits[j].to;
    }
  }

  log(`subtitle cluster: ${bestCount} hits in ${formatTime(bestStart)}~${formatTime(bestEnd)}`);

  if (bestCount >= 2 && bestEnd > bestStart) {
    return { start: bestStart, end: bestEnd };
  }

  // Fallback: single strong CTA line (>= 2 keywords) as ad-end anchor
  const strongHits = hits.filter(h => h.matched.length >= 2);
  if (strongHits.length >= 1) {
    const ctaLine = strongHits[0];
    const adEnd = ctaLine.to;
    const adStart = estimateAdStartFromDanmaku(danmaku, adEnd);
    log(`subtitle CTA anchor: "${ctaLine.content}" at ${formatTime(ctaLine.from)}, combined ad: ${formatTime(adStart)}~${formatTime(adEnd)}`);
    return { start: adStart, end: adEnd };
  }

  return null;
}

// Estimate ad start by scanning danmaku signals near a known ad-end time
function estimateAdStartFromDanmaku(danmaku, adEnd) {
  if (!danmaku || danmaku.length === 0) return Math.max(0, adEnd - 60);

  const SEARCH_WINDOW = 120;
  const searchStart = adEnd - SEARCH_WINDOW;
  const allAdKeywords = [...AD_START_KEYWORDS, ...AD_GENERAL_KEYWORDS];
  let earliestHit = null;

  for (const d of danmaku) {
    if (d.time < searchStart || d.time > adEnd) continue;
    const text = d.textContent.trim();
    let isAdSignal = false;

    for (const kw of allAdKeywords) {
      if (text.includes(kw)) { isAdSignal = true; break; }
    }

    if (!isAdSignal) {
      const timeRef = extractTimeFromText(text);
      if (timeRef && Math.abs(timeRef.time - adEnd) <= 30) {
        isAdSignal = true;
      }
    }

    if (isAdSignal) {
      log(`  danmaku start signal: ${formatTime(d.time)} "${text}"`);
      if (earliestHit === null || d.time < earliestHit) {
        earliestHit = d.time;
      }
    }
  }

  if (earliestHit !== null) {
    log(`  danmaku earliest hit: ${formatTime(earliestHit)}`);
    return earliestHit;
  }

  log('  no danmaku signal, fallback to CTA - 60s');
  return Math.max(0, adEnd - 60);
}

// === Detection: Danmaku time-format parsing ===
function findAdTimestamps(danmaku) {
  let timePairs = [];

  danmaku.forEach(d => {
    const start = d.time;
    const text = d.textContent;
    const endInfo = extractTimeFromText(text);

    if (endInfo && !isNaN(start)) {
      timePairs.push({
        start: start,
        end: endInfo.time,
        confidence: endInfo.confidence,
        text: text
      });
    }
  });

  if (timePairs.length === 0) return null;

  timePairs.sort((a, b) => a.start - b.start);

  const endTimeCounts = {};
  timePairs.forEach(({ end, confidence }) => {
    const rounded = Math.round(end);
    endTimeCounts[rounded] = (endTimeCounts[rounded] || 0) + confidence;
  });

  const [mostLikelyEnd, totalConfidence] = Object.entries(endTimeCounts).sort((a, b) => b[1] - a[1])[0];
  if (totalConfidence < 0.9) return null;

  const PET = parseInt(mostLikelyEnd);
  let startTime = null;
  let endTime = PET;

  for (const { start, end } of timePairs) {
    if (end - start < 30) continue;
    if (!startTime && Math.round(end) === PET) {
      startTime = start + 5;
    } else if (Math.round(end) === PET && Math.round(start) - PET > 0) {
      endTime = start - 5;
      break;
    }
  }

  return startTime ? { start: startTime, end: endTime } : null;
}

function extractTimeFromText(text) {
  const match1 = text.match(/(\d{1,2})[:;：；](\d{2})/);
  if (match1) return { time: parseInt(match1[1]) * 60 + parseInt(match1[2]), confidence: 1 };

  const match2 = text.match(/([一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九]|\d)分([一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九]|\d{1,2})秒?/);
  if (match2) return { time: zhNumToInt(match2[1]) * 60 + zhNumToInt(match2[2]), confidence: 1 };

  // "705工程", "0705工程" → 7:05
  const match3 = text.match(/0?(\d{1,2})(\d{2})工程/);
  if (match3) {
    const sec = parseInt(match3[2]);
    if (sec < 60) return { time: parseInt(match3[1]) * 60 + sec, confidence: 1 };
  }

  return null;
}

// === Detection: Danmaku keyword matching (directional) ===
function getAdTimeByKeywords(danmaku) {
  const CLUSTER_WINDOW = 15;
  const MIN_CLUSTER_SIZE = 2;

  const startSignals = [];
  const endSignals = [];
  const generalSignals = [];

  danmaku.forEach(d => {
    const text = d.textContent.trim();
    const time = d.time;
    for (const kw of AD_START_KEYWORDS) {
      if (text.includes(kw)) { startSignals.push(time); break; }
    }
    for (const kw of AD_END_KEYWORDS) {
      if (text.includes(kw)) { endSignals.push(time); break; }
    }
    for (const kw of AD_GENERAL_KEYWORDS) {
      if (text.includes(kw)) { generalSignals.push(time); break; }
    }
  });

  const startCluster = findCluster(startSignals, CLUSTER_WINDOW, MIN_CLUSTER_SIZE);
  const endCluster = findCluster(endSignals, CLUSTER_WINDOW, MIN_CLUSTER_SIZE);

  if (startCluster && endCluster && endCluster.center > startCluster.center) {
    const adStart = startCluster.start;
    const adEnd = endCluster.end;
    if (adEnd - adStart >= 30 && adEnd - adStart <= 180) {
      return { start: adStart, end: adEnd };
    }
  }

  return getAdTimeByGeneralKeywords(generalSignals);
}

function findCluster(times, windowSec, minSize) {
  if (times.length < minSize) return null;
  times.sort((a, b) => a - b);

  let bestCount = 0, bestStart = 0, bestEnd = 0;
  let i = 0;
  for (let j = 0; j < times.length; j++) {
    while (times[j] - times[i] > windowSec) i++;
    const count = j - i + 1;
    if (count > bestCount) {
      bestCount = count;
      bestStart = times[i];
      bestEnd = times[j];
    }
  }

  if (bestCount >= minSize) {
    return { center: (bestStart + bestEnd) / 2, start: bestStart, end: bestEnd };
  }
  return null;
}

function getAdTimeByGeneralKeywords(possibleAdTimes) {
  if (possibleAdTimes.length === 0) return null;
  possibleAdTimes.sort((a, b) => a - b);

  const AD_MAX_DURATION = 100, AD_MIN_DURATION = 30;
  let i = 0, j = 1;
  let adStart, adEnd;
  while (i < possibleAdTimes.length && j < possibleAdTimes.length) {
    const start = possibleAdTimes[i];
    const end = possibleAdTimes[j];
    if (end - start > AD_MAX_DURATION) {
      if (adStart) break;
      if (j - 1 === i) j++;
      i++;
    } else {
      if (end - start >= AD_MIN_DURATION) {
        adStart = start;
        adEnd = end;
      }
      j++;
    }
  }
  if (adStart) return { start: adStart - 5, end: adEnd };
  return null;
}

// === Validation ===
function checkAdSegVaild(adTimes, duration) {
  if (!adTimes || adTimes.start == null || adTimes.end == null) return false;
  if (adTimes.start < 60) return false;
  if (adTimes.end - adTimes.start >= 180) return false;
  if (adTimes.end - adTimes.start < 10) return false;
  if (duration > 0 && adTimes.end >= duration - 20) return false;
  return true;
}

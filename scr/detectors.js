// == BiliSmartSkip: Ad Detection Algorithms ==

// === Detection: Chapter markers ===
function getAdLabelEvidence(value) {
  const label = String(value || '').trim().toLowerCase();
  // Whole English words: "download", "shadow" and "adapter" are not ad labels.
  // A discussion *about* advertising is only a candidate, not an explicit ad marker.
  if (/(?:无|没有|不含|不是|非|拒绝)\s*(?:任何)?(?:广告|赞助|推广|商单)|\b(?:no|without)\s+(?:ads?|sponsors?(?:hip)?)|\bad[\s-]?free\b/i.test(label)) return null;
  const matchedKeywords = ['广告', '赞助', '商单', '恰饭', '推广'].filter(word => label.includes(word));
  const english = label.match(/\b(?:ads?|sponsor(?:ed|ship)?)\b/g) || [];
  matchedKeywords.push(...english);
  if (!matchedKeywords.length) return null;
  const explicit = /^(?:广告|赞助|商单|恰饭|推广|ads?|sponsored|sponsor(?:ship)?)$/.test(label)
    || /^(?:广告(?:时间|环节|片段)|赞助(?:商介绍|环节)|商单环节|恰饭(?:时间|环节)|推广(?:时间|环节)|sponsored (?:segment|message))(?:$|\s*[:：|—–-]|\s*[（(])/.test(label)
    || /[（(]\s*(?:广告|赞助|商单|恰饭|推广|ad|sponsored)\s*[）)]$/.test(label);
  return {
    matchedKeywords: [...new Set(matchedKeywords)],
    requiresConfirmation: !explicit,
    reason: explicit ? 'explicit-ad-label' : 'ambiguous-ad-label'
  };
}

function detectFromChapters(viewPoints) {
  if (!viewPoints || viewPoints.length === 0) return null;
  let uncertain = null;
  for (const chapter of viewPoints) {
    const evidence = getAdLabelEvidence(chapter.content);
    if (!evidence) continue;
    const candidate = { start: chapter.from, end: chapter.to, ...evidence };
    if (!evidence.requiresConfirmation) return candidate;
    uncertain ||= candidate;
  }
  return uncertain;
}

// === Detection: Description timestamps ===
function detectFromDescription(desc, duration) {
  if (!desc) return null;

  const entries = [];
  const re = /(?:^|\n)\s*(\d{1,2}):(\d{2})\s+(.+)/g;
  let m;
  while ((m = re.exec(desc)) !== null) {
    if (parseInt(m[2]) >= 60) continue;
    entries.push({
      time: parseInt(m[1]) * 60 + parseInt(m[2]),
      label: m[3].trim()
    });
  }

  if (entries.length < 2) return null;

  let uncertain = null;
  for (let i = 0; i < entries.length; i++) {
    const evidence = getAdLabelEvidence(entries[i].label);
    if (evidence) {
      const start = entries[i].time;
      const end = (i + 1 < entries.length) ? entries[i + 1].time : duration;
      const candidate = { start, end, ...evidence };
      if (!evidence.requiresConfirmation) return candidate;
      uncertain ||= candidate;
    }
  }
  return uncertain;
}

// === Detection: Local subtitle evidence (always needs confirmation) ===
function getSubtitleEvidence(content) {
  const categories = new Set(), matched = new Set();
  // Phrase roles matter: ordinary buying, free resources, search and cooperation
  // are neither ad anchors nor bridges between otherwise unrelated passages.
  const patterns = {
    sponsor: /(?:本期(?:视频|节目)?|本视频|本节目|这个视频|这期视频).{0,8}由.{1,24}(?:赞助|冠名)|感谢.{1,24}(?:赞助|冠名)|(?:本期|今天).{0,8}赞助商|sponsoredby/i,
    cta: /(?:评论区|蓝链|链接).{0,14}(?:领券|福利|优惠|下单|购买)|领券.{0,12}(?:评论区|蓝链|链接)|(?:一键|立即|现在|赶紧|快来|直接).{0,6}(?:下单|抢购|领券)/,
    route: /(?:点击|点开|扫描|(?:可以|快来|请)点).{0,12}(?:蓝链|链接|二维码)|(?:评论区|蓝链|链接).{0,14}(?:领取|下载)/,
    offer: /优惠券|优惠码|折扣码|领券|(?:新人|新用户|专属|限时).{0,8}(?:优惠|折扣|福利)|(?:免费|限时).{0,6}(?:试用|体验)|(?:购买|下单).{0,8}(?:赠送|立减|优惠)/,
    pitch: /优惠|折扣|福利|旗舰店|包邮|到手价/
  };
  for (const clause of String(content || '').toLowerCase().replace(/\s+/g, '').split(/[。！？!?；;，,]/)) {
    if (/(?:无|没有|不含|不是|并非|拒绝).{0,4}(?:广告|赞助|推广|商单)|(?:不是|并非|没有).{0,24}(?:赞助|冠名)|(?:不要|别|切勿|请勿|禁止|无需|不必|不能|不建议).{0,12}(?:点击|下载|购买|下单|领取|领券|赞助)/.test(clause)) continue;
    for (const [category, pattern] of Object.entries(patterns)) {
      const match = clause.match(pattern);
      if (match) { categories.add(category); matched.add(match[0]); }
    }
    // A teaching/resource link alone is not an ad. Commercial objects can
    // qualify a route within this clause, but never bridge later narrative.
    if (patterns.route.test(clause)) {
      const commercial = clause.match(/商品|购买|下单|会场|领券|优惠券/);
      if (commercial) { categories.add('cta'); matched.add(commercial[0]); }
    }
  }
  return { categories: [...categories], matched: [...matched] };
}

function detectFromSubtitles(subtitleLines, danmaku) {
  if (!Array.isArray(subtitleLines)) return null;
  const lines = subtitleLines.filter(line => line && Number.isFinite(line.from) && Number.isFinite(line.to)
    && line.from >= 0 && line.to > line.from).slice().sort((a, b) => a.from - b.from);
  // Adjacent-row checks reuse classification instead of rescanning each row twice.
  const evidenceByLine = lines.map(line => getSubtitleEvidence(line.content));
  const hits = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], next = lines[index + 1], previous = lines[index - 1];
    const continuedNegation = previous && line.from - previous.to <= 1.5
      && /(?:不要|别|切勿|请勿|禁止|无需|不必|不能|不建议)$/.test(String(previous.content || '').trim());
    let evidence = continuedNegation
      ? getSubtitleEvidence(`${previous.content}${line.content}`) : evidenceByLine[index];
    let to = line.to, lastIndex = index;
    // Subtitle wrapping may split a single instruction into two adjacent rows.
    if (!continuedNegation && next && next.from - line.to <= 1.5
      && !evidence.categories.some(c => c === 'cta' || c === 'sponsor' || c === 'route')) {
      const nextEvidence = evidenceByLine[index + 1];
      const joined = getSubtitleEvidence(`${line.content || ''}${next.content || ''}`);
      if (!nextEvidence.categories.some(c => c === 'cta' || c === 'sponsor' || c === 'route')
        && joined.categories.some(c => c === 'cta' || c === 'sponsor' || c === 'route')) {
        evidence = joined; to = next.to; lastIndex++;
      }
    }
    if (evidence.categories.length) hits.push({ from: line.from, to, index, lastIndex, ...evidence });
  }

  const groups = [];
  for (const hit of hits) {
    const group = groups[groups.length - 1], previous = group && group[group.length - 1];
    // Local continuity: at most eight neutral rows / 20 seconds between evidence.
    // A plain "购买" in the next topic cannot keep the ad interval alive.
    if (!previous || hit.from - previous.to > 20 || hit.index - previous.lastIndex > 9
      || hit.to - group[0].from > 120) groups.push([hit]);
    else group.push(hit);
  }

  const candidates = groups.flatMap(group => {
    const categories = [...new Set(group.flatMap(hit => hit.categories))];
    const hasCommercialContext = categories.some(c => c === 'sponsor' || c === 'offer' || c === 'pitch');
    const ctaCount = group.filter(hit => hit.categories.includes('cta')
      || (hasCommercialContext && hit.categories.includes('route'))).length;
    if (!ctaCount && !(categories.includes('sponsor') && categories.includes('offer'))) return [];
    let start = group[0].from, end = group[group.length - 1].to;
    const boundaryPaddingSeconds = end - start < 10 ? 5 : 0;
    // A short CTA is a nearby manual hint, never a guessed 60–120 second ad.
    // The bounded context is inferred and is explicitly included in diagnostics.
    start = Math.max(0, start - boundaryPaddingSeconds);
    end += boundaryPaddingSeconds;
    return [{ start, end, requiresConfirmation: true,
      matchedKeywords: [...new Set(group.flatMap(hit => hit.matched))],
      evidenceCategories: categories, boundaryPaddingSeconds,
      reason: ctaCount ? 'subtitle-local-cta' : 'subtitle-sponsor-offer',
      score: ctaCount * 4 + (categories.includes('sponsor') ? 3 : 0) + (categories.includes('offer') ? 2 : 0)
    }];
  });
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  log('subtitle local candidates:', candidates);
  if (!candidates.length) return null;
  const { score, ...candidate } = candidates[0];
  return candidate;
}

// === Detection: Danmaku time-format parsing ===
function findAdTimestamps(danmaku, duration = 0) {
  const groups = new Map();

  danmaku.forEach(d => {
    const start = d.time;
    const text = d.textContent;
    const endInfo = extractTimeFromText(text);

    if (!endInfo || !Number.isFinite(start) || start < 0) return;
    const candidate = { start: start + 5, end: endInfo.time };

    // A time reference alone can be a discussion of the video, not a skip instruction.
    const cues = getTimestampSkipCues(text, endInfo.reference);
    const explicit = cues.length > 0;
    // Early sponsor breaks exist. Keep the opening guard for generic jumps, but
    // accept a bounded instruction that explicitly identifies an advertisement.
    const adKeywords = text.match(/广告|恰饭|接广|商单|赞助/g) || [];
    const earlyAdEvidence = explicit && (cues.some(cue => ['跳过广告', '广告结束', '广告完了', '恰饭结束'].includes(cue))
      || /^(?:恭喜(?:又)?接广|(?:广告|恰饭)(?:开始|时间|环节))[！!，,。\s]/.test(text.trim()));
    if (!checkAdSegVaild(candidate, duration, earlyAdEvidence)) return;
    // Short, explicit instructions still qualify when the final interval passes the
    // normal 10-second minimum; a bare timestamp keeps the conservative 30-second gap.
    if (!explicit && endInfo.time - start < 30) return;
    const end = Math.round(endInfo.time);
    if (!groups.has(end)) groups.set(end, []);
    groups.get(end).push({ start: candidate.start, end, explicit, cues, earlyAdEvidence, adKeywords });
  });

  const candidates = [...groups.values()].map(pairs => {
    const explicitPairs = pairs.filter(p => p.explicit);
    // Do not extend a reliable interval using earlier, unrelated time mentions.
    const supportingPairs = explicitPairs.length ? explicitPairs : pairs;
    return {
      start: Math.min(...supportingPairs.map(p => p.start)), end: pairs[0].end,
      requiresConfirmation: explicitPairs.length === 0,
      matchedKeywords: [...new Set(supportingPairs.flatMap(p => [...p.cues, ...p.adKeywords]))],
      reason: explicitPairs.length ? 'explicit-danmaku-skip' : 'unconfirmed-time-reference',
      earlyAdEvidence: supportingPairs.some(p => p.start < 60 && p.earlyAdEvidence),
      referenceCount: pairs.length,
      explicitCount: explicitPairs.length
    };
  });
  // Repeated bare timestamps are not independent votes and cannot authorize auto-skip.
  candidates.sort((a, b) => b.explicitCount - a.explicitCount || b.referenceCount - a.referenceCount || a.start - b.start);
  const best = candidates[0];
  if (!best) return null;
  // Expose conflicting destinations instead of hiding why this timestamp won.
  best.alternativeDestinations = candidates.slice(1)
    .filter(other => other.explicitCount > 0 && Math.max(best.start, other.start) < Math.min(best.end, other.end))
    .map(other => ({ end: other.end, explicitCount: other.explicitCount }));
  return best;
}

function getTimestampSkipCues(text, reference) {
  // Require an instruction next to its timestamp; e.g. "3:10的空降兵" is not one.
  // Negated instructions stay manual even if the negation is separated by other words.
  if (/(?:不|别|勿|未|没|并非|非(?:广告|恰饭|接广|商单|赞助|推广|跳过|空降|跳伞)|无需|无须|禁止)/.test(text)) return [];
  const index = text.indexOf(reference);
  const before = text.slice(0, index);
  const after = text.slice(index + reference.length);
  const cue = '(跳过(?:广告)?|空降|跳伞|指路|传送(?:门)?|广告结束|广告完了|恰饭结束|回归正片|正片开始)';
  const separators = '[\\s:：,，!！。~～→-]*';
  const match = before.match(new RegExp(cue + '(?:到|至|在)?' + separators + '$'))
    || after.match(new RegExp('^' + separators + cue + '(?:了)?(?:$|[\\s,.，。!！~～])'));
  if (match) return [match[1]];
  return /^\s*\d{3,4}工程\s*[!！。]?\s*$/.test(text) ? ['工程'] : [];
}

function extractTimeFromText(text) {
  const match1 = text.match(/(?:^|\D)((\d{1,2})[:;：；](\d{2}))(?!\d)/);
  if (match1) return parseInt(match1[3]) < 60
    ? { time: parseInt(match1[2]) * 60 + parseInt(match1[3]), confidence: 1, reference: match1[1] } : null;

  const match2 = text.match(/(?:^|\D)(([一二三四五六七八九]?十[一二三四五六七八九]?|[零一二三四五六七八九]|\d{1,2})分([一二三四五六七八九]?十[一二三四五六七八九]?|零[一二三四五六七八九]|[零一二三四五六七八九]|\d{1,2})秒?)(?!\d)/);
  if (match2) return zhNumToInt(match2[3]) < 60
    ? { time: zhNumToInt(match2[2]) * 60 + zhNumToInt(match2[3]), confidence: 1, reference: match2[1] } : null;

  // "705工程", "0705工程" → 7:05
  const match3 = text.match(/(?:^|\D)((\d{1,2})(\d{2})工程)/);
  if (match3) {
    const sec = parseInt(match3[3]);
    if (sec < 60) return { time: parseInt(match3[2]) * 60 + sec, confidence: 1, reference: match3[1] };
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
  const withKeywords = segment => segment && ({
    ...segment,
    matchedKeywords: [...new Set(danmaku
      .filter(d => d.time >= segment.start && d.time <= segment.end)
      .flatMap(d => [...AD_START_KEYWORDS, ...AD_END_KEYWORDS, ...AD_GENERAL_KEYWORDS]
        .filter(kw => d.textContent.includes(kw))))]
  });

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
      return withKeywords({ start: adStart, end: adEnd });
    }
  }

  return withKeywords(getAdTimeByGeneralKeywords(generalSignals));
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
function checkAdSegVaild(adTimes, duration, allowEarlyAd = false) {
  if (!adTimes || adTimes.start == null || adTimes.end == null) return false;
  if (!Number.isFinite(adTimes.start) || !Number.isFinite(adTimes.end)) return false;
  if (adTimes.start < (allowEarlyAd ? 0 : 60)) return false;
  if (adTimes.end - adTimes.start >= 180) return false;
  if (adTimes.end - adTimes.start < 10) return false;
  if (duration > 0 && adTimes.end >= duration - 20) return false;
  return true;
}

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

// === Detection: Chapter titles and description timestamps ===
function descriptionEntries(desc) {
  const entries = [];
  // "1:10 广告" or "1:02:30 正片": a timeline line starts with its time.
  const re = /(?:^|\n)\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+)/g;
  let m;
  while ((m = re.exec(String(desc || ''))) !== null) {
    const hours = Number(m[1] || 0), minutes = Number(m[2]), seconds = Number(m[3]);
    if (seconds >= 60 || (m[1] !== undefined && minutes >= 60)) continue;
    entries.push({ time: hours * 3600 + minutes * 60 + seconds, label: m[4].trim() });
  }
  return entries;
}

// Every interval the author labelled as an ad. An explicit label is trusted
// unless its length is implausible for a sponsor read or its end is only
// assumed; a title that merely mentions advertising always needs confirmation.
// Pass Infinity when the video's duration is unknown.
function detectLabelledSegments(chapters, desc, duration) {
  const segments = [];
  const add = (start, end, label, source, endAssumed = false) => {
    const evidence = getAdLabelEvidence(label);
    if (!evidence || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || end > duration) return;
    const length = end - start;
    const plausible = length >= 10 && length <= 300 && length <= duration * 0.6;
    segments.push({ start, end, source, matchedKeywords: evidence.matchedKeywords,
      requiresConfirmation: evidence.requiresConfirmation || !plausible || endAssumed,
      reason: endAssumed ? 'label-without-end' : plausible ? evidence.reason : 'label-duration-needs-review' });
  };
  for (const chapter of Array.isArray(chapters) ? chapters : []) {
    if (chapter) add(chapter.from, chapter.to, chapter.content, 'chapters');
  }
  const entries = descriptionEntries(desc);
  // A lone timestamp is a remark, not a timeline. The last entry of a timeline
  // has no next entry to end at: running it to the end of the video is a guess.
  if (entries.length >= 2) entries.forEach((entry, index) => {
    const last = index + 1 === entries.length;
    add(entry.time, last ? duration : entries[index + 1].time, entry.label, 'description', last);
  });
  return segments;
}

// === Local subtitle evidence (shared with the sponsor-break detector) ===
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

// === Danmaku time references for the sponsor-break detector ===
// The reading itself lives in ad-signals.js, so every detector understands the
// same comment formats and the same idea of an instruction.
function extractTimeFromText(text) {
  const clock = BiliAdSignals.parseClock(text);
  return clock ? { time: clock.seconds, confidence: 1, reference: clock.reference } : null;
}

function getTimestampSkipCues(text) {
  const cue = BiliAdSignals.readComment({ time: 0, textContent: text })?.pointer?.cue;
  return cue ? [cue] : [];
}

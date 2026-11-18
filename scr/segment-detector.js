/* Complete sponsor-break proposals. Pure local rules; no model, storage or API. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BiliSegmentDetector = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Search bounds limit work and confidence, never crop an otherwise longer ad
  // into an allegedly complete automatic interval.
  const LIMITS = Object.freeze({ searchSeconds: 300, gapSeconds: 8, wrapSeconds: 1.5,
    endpointTolerance: 3, minimumBreakSeconds: 10, chapterFraction: 0.6 });
  const valid = (start, end, duration) => Number.isFinite(start) && Number.isFinite(end)
    && start >= 0 && end > start && end <= duration;
  const contains = (outer, inner) => outer.start <= inner.start && outer.end >= inner.end;
  const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const compact = value => String(value || '').toLowerCase().replace(/\s+/g, '');
  const patterns = {
    sponsor: /(?:本期(?:视频|节目)?|本视频|本节目|这个视频|这期视频).{0,12}(?:赞助商|由.{1,28}(?:赞助|冠名))|感谢.{0,8}(?:甲方|金主)|感谢.{1,24}(?:赞助|冠名)|(?:本期|这次|今天|我们).{0,8}(?:与|和).{1,24}(?:合作|联合推出)|(?:接下来|现在|稍后).{0,8}(?:通过|是|进入).{0,28}(?:广告|赞助环节)|(?:今天|本期|这期|本次|我们的).{0,8}赞助商|(?:我们|本期|本视频|本节目).{0,30}(?:被|受到).{1,24}赞助|sponsoredby/,
    supportCredit: /(?:感谢|感恩).{1,35}(?:对|对于).{0,12}(?:本期|本视频|本节目|频道|视频|节目).{0,10}(?:支持|帮助)/,
    sponsorIntro: /感谢.{1,24}(?:赞助|冠名)|感谢.{1,20}(?:的)?催更|(?:广告|恰饭)(?:时间|环节|开始)/,
    cta: /(?:评论区|蓝链|链接|二维码|官网).{0,18}(?:领|优惠|购买|下单|试用)|(?:点击|扫描|前往|访问|使用).{0,18}(?:评论区|蓝链|链接|二维码|官网)|(?:立即|现在|赶紧|快来).{0,6}(?:下单|抢购|领券)/,
    offer: /优惠券|优惠码|折扣码|领券|新客|新用户|补贴|(?:免费|限时).{0,8}(?:试用|体验)|首年.{0,8}(?:折|优惠)/,
    pitch: /优惠|折扣|福利|旗舰店|包邮|到手价|划算|性价比|正品保障|质保|验机报告|保价/,
    price: /(?:只要|仅需|到手|售价|价格).{0,8}\d|\d+(?:\.\d+)?(?:多|左右)?(?:元|块|折)|\d{3,6}.{0,8}(?:拿下|买)/,
    product: /这款|他家|它家|产品|上门回收|二手商品|会员|课程|平台|同款|功能|性能|售后|保障/,
    relationship: /(?:我|我们).{0,16}(?:恰.{0,5}饭|接.{0,3}商单|接.{0,3}广|品牌方)|合作\d+年|合作多年/,
    return: /(?:现在|那么|好了|接下来)?(?:回到|回归)(?:视频|正片|正文|正题|主题|主线|故事)|言归正传|(?:广告|恰饭)(?:结束|完了)|继续(?:刚才的话题|刚才的故事|正片)/,
    softReturn: /^(?:好了?[,，]?|那么|接下来)?让我们从.{1,20}开始|^说回(?:刚才|前面)/
  };
  const supportFeature = /销量|创新设计|原创设计|智能化|搭载|升级|配色|体积|功率|很好用|非常好用|课程|产品|配置|定制选项|提供.{0,8}选择/;
  const signoff = /(?:感谢|谢谢).{0,8}(?:观看|收看|收听|看到这里)|(?:今天|本期|这期|以上|这就是).{0,15}(?:视频|节目).{0,10}(?:结束|全部内容)|^(?:那|那么|所以)?如果.{0,12}喜欢.{0,12}(?:视频|节目)/;
  const negative = /(?:无|没有|不含|不是|并非|拒绝).{0,8}(?:广告|赞助|冠名|推广|商单)|(?:不要|别|切勿|请勿|禁止|无需|不必|不能|不建议).{0,16}(?:点击|下载|购买|下单|领取|领券|赞助|回到|回归)/;
  const reported = /(?:他说|她说|有人说|所谓|举个例子|这句话|那句|广告词|广告里|假设).{0,24}(?:赞助|广告|冠名)|[“「『"].{0,30}(?:本视频|本期|赞助)/;
  function classify(text, helpers) {
    const roles = new Set(), matched = new Set(), value = compact(text);
    for (const clause of value.split(/[。！？!?；;]/)) {
      if (negative.test(clause) || reported.test(clause)) continue;
      for (const [role, pattern] of Object.entries(patterns)) {
        if (role === 'sponsorIntro' && /感谢.{0,6}(?:大家|观众|粉丝|你们|朋友|老师|网友).{0,8}催更/.test(clause)) continue;
        const match = clause.match(pattern);
        if (match) { roles.add(role); matched.add(match[0]); }
      }
      if (typeof helpers.getSubtitleEvidence === 'function') {
        const evidence = helpers.getSubtitleEvidence(clause);
        for (const role of evidence?.categories || []) if (role !== 'sponsor') roles.add(role);
        for (const match of evidence?.matched || []) matched.add(match);
      }
    }
    return { roles: [...roles], matched: [...matched] };
  }
  function prepare(subtitles, duration, helpers) {
    const seen = new Set();
    const lines = (Array.isArray(subtitles) ? subtitles : []).filter(line => line && valid(line.from, line.to, duration)
      && typeof line.content === 'string').map(line => ({ from: line.from, to: line.to, content: line.content }))
      .sort((a, b) => a.from - b.from || a.to - b.to).filter(line => {
        const key = `${line.from}:${line.to}:${line.content}`;
        if (seen.has(key)) return false; seen.add(key); return true;
      });
    return lines.map((line, index) => {
      const previous = lines[index - 1], next = lines[index + 1];
      const quotedContext = lines.slice(Math.max(0, index - 3), index).some(before => line.from - before.to <= 15
        && /(?:广告词|广告文案|赞助声明).{0,12}(?:示例|例子|模板)|(?:示例|举例|比如).{0,12}(?:广告词|赞助声明)/.test(before.content));
      const negatedWrap = previous && line.from - previous.to <= LIMITS.wrapSeconds
        && /(?:不要|别|切勿|请勿|禁止|无需|不必|不能|不建议|没有|不是)$/.test(previous.content.trim());
      let text = negatedWrap ? previous.content + line.content : line.content;
      let evidence = classify(text, helpers), anchorEnd = line.to;
      const sponsor = result => result.roles.some(role => role === 'sponsor' || role === 'sponsorIntro' || role === 'supportCredit');
      if (!negatedWrap && next && next.from >= line.to && next.from - line.to <= LIMITS.wrapSeconds
        && !sponsor(evidence) && !sponsor(classify(next.content, helpers))) {
        const joined = classify(line.content + next.content, helpers);
        if (sponsor(joined)) { evidence = joined; anchorEnd = next.to; }
      }
      if (quotedContext) evidence.roles = evidence.roles.filter(role => !['sponsor', 'sponsorIntro', 'supportCredit', 'relationship'].includes(role));
      return { ...line, ...evidence, anchorEnd, index };
    });
  }
  const has = (line, ...roles) => line.roles.some(role => roles.includes(role));
  const commercial = line => has(line, 'cta', 'offer', 'pitch', 'price');
  function cleanInstruction(text) {
    // Remove decorative frames only, never narrative/negation words.
    return String(text || '').trim().replace(/^[░▒▓█▌▐▏▎▍▊▋▉★☆✦✧]+|[░▒▓█▌▐▏▎▍▊▋▉★☆✦✧]+$/g, '').trim();
  }
  function destinations(danmaku, duration, helpers) {
    const result = [];
    for (const comment of Array.isArray(danmaku) ? danmaku : []) {
      if (!comment || !Number.isFinite(comment.time) || comment.time < 0 || comment.time >= duration) continue;
      const text = cleanInstruction(comment.textContent);
      let parsed, cues;
      if (typeof helpers.extractTimeFromText === 'function' && typeof helpers.getTimestampSkipCues === 'function') {
        parsed = helpers.extractTimeFromText(text);
        cues = parsed && helpers.getTimestampSkipCues(text, parsed.reference);
      } else {
        const m = text.match(/^(?:跳过广告|广告结束|空降|跳伞)\s*(\d{1,2})[:：](\d{2})[!！。]?$/)
          || text.match(/^(\d{1,2})(\d{2})工程[!！。]?$/);
        if (m && Number(m[2]) < 60) { parsed = { time: Number(m[1]) * 60 + Number(m[2]) }; cues = ['explicit-time-command']; }
      }
      if (!parsed || !Array.isArray(cues) || !cues.length || !valid(comment.time, parsed.time, duration)) continue;
      result.push({ time: comment.time, end: parsed.time, cues: [...cues], text: text.slice(0, 120) });
    }
    return result;
  }
  function chapterRanges(chapters, duration) {
    const result = (Array.isArray(chapters) ? chapters : []).filter(chapter => chapter && valid(chapter.from, chapter.to, duration))
      .map(chapter => ({ start: chapter.from, end: chapter.to, title: String(chapter.content || '').slice(0, 120) }))
      .sort((a, b) => a.start - b.start);
    if (result.some((chapter, index) => index && chapter.start < result[index - 1].end)) return [];
    return result.filter((chapter, index) => index > 0 && index < result.length - 1
      && chapter.end - chapter.start <= LIMITS.searchSeconds && chapter.end - chapter.start <= duration * LIMITS.chapterFraction);
  }
  function reactions(danmaku, start, end) {
    const found = new Map();
    for (const comment of Array.isArray(danmaku) ? danmaku : []) {
      if (!comment || !Number.isFinite(comment.time) || comment.time < start || comment.time >= end) continue;
      const text = compact(comment.textContent);
      if (/(?:不是|没|无|不算|是不是|难道|并非)/.test(text)) continue;
      if (!/感谢甲方|恭喜.{0,4}接广|接到商单|甲方.{0,6}文案/.test(text)) continue;
      if (!found.has(text)) found.set(text, { time: comment.time, text: text.slice(0, 120) });
    }
    return [...found.values()];
  }
  function alignTimeEnd(end, lines) {
    const previous = lines.filter(line => line.to <= end && end - line.to <= LIMITS.endpointTolerance).at(-1);
    if (!previous) return end;
    const next = lines[previous.index + 1];
    const closing = lines.some(line => line.to <= previous.to && previous.to - line.to <= 5 && commercial(line));
    return closing && next && !commercial(next) && next.from >= previous.to ? previous.to : end;
  }
  function chain(lines) {
    const unique = new Set(lines.filter(commercial).map(line => compact(line.content)));
    const roles = new Set(lines.flatMap(line => line.roles));
    return unique.size >= 2 && ['cta', 'offer', 'pitch'].some(role => roles.has(role));
  }
  function statement(line) { return { from: line.from, to: line.anchorEnd,
    roles: line.roles, matchedKeywords: line.matched.slice(0, 6) }; }
  function result(start, end, seed, body, boundary, options = {}) {
    const skipDecision = options.keep ? 'keep' : 'skip';
    const autoEligible = !options.keep && Boolean(options.auto);
    return { start, end, source: 'segment-detector', sources: ['subtitles', ...new Set(boundary.sources || [])],
      contentType: autoEligible || seed && has(seed, 'sponsor', 'sponsorIntro', 'supportCredit') ? 'ad' : 'uncertain',
      skipDecision, requiresConfirmation: !autoEligible, autoEligible,
      confidence: autoEligible ? 'high' : 'low', boundaryConfidence: autoEligible ? 'high' : 'uncertain',
      reason: options.keep ? 'standalone-or-content-theme-kept' : 'complete-sponsor-break',
      matchedKeywords: [...new Set(body.flatMap(line => line.matched))].slice(0, 24),
      boundaryEvidence: boundary, observedEvidence: body.filter(line => commercial(line) || has(line, 'sponsor', 'sponsorIntro', 'supportCredit'))
        .slice(0, 8).map(statement), observedLineCount: body.length,
      reviewReasons: options.reasons || [], earlyAdEvidence: autoEligible && start < 60 };
  }
  function detectSegments(input, helpers = {}) {
    if (!input || !Number.isFinite(input.duration) || input.duration <= 0) return [];
    const { duration } = input, lines = prepare(input.subtitles, duration, helpers);
    const chapters = chapterRanges(input.chapters, duration), times = destinations(input.danmaku, duration, helpers);
    const title = compact(input.title);
    const productTheme = /开箱|试吃|测评|评测|品鉴|好物推荐|购物分享/.test(title);
    const ownCourse = /课程|教程|教学|入门/.test(title)
      && lines.some(line => line.from < 45 && /本课程|这门课|这个课程|第一课|教学目标|本套教程/.test(line.content));
    const output = [];
    // Explicit author-labelled ad chapters do not require subtitle availability.
    // Unlike the legacy single-candidate API, retain every separate ad chapter.
    for (const chapter of Array.isArray(input.chapters) ? input.chapters : []) {
      if (!chapter || !valid(chapter.from, chapter.to, duration)) continue;
      const evidence = typeof helpers.getAdLabelEvidence === 'function' ? helpers.getAdLabelEvidence(chapter.content)
        : /^(?:广告|赞助|商单|恰饭|广告时间|赞助环节|ad|sponsored)$/i.test(String(chapter.content || '').trim())
          ? { requiresConfirmation: false, matchedKeywords: [String(chapter.content)] } : null;
      if (!evidence || evidence.requiresConfirmation !== false) continue;
      const auto = chapter.to - chapter.from >= LIMITS.minimumBreakSeconds
        && chapter.to - chapter.from <= LIMITS.searchSeconds && chapter.to - chapter.from <= duration * LIMITS.chapterFraction;
      const segment = result(chapter.from, chapter.to, null, [], { sources: ['chapters'],
        start: { kind: 'explicit-ad-chapter', time: chapter.from }, end: { kind: 'explicit-ad-chapter', time: chapter.to } },
      { auto, reasons: auto ? [] : ['chapter-duration-needs-review'] });
      segment.contentType = 'ad'; segment.reason = 'explicit-ad-chapter'; segment.matchedKeywords = evidence.matchedKeywords || [];
      if (!output.some(other => overlap(other, segment))) output.push(segment);
    }
    const seeds = [];
    for (const line of lines.filter(line => has(line, 'sponsor', 'sponsorIntro', 'supportCredit'))) {
      const previous = seeds.at(-1);
      // Adjacent sponsor wording can be one wrapped declaration. A separate
      // later declaration is always a search barrier, never evidence for this one.
      if (previous && line.index === previous.lastIndex + 1 && line.from - previous.anchorEnd <= LIMITS.wrapSeconds) {
        previous.anchorEnd = Math.max(previous.anchorEnd, line.anchorEnd); previous.lastIndex = line.index;
        previous.roles = [...new Set([...previous.roles, ...line.roles])];
      } else seeds.push({ ...line, lastIndex: line.index });
    }
    for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
      const seed = seeds[seedIndex], nextSeed = seeds[seedIndex + 1];
      if (output.some(segment => seed.from >= segment.start && seed.from < segment.end)) continue;
      const chapter = chapters.find(ch => ch.start <= seed.from && ch.end >= seed.anchorEnd
        && (!nextSeed || nextSeed.from >= ch.end));
      let start = chapter ? chapter.start : seed.from;
      const limit = Math.min(duration, start + LIMITS.searchSeconds, chapter?.end ?? Infinity, nextSeed?.from ?? Infinity);
      const after = lines.filter(line => line.from >= seed.from && line.from < limit);
      const returned = after.find(line => line.index > seed.index && has(line, 'return'));
      const softReturn = after.find(line => line.index > seed.index && has(line, 'softReturn')
        && after.some(before => before.to <= line.from && has(before, 'cta', 'offer')));
      // A support credit needs an immediate product pitch before a closing transition.
      const supportOnly = has(seed, 'supportCredit') && !has(seed, 'sponsor', 'sponsorIntro');
      const promotionLines = after.filter(line => line.index > seed.lastIndex && supportFeature.test(compact(line.content)));
      const immediatePromotion = promotionLines.length >= 2 && promotionLines[0].from <= seed.anchorEnd + 3;
      const linkedPromotion = after.some(line => line.index > seed.lastIndex && line.from < seed.anchorEnd + 12
        && /(?:描述|简介).{0,10}(?:附有|有|找到)链接/.test(compact(line.content)))
        && after.some(line => line.index > seed.lastIndex && line.from < seed.anchorEnd + 15
          && /亲自查看|试试|下载|领取|购买|体验/.test(compact(line.content)));
      const signedOff = after.find(line => {
        if (line.index <= seed.lastIndex) return false;
        const productSignoff = ((supportOnly && immediatePromotion) || has(seed, 'sponsor'))
          && promotionLines.filter(before => before.to <= line.from).length >= 2
          && signoff.test(compact(line.content));
        const linkedSignoff = linkedPromotion
          && /^(?:希望.{0,8}玩得开心|(?:我们|咱们)?下次再见)/.test(compact(line.content));
        return productSignoff || linkedSignoff;
      });
      const resumed = after.find(line => line.index > seed.lastIndex
        && /^(?:那么|现在|好了)?让我们(?:来)?看看/.test(compact(line.content))
        && !/(?:这款|产品|它的|效果)/.test(compact(line.content))
        && after.some(before => before.to <= line.from && line.from - before.to <= 5 && has(before, 'cta', 'offer', 'pitch')));
      const stop = [returned, softReturn, signedOff, resumed].filter(Boolean).sort((a, b) => a.from - b.from)[0];
      const explicitStop = stop && has(stop, 'return');
      let end = stop ? lines[stop.index - 1].to : chapter?.end;
      let endKind = stop ? explicitStop ? 'explicit-return' : stop === signedOff ? 'outro-transition' : 'post-offer-transition' : chapter ? 'chapter-end' : null;
      let scope = after.filter(line => !end || line.to <= end);
      // A lone opening credit does not open a sponsor state over the main video.
      const earlyFollow = scope.filter(line => line.from <= seed.anchorEnd + 25 && line.index > seed.index);
      if (!chapter && seed.from < 10 && seed.to - seed.from <= 8 && !earlyFollow.some(line => has(line, 'cta', 'offer', 'pitch', 'product'))) {
        output.push(result(seed.from, seed.anchorEnd, seed, [seed], { start: { kind: 'sponsor-statement' }, end: { kind: 'statement-end' } },
          { keep: true, reasons: ['single-statement-without-promotional-continuation'] }));
        continue;
      }
      const nearby = times.filter(time => time.time >= start - 15 && time.time < (end || limit)
        && time.end > seed.anchorEnd && time.end <= limit && time.end - start <= LIMITS.searchSeconds
        && (!end || Math.abs(time.end - end) <= LIMITS.endpointTolerance));
      const groups = [];
      for (const time of nearby.slice().sort((a, b) => a.end - b.end)) {
        let group = groups.find(value => Math.abs(value.end - time.end) <= LIMITS.endpointTolerance);
        if (!group) { group = { end: time.end, references: [] }; groups.push(group); }
        group.references.push(time);
      }
      groups.sort((a, b) => b.references.length - a.references.length || a.end - b.end);
      const selected = groups[0], conflict = !end && groups.length > 1;
      if (!end && selected) { end = selected.end; endKind = 'explicit-danmaku-end'; }
      let continuingAfterTime = false;
      if (endKind === 'explicit-danmaku-end') {
        const continuation = after.filter(line => line.from >= end && line.from <= end + 12 && has(line, 'cta', 'offer'));
        if (continuation.length) {
          // A destination inside a still-visible offer is not a complete end.
          // Keep the observed continuation as a manual proposal, never crop it.
          end = continuation.at(-1).to; endKind = 'commercial-continuation-after-timestamp'; continuingAfterTime = true;
        }
        if (!continuingAfterTime) end = alignTimeEnd(end, lines);
      }
      if (!end) {
        // Missing a firm endpoint is explicit uncertainty, not a reason to use
        // only the last CTA or manufacture a fixed-size interval.
        let gapIndex = after.findIndex((line, index) => index && line.from - after[index - 1].to > LIMITS.gapSeconds);
        scope = gapIndex < 0 ? after : after.slice(0, gapIndex);
        const lastCommercial = scope.filter(commercial).at(-1);
        end = lastCommercial?.to || seed.anchorEnd;
        endKind = nextSeed && limit === nextSeed.from ? 'unresolved-before-next-sponsor' : 'last-observed-commercial-line';
      }
      scope = lines.filter(line => line.from >= start && line.to <= end);
      if (!valid(start, end, duration)) continue;
      const sustained = chain(scope) && scope.length >= 4 && end - start >= LIMITS.minimumBreakSeconds;
      const independentBreak = Boolean(explicitStop || chapter || (selected && has(seed, 'sponsor') && scope.some(line => has(line, 'cta'))));
      const themeRisk = ((productTheme || ownCourse) && !independentBreak) || end - start > duration * LIMITS.chapterFraction;
      const hardEnd = ['explicit-return', 'explicit-danmaku-end', 'chapter-end'].includes(endKind);
      const strongStart = has(seed, 'sponsor');
      const corroboratedIntro = has(seed, 'sponsorIntro') && selected
        && new Set(scope.filter(commercial).map(line => compact(line.content))).size >= 3;
      const subtitleGap = scope.some((line, index) => index && line.from - scope[index - 1].to > LIMITS.gapSeconds);
      const auto = (strongStart || corroboratedIntro) && sustained && hardEnd && !conflict && !themeRisk && (!subtitleGap || chapter);
      // A credit alone is not a complete ad, even away from the video opening.
      const keep = (themeRisk && !stop && !chapter) || (supportOnly && !explicitStop && !signedOff)
        || (!chapter && end <= seed.anchorEnd && !linkedPromotion);
      output.push(result(start, end, seed, scope, { sources: [chapter ? 'chapters' : null, selected ? 'danmaku-time' : null].filter(Boolean),
        start: { kind: chapter ? 'chapter-start' : 'sponsor-statement', time: start },
        end: { kind: endKind, time: end, ...(stop ? { returnLine: statement(stop) } : {}) },
        ...(chapter ? { chapter } : {}), ...(selected ? { timeReferences: selected.references.slice(0, 6) } : {}),
        alternativeEnds: groups.slice(1).map(group => ({ end: group.end, references: group.references.length })) },
      { auto, keep, reasons: [!strongStart && !corroboratedIntro && 'weak-sponsor-identity', !sustained && 'insufficient-promotional-continuation',
        !hardEnd && 'end-needs-review', continuingAfterTime && 'commercial-content-after-time-destination',
        conflict && 'conflicting-time-destinations', subtitleGap && !chapter && 'subtitle-continuity-gap',
        themeRisk && 'content-theme-may-be-kept'].filter(Boolean) }));
    }
    // A chapter can recover a full manual interval even when only a CTA is
    // explicit. It never becomes automatic without an independent sponsor start.
    for (const chapter of chapters) {
      if (output.some(segment => overlap(segment, chapter))) continue;
      const body = lines.filter(line => line.from >= chapter.start && line.to <= chapter.end);
      const completeCta = body.some(line => has(line, 'cta') && has(line, 'offer', 'pitch'));
      if ((!chain(body) || !body.some(line => has(line, 'cta'))) && !completeCta) continue;
      const community = reactions(input.danmaku, chapter.start, chapter.end);
      const corroborated = completeCta && body.some(line => has(line, 'relationship'))
        && community.length >= 2 && !productTheme && !ownCourse;
      output.push(result(chapter.start, chapter.end, null, body, { sources: ['chapters'],
        start: { kind: 'chapter-start', time: chapter.start }, end: { kind: 'chapter-end', time: chapter.end }, chapter,
        commercialReactions: community.slice(0, 6) },
      { auto: corroborated, reasons: corroborated ? [] : ['commercial-chapter-without-explicit-sponsor-start'] }));
    }
    return output.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return { LIMITS, detectSegments };
});

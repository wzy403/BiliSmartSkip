/* Community and transcript evidence for embedded ads.
   Rules decide whether a passage is an ad. The generated word-weight table in
   pitch-model.js only helps place its first and last subtitle line.
   Runs locally: no network, storage or remote inference. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BiliAdSignals = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    // Viewer comments naming a jump destination
    minSeconds: 10, maxSeconds: 300,   // plausible length of one jump over a sponsor read
    destinationTolerance: 3,           // comments this close name the same destination
    pressTolerance: 20,                // ...and a count of key presses is this imprecise
    pairGapSeconds: 12,                // two comments further apart: the first was posted in anticipation
    reactionLeadSeconds: 6,            // "恭喜接广" this soon before the first timestamp marks the start
    reactionSeconds: 60,               // reactions count as support only near the start of the jump
    introSeconds: 60,                  // a jump this early needs evidence that it skips an ad, not an intro
    openingSeconds: 30, openingMaxSeconds: 120, // ...and one this early is never taken unprompted
    breaksPerVideo: 3,                 // more jump targets than this read as a table of contents
    // Commercial passages in the transcript
    anchorGapSeconds: 30,              // commercial phrases this close belong to one read
    growBackSeconds: 240, growForwardSeconds: 45,
    wrapSeconds: 1.5,                  // rows this close may be one wrapped sentence
    minBlockSeconds: 8, signOffSeconds: 45, creditBodyScore: 2
  });
  const overlaps = (a, b) => Math.max(a.start, b.start) < Math.min(a.end, b.end);

  // === Danmaku: jump destinations, arrivals and ad reactions ===

  const DECORATION = /[░▒▓█▌▐▏▎▍▊▋▉★☆✦✧■□◆◇▲△▼▽●○♦♢【】\[\]「」『』《》]+/g;
  const tidy = text => String(text ?? '').replace(DECORATION, ' ').replace(/\s+/g, ' ').trim();
  const ZH_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function toNumber(value) {
    if (/^\d+$/.test(value)) return Number(value);
    if (value === '十') return 10;
    if (value.includes('十')) {
      const [tens, ones] = value.split('十');
      const high = tens ? ZH_DIGITS[tens] : 1, low = ones ? ZH_DIGITS[ones] : 0;
      return high === undefined || low === undefined ? NaN : high * 10 + low;
    }
    if (/^零.$/.test(value)) return ZH_DIGITS[value[1]] ?? NaN;
    return ZH_DIGITS[value] ?? NaN;
  }
  const NUM = '[零一二两三四五六七八九十]{1,3}|\\d{1,2}';
  // [pattern, seconds(match), kind]. "clock" and "code" name an exact second;
  // a bare decimal is only a clock when the rest of the comment says so.
  // A time may follow a colon ("空降：05:32") but not another number's colon
  // (the tail of 1:02:03 is not 2:03).
  const START = '(?<![\\d.]|\\d\\s*[:：])';
  const CLOCKS = [
    [new RegExp(`${START}(\\d{1,2})\\s*[:：]\\s*([0-5]\\d)\\s*[:：]\\s*([0-5]\\d)(?![\\d:：])`), m => m[1] * 3600 + m[2] * 60 + +m[3], 'clock'],
    [new RegExp(`${START}(\\d{1,2})\\s*[:：∶;；]\\s*([0-5]\\d)(?![\\d:：])`), m => m[1] * 60 + +m[2], 'clock'],
    // "十分一般" is an adverb, not ten minutes: a spoken "十分" needs its "秒".
    [new RegExp(`(?<![\\d零一二两三四五六七八九十])(${NUM})\\s*分\\s*钟?\\s*(${NUM})\\s*(秒?)`),
      m => toNumber(m[2]) < 60 && !(m[1] === '十' && !m[3]) ? toNumber(m[1]) * 60 + toNumber(m[2]) : NaN, 'clock'],
    [/(?<![\d.])(\d{1,2})[.．]([0-5]\d)\s*(?:工程|认证)/, m => m[1] * 60 + +m[2], 'code'],
    [/(?<!\d)(\d{1,2})([0-5]\d)\s*(?:工程|认证)/, m => m[1] * 60 + +m[2], 'code'],
    // Only separators may sit between the jump word and its digits: "空降成功2333" is laughter.
    [/(?:空降|跳伞|跳转|跳到|跳至|传送|指路|直达|快进到?)[\s:：,，到至→~-]{0,3}(\d{1,2})([0-5]\d)(?!\d)/, m => m[1] * 60 + +m[2], 'code'],
    [/(?<![\d.])(\d{1,2})\s*[.．,，·]\s*([0-5]\d)(?![\d.])/, m => m[1] * 60 + +m[2], 'decimal']
  ];
  // The playback time a comment mentions, whatever the comment means by it.
  function parseClock(value) {
    const text = tidy(value);
    for (const [pattern, seconds, kind] of CLOCKS) {
      const match = text.match(pattern), time = match ? seconds(match) : NaN;
      if (Number.isFinite(time)) return { seconds: time, kind, reference: match[0] };
    }
    return null;
  }
  // One press of the right arrow key seeks five seconds in the web player.
  // "左右各10次" and "方向键左5下" are not that.
  const ARROW_PRESSES = /(?<!左)(?:向右|右方向键?|右键|右边|右|→|方向键右|按右)[^\d左]{0,3}?(\d{1,2})\s*(?:下|次)/;
  const JUMP = /空降|跳伞|跳过|跳转|跳到|跳至|快进到?|指路|传送|直达|折跃|跃迁|降落|工程|认证|省流|正片|进度条|拖到|拉到|广告结束|广告完|恰饭结束|我是.{0,8}(?:君|郎|侠|喵)|不用谢|不谢|无需谢/;
  // "不要跳过 2:00", "这不是广告" tell viewers to stay. A bare 不 does not:
  // "7.20工程真不错" is an ordinary instruction, and so is one that ends in a
  // courtesy ("3分35不用谢"). 别 inside 特别/识别 is not a prohibition.
  const DONT = '不要|不用|不必|不能|不可|不该|不许|不准|不建议|千万别|(?<![特识区分个辨鉴级类差告离])别|勿|禁止|无需|无须|没必要';
  const COURTESY = /不用谢|不谢|无需谢|别谢我?|不客气/g;
  const STAY = new RegExp(`(?:${DONT}).{0,3}(?:跳|空降|传送|指路|快进|拖|拉)|(?:不是|并非|没有?).{0,4}(?:广告|恰饭|推广|赞助|商单)`);
  const THANKS = /感谢|谢谢|多谢|谢了|蟹蟹|thank/i;
  // Thanks addressed to whoever pointed the way, as opposed to thanks in general.
  const GUIDE = /空降|跳伞|指路|带路|课代表|省流|工程|[君郎侠]$/;
  const RETURNED = /欢迎回来|安全着陆|成功着陆|空降成功|跳伞成功|降落成功|已跳过|广告结束|广告完了|恰饭结束|正片开始/;
  // A unit glued to the digits makes it a date, price or score, not a playback time.
  const NOT_PLAYBACK = /\d\s*(?:年|月|日|号|点|时|元|块|亿|万|千|度|岁|米|公里|斤|克|寸|倍|折|%|％|w|k|g|cm|mm)|(?:年|月|日|号)\s*\d|[¥￥$]|比分|赔率|[-+]\s*\d/i;
  const AD_WORD = /广告|广子|恰饭|接广|商单|金主|甲方|赞助|硬广|软广|带货|植入|(?:接|恰|是|这|的)推广|推广(?:位|来了|时间)/;
  const AD_DENIED = /(?:没|无|不是|不算|没有|居然没|竟然没|哪有|没接|非|拒绝|不含)(?:任何)?(?:广告|广子|恰饭|推广|赞助|商单)|以为.{0,8}(?:广告|广子|恰饭)|(?:广告|广子)(?:呢|吗|在哪|里|中|上)|是不是|可能/;

  function readComment(comment) {
    const time = comment?.time, text = tidy(comment?.textContent);
    if (!Number.isFinite(time) || time < 0 || !text || text.length > 40) return null;
    const read = { time, text, adReaction: AD_WORD.test(text) && !AD_DENIED.test(text) };
    const thanks = THANKS.test(text), presses = text.match(ARROW_PRESSES);
    if (presses) {
      const wait = text.match(/等\s*(\d{1,2})\s*秒/);
      if (thanks) read.arrival = { time };
      else read.pointer = { time, destination: time + presses[1] * 5 + (wait ? +wait[1] : 0), kind: 'presses', cue: '方向键' };
      return read;
    }
    const clock = parseClock(text);
    if (!clock) {
      if ((thanks && GUIDE.test(text)) || RETURNED.test(text)) read.arrival = { time };
      return read;
    }
    // "感谢 3分10秒侠" is posted on arrival: it confirms a destination, it is
    // not one. Thanks typed well before the named time still point forward.
    if (thanks && time >= clock.seconds - 5) { read.arrival = { time, destination: clock.seconds }; return read; }
    // Telling viewers to stay is no witness for the jump.
    if (STAY.test(text.replace(COURTESY, ' '))) return read;
    const cue = text.match(JUMP);
    // Thanking "9.10" from further back names a guide, not a place to go.
    if (thanks && !cue) return read;
    // A decimal is a clock only when it stands alone or carries a jump cue,
    // and never next to a unit of money or measure.
    const decimal = clock.kind === 'decimal';
    if ((decimal || !cue) && NOT_PLAYBACK.test(text)) return read;
    if (decimal && !cue && !/^\D{0,2}\d{1,2}\s*[.．,，·]\s*\d{2}\D{0,2}$/.test(text)) return read;
    read.pointer = { time, destination: clock.seconds, kind: clock.kind, cue: cue ? cue[0] : null };
    return read;
  }

  function collectSignals(danmaku) {
    const pointers = [], arrivals = [], adReactions = [];
    for (const comment of Array.isArray(danmaku) ? danmaku : []) {
      const read = readComment(comment);
      if (!read) continue;
      if (read.pointer) pointers.push({ ...read.pointer, text: read.text });
      if (read.arrival) arrivals.push(read.arrival);
      if (read.adReaction) adReactions.push({ time: read.time, text: read.text });
    }
    const byTime = (a, b) => a.time - b.time;
    return { pointers: pointers.sort(byTime), arrivals: arrivals.sort(byTime), adReactions: adReactions.sort(byTime) };
  }

  // A count of key presses lands within a few presses of the destination; every
  // other format names a second.
  const exact = pointer => pointer.kind !== 'presses';
  const vote = pointer => (pointer.cue ? 2 : 1) * (pointer.kind === 'clock' || pointer.kind === 'code' ? 1 : 0.5);
  // Viewers who know an ad is coming post early; most post as it starts. With
  // enough comments, use the start of the densest burst rather than the first
  // comment. Two lone comments far apart say nothing about which is right: the
  // later one only shortens the skip.
  function startFromComments(comments) {
    if (comments.length < 3) {
      const late = comments.length === 2 && comments[1].time - comments[0].time > LIMITS.pairGapSeconds;
      return { start: comments[late ? 1 : 0].time, burst: false };
    }
    const windowSeconds = comments.length >= 6 ? 6 : 4;
    let most = 0, start = comments[0].time;
    // Comments arrive sorted by time: slide the window instead of recounting.
    for (let first = 0, beyond = 0; first < comments.length; first++) {
      while (beyond < comments.length && comments[beyond].time <= comments[first].time + windowSeconds) beyond++;
      if (beyond - first > most) { most = beyond - first; start = comments[first].time; }
    }
    // Nobody posted together: let an explicit instruction, not a passing
    // mention of the time, say where the ad begins.
    if (most === 1) return { start: (comments.find(comment => comment.cue) || comments[0]).time, burst: false };
    return { start, burst: true };
  }
  function pointerClusters(signals, duration) {
    const valid = signals.pointers.filter(p => p.destination - p.time >= LIMITS.minSeconds
      && p.destination - p.time <= LIMITS.maxSeconds && p.destination <= duration + 2)
      .sort((a, b) => a.destination - b.destination);
    const group = (pointers, tolerance) => {
      const groups = [];
      for (const pointer of pointers) {
        const last = groups.at(-1);
        if (last && pointer.destination - last.at(-1).destination <= tolerance) last.push(pointer);
        else groups.push([pointer]);
      }
      return groups;
    };
    const groups = group(valid.filter(exact), LIMITS.destinationTolerance);
    // "向右24下" next to comments naming 5:49 is another witness for 5:49, not a
    // rival destination twenty seconds later.
    const loose = [];
    for (const pointer of valid.filter(p => !exact(p))) {
      const near = groups.filter(members => Math.abs(members[0].destination - pointer.destination) <= LIMITS.pressTolerance
        && members.some(member => Math.abs(member.time - pointer.time) <= LIMITS.reactionSeconds))
        .sort((a, b) => Math.abs(a[0].destination - pointer.destination) - Math.abs(b[0].destination - pointer.destination))[0];
      if (near) near.push(pointer); else loose.push(pointer);
    }
    groups.push(...group(loose, LIMITS.pressTolerance / 2));
    return groups.map(members => {
      const named = members.filter(exact), votes = new Map();
      for (const pointer of named.length ? named : members) {
        const second = Math.round(pointer.destination);
        votes.set(second, (votes.get(second) || 0) + vote(pointer));
      }
      const end = Math.min(duration, [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
      const usable = members.filter(p => end - p.time >= LIMITS.minSeconds).sort((a, b) => a.time - b.time);
      if (!usable.length) return null;
      const { start, burst } = startFromComments(usable);
      const arrivals = signals.arrivals.filter(arrival => arrival.destination !== undefined
        ? Math.abs(arrival.destination - end) <= 4 && arrival.time >= end - 5 && arrival.time <= end + 40
        : arrival.time >= end - 2 && arrival.time <= end + 10).length;
      return { start, end, burst, count: members.length, arrivals,
        cues: [...new Set(members.filter(p => p.cue).map(p => p.cue))], cueCount: members.filter(p => p.cue).length,
        references: members.slice(0, 6).map(p => ({ time: p.time, text: p.text.slice(0, 60) })) };
    }).filter(Boolean);
  }

  // === Subtitles: commercial anchors and pitch-likeness ===

  // DECISIVE phrases name a transaction, an offer or a sponsor: in reviewed
  // transcripts they occur almost only inside sponsor reads. STRONG phrases
  // are common there but also appear in ordinary speech. A link or a pinned
  // comment alone is how tutorials share resources, so routing is only
  // decisive next to something to buy or claim. Everyday words such as 免费,
  // 搜索, 推荐 or 下载 are deliberately absent (issue #14).
  const ROUTE = '评论区|置顶|蓝链|链接|简介|下方';
  const GOODS = '领取|领券|领个|领张|领一|领红包|领福利|领优惠|可领|能领|去领|来领|优惠券|下单|购买|抢购|开抢|优惠|福利|红包|同款|补贴';
  const DECISIVE = [
    new RegExp(`(?:${ROUTE}).{0,12}(?:${GOODS})|(?:${GOODS}).{0,12}(?:${ROUTE})|蓝链`),
    /领券|优惠券|优惠码|折扣码|(?:大额|专属|隐藏|无门槛)(?:的)?(?:优惠|福利|券|红包|价)|(?:直达|活动|主|分|大促).{0,6}会场|百亿补贴/,
    // Guarded against look-alikes: 确保价格, 物质保障, 到底价值.
    /运费险|(?<!确)保价(?![格值])|(?:七|7)天无理由|无理由退|(?<!物)质保(?!障)|上门回收|验机报告|旗舰店|正品保障|假一赔/,
    /抄底价|(?<!到)底价(?![值格])|原价\d|立减|满减|\d+(?:元|块)(?:就能|即可|拿下|到手|包邮)/,
    /(?:本期|本视频|这期|本节目|本集|今天的?).{0,10}(?:由|是).{0,24}(?:赞助|冠名|特约)|感谢.{0,24}(?:赞助|冠名|金主|甲方)|推广位|sponsoredby/
  ];
  const STRONG = [
    /置顶(?:的)?(?:链接|评论)|评论区(?:置顶|的?链接)|链接.{0,6}(?:简介|描述|评论区|下方)|(?:视频|简介|屏幕|描述|下方).{0,6}(?:链接|二维码)|(?:描述|说明)(?:中|下方|里).{0,6}链接/,
    /到手|划算|实惠|包邮|秒杀|大促|抄底|以旧换新|换新补贴|薅羊毛|闭眼(?:入|冲|买)|(?:别|不要|千万别|千万不要)错过/,
    /(?:有需要|需要|感兴趣|想要|心动|喜欢)的(?:朋友|小伙伴|兄弟|家人|同学|宝子|观众|粉丝|话)?们?.{0,8}(?:可以|不妨|赶紧|快|千万|直接|就|去|别)|(?:给|向|跟)(?:大家|兄弟们|各位|你们|家人们).{0,4}(?:推荐|安利|介绍|种草)|强烈推荐/,
    /(?:现在|立即|赶紧|赶快|抓紧|直接|一键|快去|快来|马上).{0,6}(?:下单|入手|购买|抢购|领取|领券|下载|预约|冲|拿下|试试|体验|去看看)|(?:搜索?|搜).{0,12}(?:领|直达|会场|活动|就能|即可|口令)/,
    /(?:只要|仅需|只需|不到|才)\d+(?:\.\d+)?(?:多)?(?:元|块|毛)|赞助商|由.{1,20}赞助|感谢.{1,24}(?:对|对于).{0,10}(?:本期|节目|视频|频道).{0,8}支持|sponsor|coupon|discount|promocode/
  ];
  // 别 inside 特别/识别 is not a prohibition ("特别是现在下单还送运费险").
  const DISCLAIMED = /(?:无|没有|不含|不是|并非|拒绝|没接|零)(?:任何)?(?:广告|赞助|推广|商单|恰饭)|(?:不是|并非|没有).{0,24}(?:赞助|冠名)|(?:不要|(?<![特识区分个辨鉴级类差告离])别|切勿|请勿|禁止|无需|不必|不能|不建议)(?!忘|错过|犹豫|再等).{0,12}(?:点击|下载|购买|下单|领取|领券|扫码)/;
  const compact = text => String(text ?? '').toLowerCase().replace(/\s+/g, '');
  function commercialEvidence(text) {
    // A disclaimer cancels its own clause, not an offer made in the next one.
    const value = compact(text).split(/[。！？!?；;，,]/).filter(clause => !DISCLAIMED.test(clause)).join(''), matched = [];
    if (!value) return { decisive: 0, strong: 0, matched };
    const count = patterns => patterns.reduce((total, pattern) => {
      const match = value.match(pattern);
      if (match) matched.push(match[0]);
      return total + (match ? 1 : 0);
    }, 0);
    return { decisive: count(DECISIVE), strong: count(STRONG), matched };
  }

  // Features shared with the training script on test-branch: adjacent CJK
  // character pairs and Latin words. Digits are dropped so prices do not leak.
  function lineFeatures(text) {
    const features = new Set();
    for (const part of String(text ?? '').toLowerCase().replace(/[^一-鿿a-z0-9]+/g, ' ').split(' ')) {
      if (!part) continue;
      for (const word of part.match(/[a-z]{3,}/g) || []) features.add(word);
      for (const run of part.replace(/[a-z0-9]+/g, ' ').split(' ')) {
        for (let i = 0; i + 2 <= run.length; i++) features.add(run.slice(i, i + 2));
      }
    }
    return features;
  }
  const decoded = new WeakMap();
  function decodeModel(model) {
    if (!model || typeof model !== 'object') return null;
    if (decoded.has(model)) return decoded.get(model);
    const weights = new Map(), unit = Number(model.unit) || 1;
    for (const [weight, pairs] of Object.entries(model.pairs || {})) {
      for (let i = 0; i + 2 <= pairs.length; i += 2) weights.set(pairs.slice(i, i + 2), weight * unit);
    }
    for (const [word, weight] of Object.entries(model.words || {})) weights.set(word, weight * unit);
    const table = { bias: Number(model.bias) || 0, weights };
    decoded.set(model, table);
    return table;
  }
  // Positive when a line reads like part of a sponsor pitch. The table's
  // contribution is clipped so that one unusual line can neither open nor
  // close a passage on its own; a commercial phrase always counts. Without a
  // table every other line is neutral-to-negative and passages stay at their
  // commercial phrases.
  function pitchScore(text, evidence, table) {
    let logit = -2;
    if (table) {
      logit = table.bias;
      for (const feature of lineFeatures(text)) logit += table.weights.get(feature) || 0;
    }
    return Math.max(-4, Math.min(4, logit)) + 0.3 + (evidence.decisive ? 3 : 0) + (evidence.strong ? 1.5 : 0);
  }
  function scoreLines(subtitles, duration, model) {
    const table = decodeModel(model);
    return (Array.isArray(subtitles) ? subtitles : []).filter(line => line && Number.isFinite(line.from)
      && Number.isFinite(line.to) && line.from >= 0 && line.to > line.from && line.from < duration
      && typeof line.content === 'string')
      .map(line => ({ from: line.from, to: Math.min(line.to, duration), content: line.content }))
      .sort((a, b) => a.from - b.from || a.to - b.to)
      .map((line, index, all) => {
        const evidence = commercialEvidence(line.content), next = all[index + 1];
        // Subtitle wrapping can split one instruction over two rows
        // ("评论区置顶链接" / "领取专属优惠券"): read them together once.
        if (next && next.from - line.to <= LIMITS.wrapSeconds) {
          const joined = commercialEvidence(line.content + next.content), alone = commercialEvidence(next.content);
          if (joined.decisive > evidence.decisive + alone.decisive) {
            evidence.decisive += joined.decisive - evidence.decisive - alone.decisive;
            evidence.matched.push(...joined.matched.filter(text => !evidence.matched.includes(text) && !alone.matched.includes(text)));
          }
        }
        return { ...line, index, ...evidence, score: pitchScore(line.content, evidence, table) };
      });
  }
  // Extend while the running pitch score keeps reaching new highs; stop once
  // it has fallen `patience` below zero. Returns the index of the best extent.
  function grow(lines, from, step, withinLimit, patience) {
    let best = 0, edge = from, sum = 0;
    for (let i = from + step; i >= 0 && i < lines.length && withinLimit(lines[i]); i += step) {
      sum += lines[i].score;
      if (sum > best) { best = sum; edge = i; }
      if (sum < -patience) break;
    }
    return edge;
  }
  function commercialBlocks(lines) {
    const groups = [];
    for (const anchor of lines.filter(line => line.decisive + line.strong > 0)) {
      const group = groups.at(-1);
      if (group && anchor.from - group.at(-1).to <= LIMITS.anchorGapSeconds) group.push(anchor);
      else groups.push([anchor]);
    }
    const blocks = [];
    for (const group of groups) {
      const decisive = group.reduce((total, line) => total + line.decisive, 0);
      // A lone "划算" or "推荐给大家" is ordinary speech; require a decisive phrase.
      if (!decisive) continue;
      const first = group[0], last = group.at(-1);
      blocks.push({
        first: grow(lines, first.index, -1, line => first.from - line.from <= LIMITS.growBackSeconds, 8),
        last: grow(lines, last.index, 1, line => line.to - last.to <= LIMITS.growForwardSeconds, 4),
        decisive, strong: group.reduce((total, line) => total + line.strong, 0), lastAnchorEnd: last.to,
        anchors: group.length,
        matched: [...new Set(group.flatMap(line => line.matched))]
      });
    }
    blocks.sort((a, b) => a.first - b.first);
    const merged = [];
    for (const block of blocks) {
      const previous = merged.at(-1);
      if (previous && block.first <= previous.last + 1) {
        previous.last = Math.max(previous.last, block.last);
        previous.decisive += block.decisive; previous.strong += block.strong; previous.anchors += block.anchors;
        previous.lastAnchorEnd = Math.max(previous.lastAnchorEnd, block.lastAnchorEnd);
        previous.matched = [...new Set([...previous.matched, ...block.matched])];
      } else merged.push({ ...block });
    }
    return merged;
  }

  // === Proposals ===

  // Reviewed ad starts sit on subtitle line starts; a comment lands mid-line.
  // A comment posted during silence keeps its own time: the previous sentence
  // had already finished.
  function lineIndexAt(time, lines) {
    return lines.findIndex(line => line.from <= time + 0.3 && line.to > time);
  }
  // Where the comments say the ad begins. A single comment lands a little
  // after the first sentence, so back up to the start of that subtitle line.
  // A burst already begins early (some viewers post in anticipation) and keeps
  // its own time. "恭喜接广" a moment before the first timestamp is the same
  // viewers noticing the ad sooner.
  function proposedStart(cluster, lines, signals) {
    const lead = signals.adReactions.find(reaction => reaction.time < cluster.start
      && reaction.time >= cluster.start - LIMITS.reactionLeadSeconds);
    const time = lead ? lead.time : cluster.start, at = lineIndexAt(time, lines);
    if (at < 0 || (!lead && cluster.burst)) return { time, kind: 'time-instruction' };
    return { time: lines[at].from, kind: 'subtitle-at-time-instruction' };
  }
  function pointerProposals(signals, lines, duration) {
    const proposals = [];
    const clusters = pointerClusters(signals, duration);
    for (const cluster of clusters) {
      const from = proposedStart(cluster, lines, signals), start = from.time, end = cluster.end;
      if (end - start < LIMITS.minSeconds) continue;
      const body = lines.filter(line => line.from < end && line.to > start);
      const decisive = body.reduce((total, line) => total + line.decisive, 0);
      const strong = body.reduce((total, line) => total + line.strong, 0);
      // Reactions gather where the ad begins; over a long span a stray "广告"
      // somewhere proves nothing.
      const adReactions = new Set(signals.adReactions.filter(reaction => reaction.time >= cluster.start - 3
        && reaction.time <= Math.min(end + 5, cluster.start + LIMITS.reactionSeconds)).map(reaction => reaction.text)).size;
      // Independent kinds of support. An explicit jump word counts double; a
      // repeated bare timestamp is not several witnesses.
      const support = (cluster.cueCount ? 2 : 0) + Math.min(3, cluster.count - 1) + Math.min(2, cluster.arrivals)
        + Math.min(2, adReactions) + Math.min(3, decisive) + (strong >= 2 ? 1 : 0);
      // The first minute draws "skip the intro" comments: require a sign of an ad,
      // and treat a long jump from the opening seconds as navigation.
      if (cluster.start < LIMITS.introSeconds && adReactions + decisive === 0) continue;
      const opening = cluster.start < LIMITS.openingSeconds;
      if (opening && end - start > LIMITS.openingMaxSeconds) continue;
      // A transcript that covers the jump and says nothing commercial raises
      // the bar, unless viewers (the instruction itself included: "跳过广告
      // 5:30") call it an ad.
      const transcriptSilent = body.length >= 2 && decisive + strong === 0 && adReactions === 0;
      const supported = support >= (transcriptSilent ? 4 : 3) || (cluster.count >= 3 && !opening);
      // Without a transcript one explicit instruction is all a viewer can
      // offer: keep it visible, but never seek on it unprompted.
      const unverifiable = cluster.cueCount > 0 && body.length === 0 && !opening;
      if (!supported && !unverifiable) continue;
      const corroborated = cluster.arrivals > 0 || adReactions > 0 || decisive > 0 || cluster.count >= 2;
      const auto = cluster.cueCount > 0 && corroborated && support >= 3 && !transcriptSilent && !opening;
      proposals.push({ start, end, source: 'danmaku-time', requiresConfirmation: !auto,
        confidence: auto ? 'high' : 'low',
        reason: cluster.cueCount ? 'explicit-danmaku-skip' : 'corroborated-time-reference',
        matchedKeywords: [...cluster.cues, ...(adReactions ? ['广告'] : [])],
        support, referenceCount: cluster.count, explicitCount: cluster.cueCount,
        arrivalCount: cluster.arrivals, adReactionCount: adReactions,
        earlyAdEvidence: cluster.start < LIMITS.introSeconds,
        boundaryEvidence: { start: { kind: from.kind, time: start, commentTime: cluster.start },
          end: { kind: 'danmaku-destination', time: end }, timeReferences: cluster.references } });
    }
    // One video rarely carries more than three sponsor breaks. A longer list of
    // jump targets is a table of contents: leave single comments to the viewer.
    if (proposals.length > LIMITS.breaksPerVideo) {
      for (const proposal of proposals) {
        if (proposal.referenceCount < 2 && !proposal.arrivalCount) Object.assign(proposal, { requiresConfirmation: true, confidence: 'low' });
      }
    }
    return proposals;
  }
  function blockProposals(signals, lines, duration) {
    const proposals = [];
    for (const block of commercialBlocks(lines)) {
      const start = lines[block.first].from;
      let end = lines[block.last].to, endKind = 'last-pitch-line';
      // "感谢 x 分 xx 侠" and "回来了" burst at the exact return to the video.
      const arrivals = signals.arrivals.filter(arrival => arrival.time >= block.lastAnchorEnd - 2 && arrival.time <= end + 12);
      const burst = arrivals.find(arrival => arrivals.filter(other => other.time >= arrival.time
        && other.time <= arrival.time + 5).length >= 2);
      if (burst) {
        const target = burst.time - 0.5;
        const line = lines.filter(candidate => candidate.to >= block.lastAnchorEnd - 0.5 && Math.abs(candidate.to - target) <= 3)
          .sort((a, b) => Math.abs(a.to - target) - Math.abs(b.to - target))[0];
        if (line) { end = line.to; endKind = 'danmaku-arrival'; }
      }
      end = Math.min(end, duration);
      // One commercial sentence is a credit ("感谢某品牌的赞助"), not a read:
      // require a second commercial line or a clearly pitch-like surrounding.
      const around = lines.slice(block.first, block.last + 1).filter(line => line.decisive + line.strong === 0)
        .reduce((total, line) => total + line.score, 0);
      if (block.anchors < 2 && around < LIMITS.creditBodyScore) continue;
      // A few seconds can still be an ad: a recap dense with commercial
      // phrases, or one decisive line in the sign-off before the video ends.
      const dense = block.decisive >= 2 || block.decisive + block.strong >= 3;
      const signOff = duration - end <= LIMITS.signOffSeconds;
      if (end - start < LIMITS.minBlockSeconds && !((dense || signOff) && end - start >= 3)) continue;
      proposals.push({ start, end, source: 'subtitles', requiresConfirmation: true, confidence: 'low',
        reason: 'commercial-subtitle-block', matchedKeywords: block.matched.slice(0, 24),
        support: block.decisive * 2 + block.strong, decisiveCount: block.decisive, strongCount: block.strong,
        boundaryEvidence: { start: { kind: 'first-pitch-line', time: start }, end: { kind: endKind, time: end } } });
    }
    return proposals;
  }

  function detect(input, options = {}) {
    if (!input || !Number.isFinite(input.duration) || input.duration <= 0) return [];
    const signals = collectSignals(input.danmaku), lines = scoreLines(input.subtitles, input.duration, options.model);
    // An explicit, corroborated instruction outranks any number of bare timestamps.
    // When viewers named different seconds, the destination with more witnesses wins.
    const witnesses = proposal => proposal.referenceCount + proposal.arrivalCount;
    const pointers = pointerProposals(signals, lines, input.duration)
      .sort((a, b) => Number(a.requiresConfirmation) - Number(b.requiresConfirmation) || b.support - a.support
        || witnesses(b) - witnesses(a));
    const blocks = blockProposals(signals, lines, input.duration).sort((a, b) => b.support - a.support);
    const accepted = [];
    for (const proposal of pointers) if (!accepted.some(other => overlaps(other, proposal))) accepted.push(proposal);
    for (const block of blocks) {
      const pointer = accepted.find(other => overlaps(other, block));
      if (!pointer) { accepted.push(block); continue; }
      if (pointer.source !== 'danmaku-time') continue;
      // The viewers' own start and destination stand; the block corroborates.
      pointer.matchedKeywords = [...new Set([...pointer.matchedKeywords, ...block.matchedKeywords])].slice(0, 24);
    }
    return accepted.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  return { LIMITS, parseClock, readComment, collectSignals, pointerClusters, commercialEvidence, lineFeatures,
    scoreLines, commercialBlocks, detect };
});

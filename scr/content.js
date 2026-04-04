// == Bilibili 广告跳过助手 ==

// === Global State ===
const DEBUG = false; // Set to false to disable all console logging
function log(...args) { if (DEBUG) console.log('[BiliSmartSkip]', ...args); }

let SKIP_MODE = 'manual';  // 'auto' | 'manual'
let skipped = false;       // Flag to indicate whether the ad has been skipped
let isBtnAdd = false;      // Whether the skip button has been inserted
let currentVideo = null;   // Current video element
let currentAdSkipHandler = null;  // Current timeupdate event handler
let isSuspiciousAd = false; // Whether the ad was detected using keyword matching (suspicious)
let countdownTimer = null; // Countdown timer for skipping ads
const COUNTDOWN = 5; // Countdown duration in seconds

// === Ad Keyword Dictionaries ===
const AD_START_KEYWORDS = ["广告开始", "开始恰饭", "恰饭开始", "广告来了", "开始推广", "金主来了", "广告时间"];
const AD_END_KEYWORDS = ["广告结束", "欢迎回来", "恰饭结束", "回来了", "广告完了", "正片开始", "回归正片"];
const AD_GENERAL_KEYWORDS = ["已买", "购买", "购入", "接广", "广告", "广子", "感谢金主", "买了", "恭喜接广", "下单", "期待发货", "付款", "商单", "买买买", "恰饭", "恰上饭"];
const AD_CONTENT_KEYWORDS = [
  // Sponsorship signals
  "赞助", "冠名", "推广", "合作", "商单",
  // CTA (call-to-action)
  "评论区", "蓝链", "点击", "链接", "二维码", "口令",
  "领取", "领券", "优惠券", "优惠码", "兑换码", "折扣码",
  "下单", "购买", "入手", "抢购",
  // Promotional language
  "优惠", "折扣", "限时", "福利", "免费", "首充",
  "专属", "新用户", "官方旗舰", "性价比",
  // Product pitch
  "推荐给大家", "安利", "种草", "体验装",
  // Platform/download
  "下载", "注册", "搜索", "应用商店"
];

let buttonEventHandlers = {
  click: null,
  mouseenter: null,
  mouseleave: null,
  play: null,
  pause: null
}

// === Style the skip button ===
const btn = document.createElement('button');
Object.assign(btn.style, {
  position: 'absolute',
  right: '24px',
  bottom: '10%',
  padding: '8px 16px',
  background: 'rgba(0, 0, 0, 0.7)',
  color: '#fff',
  border: '1px solid rgba(255, 255, 255, 0.3)',
  borderRadius: '20px',
  fontSize: '14px',
  fontWeight: 'bold',
  cursor: 'pointer',
  zIndex: 999999,
  transition: 'background 0.3s, transform 0.2s',
});
btn.addEventListener('mouseenter', () => {
  btn.style.background = 'rgba(0, 0, 0, 0.85)';
  btn.style.transform = 'scale(1.05)';
});
btn.addEventListener('mouseleave', () => {
  btn.style.background = 'rgba(0, 0, 0, 0.7)';
  btn.style.transform = 'scale(1)';
});

// === Initialize plugin ===
function init() {
  console.log("Bilibili 广告跳过助手已启动");

  chrome.storage.local.get(['skipMode'], result => {
    SKIP_MODE = result.skipMode || 'manual';
    // console.log("当前跳过模式：", SKIP_MODE);
    mainLogic();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.skipMode) {
      SKIP_MODE = changes.skipMode.newValue;
      // console.log("跳过模式已更改为：", SKIP_MODE);
    }
  });

  observeURLChange();
}

// === Main logic entry point ===
function mainLogic() {
  cleanUp();
  (async () => {
    const seg = await getSkipSegment();
    if (!seg) return;
    waitForVideo(() => attachSkipper(seg));
  })();
}

// === Clean up previous video state ===
function cleanUp() {
  skipped = false;
  isBtnAdd = false;

  if (btn.parentElement) btn.remove();

  if (currentVideo && currentAdSkipHandler) {
    currentVideo.removeEventListener('timeupdate', currentAdSkipHandler);
  }

  if (countdownTimer){
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  isSuspiciousAd = false;

  currentVideo = null;
  currentAdSkipHandler = null;
  // console.log("清理完成");
}

// === Observe URL changes (for SPA routing) ===
function observeURLChange() {
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // console.log("URL changed:", lastUrl);
      mainLogic();
    }
  });
  observer.observe(document, { subtree: true, childList: true });
}

// === Wait for video element to load ===
function waitForVideo(onVideoReady) {
  const videoElement = document.querySelector('video');
  if (videoElement) {
    currentVideo = videoElement;
    return onVideoReady();
  }

  const obs = new MutationObserver(() => {
    const video = document.querySelector('video');
    if (video) {
      obs.disconnect();
      currentVideo = video;
      onVideoReady();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// === Get ad segment timestamps (multi-signal pipeline) ===
async function getSkipSegment() {
  const bvid = getBvidFromPage();
  log('bvid:', bvid);
  if (!bvid) return null;

  // Phase 1: Fetch video info (cid, description, duration)
  const videoInfo = await fetchVideoInfo(bvid);
  log('videoInfo:', videoInfo);
  if (!videoInfo || !videoInfo.cid) return null;

  const { cid, desc, duration } = videoInfo;

  // Phase 2: Fetch player info and danmaku in parallel
  const [playerInfo, danmaku] = await Promise.all([
    fetchPlayerInfo(bvid, cid),
    fetchDanmakuWithTime(cid)
  ]);

  const { viewPoints, subtitles } = playerInfo;
  log('viewPoints:', viewPoints);
  log('subtitles available:', subtitles.length);
  log('danmaku count:', danmaku.length);
  let adTimes = null;

  // 1. Chapter markers (highest confidence)
  adTimes = detectFromChapters(viewPoints);
  log('1.chapters result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    log('HIT chapters:', adTimes);
    isSuspiciousAd = false;
    return adTimes;
  }

  // 2. Description timestamps (high confidence)
  adTimes = detectFromDescription(desc, duration);
  log('2.description result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    log('HIT description:', adTimes);
    isSuspiciousAd = false;
    return adTimes;
  }

  // 3. Subtitle content analysis (high confidence, lazy-fetch)
  if (subtitles.length > 0) {
    const zhSub = subtitles.find(s => s.lan === 'zh-CN' || s.lan === 'ai-zh');
    const chosenSub = zhSub || subtitles[0];
    log('fetching subtitle:', chosenSub.lan, chosenSub.subtitle_url);
    const subtitleLines = await fetchSubtitleBody(chosenSub.subtitle_url);
    log('subtitle lines:', subtitleLines.length);
    adTimes = detectFromSubtitles(subtitleLines, danmaku);
    log('3.subtitles result:', adTimes);
    if (adTimes && checkAdSegVaild(adTimes, duration)) {
      log('HIT subtitles:', adTimes);
      isSuspiciousAd = false;
      return adTimes;
    }
  } else {
    log('3.subtitles: none available');
  }

  // 4. Danmaku time-format parsing (medium confidence, existing)
  adTimes = findAdTimestamps(danmaku);
  log('4.danmaku-time result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    log('HIT danmaku-time:', adTimes);
    isSuspiciousAd = false;
    return adTimes;
  }

  // 5. Danmaku keyword matching (low confidence, improved)
  isSuspiciousAd = true;
  adTimes = getAdTimeByKeywords(danmaku);
  log('5.danmaku-keywords result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    log('HIT danmaku-keywords (suspicious):', adTimes);
    return adTimes;
  }

  log('No ad detected.');
  return null;
}

function checkAdSegVaild(adTimes, duration) {
  if (!adTimes || adTimes.start == null || adTimes.end == null) return false;
  if (adTimes.start < 60) return false;
  if (adTimes.end - adTimes.start >= 180) return false;
  if (adTimes.end - adTimes.start < 10) return false;
  if (duration > 0 && adTimes.end >= duration - 20) return false;
  return true;
}

// === Keyword-based ad time detection (improved with directional keywords) ===
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

  // Try directional: start-cluster followed by end-cluster
  const startCluster = findCluster(startSignals, CLUSTER_WINDOW, MIN_CLUSTER_SIZE);
  const endCluster = findCluster(endSignals, CLUSTER_WINDOW, MIN_CLUSTER_SIZE);

  if (startCluster && endCluster && endCluster.center > startCluster.center) {
    const adStart = startCluster.start;
    const adEnd = endCluster.end;
    if (adEnd - adStart >= 30 && adEnd - adStart <= 180) {
      return { start: adStart, end: adEnd };
    }
  }

  // Fallback: general keywords with sliding window
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

// === Data fetching ===
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

async function fetchDanmakuWithTime(cid) {
  // console.log(`Fetching danmaku XML for CID: ${cid}`);
  const url = `https://comment.bilibili.com/${cid}.xml`;
  const res = await fetch(url);
  const text = await res.text();
  const danmakuXML = new DOMParser().parseFromString(text, 'text/xml');
  const danmaku = Array.from(danmakuXML.getElementsByTagName("d")).map(d => ({
    time: parseFloat(d.getAttribute("p").split(",")[0]),
    textContent: d.textContent
  }));
  danmaku.sort((a, b) => a.time - b.time);
  return danmaku;
}

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

  // Score each line and collect hits
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
  // In Chinese ads, phrases like "评论区有专属优惠" always come at the END of the ad
  // Use danmaku signals to find a more precise ad-start
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

    // Check ad keywords ("广告", "恰饭", etc.)
    for (const kw of allAdKeywords) {
      if (text.includes(kw)) { isAdSignal = true; break; }
    }

    // Check time-format references close to adEnd ("705工程", "7:05", etc.)
    // People post these DURING the ad → their danmaku time is within the ad segment
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

// === Parse ad timestamps from danmaku ===
function findAdTimestamps(danmaku) {
  let timePairs = [];

  danmaku.forEach(d => {
    const start = d.time;
    const text = d.textContent;
    const endInfo = extractTimeFromText(text);

    if (endInfo && !isNaN(start)) {
      // console.log(`广告开始：${formatTime(start)}s，结束：${formatTime(endInfo.time)}s，内容："${text}"`);
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

  // console.log(`最终判定：广告开始于 ${formatTime(startTime)}，结束于 ${formatTime(endTime)}`);
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

function zhNumToInt(str) {
  if (/^\d+$/.test(str)) return Number(str);
  const map = { 零:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  if (str === '十') return 10;
  if (str.includes('十')) {
    const [left, right] = str.split('十');
    return (left ? map[left] : 1) * 10 + (right ? map[right] : 0);
  }
  return map[str];
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// === Bind ad skipping logic ===
function attachSkipper({ start, end }) {
  log(`attachSkipper: ${formatTime(start)} → ${formatTime(end)}, mode=${SKIP_MODE}, suspicious=${isSuspiciousAd}`);
  currentAdSkipHandler = () => {
    const t = currentVideo.currentTime;
    if (SKIP_MODE === 'auto' && !skipped && !isSuspiciousAd) {
      if (t >= start && t < end) {
        skipToEnd(end);
      }
    } else {
      if (!isBtnAdd && t >= start && t < end) {
        addSkipBtn(end);
      } else if (t < start - 0.2 || t > end + 0.2) {
        btnCleanUp();
        isBtnAdd = false;
      }
    }
  };

  currentVideo.addEventListener('timeupdate', currentAdSkipHandler);
}

function skipToEnd(end) {
  // console.log(`跳过广告到 ${formatTime(end)}`);
  currentVideo.currentTime = end + 0.05;
  setTimeout(() => {
    currentVideo.play().catch(err => console.warn('Autoplay failed:', err));
  }, 300);
  skipped = true;
  btnCleanUp();
  isBtnAdd = false;
}

function btnCleanUp(){
  btn.remove();
  if (countdownTimer){
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  cleanUpBtnEvents();
}

function cleanUpBtnEvents(){
  if (buttonEventHandlers.click){
    btn.removeEventListener('click', buttonEventHandlers.click);
    buttonEventHandlers.click = null;
  }
  if (buttonEventHandlers.mouseenter){
    btn.removeEventListener('mouseenter', buttonEventHandlers.mouseenter);
    buttonEventHandlers.mouseenter = null;
  }
  if (buttonEventHandlers.mouseleave){
    btn.removeEventListener('mouseleave', buttonEventHandlers.mouseleave);
    buttonEventHandlers.mouseleave = null;
  }
  if (buttonEventHandlers.play){
    currentVideo.removeEventListener('play', buttonEventHandlers.play);
    buttonEventHandlers.play = null;
  }
  if (buttonEventHandlers.pause){
    currentVideo.removeEventListener('pause', buttonEventHandlers.pause);
    buttonEventHandlers.pause = null;
  }
}

function possibleAdCountdown(counter){
  let countdown = counter;
  btn.textContent = `跳过疑似广告 (${countdown})`;

  const countdownStart = () => {
    countdownTimer = setInterval(() => {
      countdown--;
      if (countdown == -1){
        btnCleanUp();
        return;
      }else if (countdown > 0){
        btn.textContent = `跳过疑似广告 (${countdown})`;
      }

    }, 1000);
  };

  buttonEventHandlers.mouseenter = () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };
  btn.addEventListener('mouseenter', buttonEventHandlers.mouseenter);
  buttonEventHandlers.mouseleave = () => {
    if (!countdownTimer && countdown > 0) {
      countdownStart();
    }
  };
  btn.addEventListener('mouseleave', buttonEventHandlers.mouseleave);
  currentVideo.addEventListener('play', () => {
    if (!countdownTimer && countdown > 0) {
      countdownStart();
    }
  });
  buttonEventHandlers.play = () => {
    if (!countdownTimer && countdown > 0) {
      countdownStart();
    }
  };
  currentVideo.addEventListener('play', buttonEventHandlers.play);
  buttonEventHandlers.pause = () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };
  currentVideo.addEventListener('pause', buttonEventHandlers.pause);
  countdownStart();
}

function addSkipBtn(end) {
  log('addSkipBtn called, end=', formatTime(end));
  cleanUpBtnEvents();
  if (!isSuspiciousAd){
    btn.textContent = '跳过广告';
  }else {
    possibleAdCountdown(COUNTDOWN);
  }

  const container = currentVideo.parentElement;
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  buttonEventHandlers.click = () => skipToEnd(end);
  btn.addEventListener('click', buttonEventHandlers.click);
  container.appendChild(btn);
  isBtnAdd = true;
}

init();

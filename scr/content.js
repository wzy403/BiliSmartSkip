// == Bilibili 广告跳过助手 ==

// === Global State ===
let SKIP_MODE = 'manual';  // 'auto' | 'manual'
let skipped = false;       // Flag to indicate whether the ad has been skipped
let isBtnAdd = false;      // Whether the skip button has been inserted
let currentVideo = null;   // Current video element
let currentAdSkipHandler = null;  // Current timeupdate event handler
let isSuspiciousAd = false; // Whether the ad was detected using keyword matching (suspicious)
let countdownTimer = null; // Countdown timer for skipping ads
const COUNTDOWN = 5; // Countdown duration in seconds

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

// === Get ad segment timestamps ===
async function getSkipSegment() {
  const cid = await getCidFromPage();
  if (!cid) return null;
  const danmaku = await fetchDanmakuWithTime(cid);
  let adTimes = findAdTimestamps(danmaku);
  if (!adTimes) {
    isSuspiciousAd = true;
    adTimes = getAdTimeByKeywords(danmaku);
  }

  if (!checkAdSegVaild(adTimes, danmaku)) {
    // console.log("未检测到广告相关弹幕，放弃跳过");
    return null;
  }

  return adTimes;
}

function checkAdSegVaild(adTimes, danmaku) {
  if (!adTimes || adTimes.start < 60) return false;

  if (adTimes.end - adTimes.start >= 180 || adTimes.end >= danmaku[danmaku.length - 1].time - 20) {
    return false;
  }

  return true;
}

// === Keyword-based ad time detection (fallback) ===
function getAdTimeByKeywords(danmaku) {
  const filterSet = ["已买","购买","购入","接广","广告","广子","欢迎回来","感谢金主","买了","恭喜接广","下单","期待发货","付款"];
  const startTime = 0, endTime = danmaku[danmaku.length - 1].time;
  let possibleAdTimes = []
  danmaku.forEach(d => {
    const time = d.time;
    if (time >= startTime && time <= endTime) {
      const text = d.textContent;
      for (const f of filterSet) {
        if (text.includes(f)) {
          // console.log(`广告相关弹幕：${formatTime(time)}s - "${text}"`);
          possibleAdTimes.push(time);
        }
      }
    }
  });

  const AD_MAX_DURATION = 100, AD_MIN_DURATION = 30;
  let i = 0, j = 1;
  let adStart, adEnd;
  while (i < possibleAdTimes.length && j < possibleAdTimes.length) {
    const start = possibleAdTimes[i];
    const end = possibleAdTimes[j];

    if (end - start > AD_MAX_DURATION) {
      if (adStart) {
        break;
      }
      if (j - 1 == i){
        j++;
      }
      i++;
    }else {
      if(end - start >= AD_MIN_DURATION) {
        adStart = start;
        adEnd = end;
      }
      j++;
    }
  }

  // console.log("possibleAdTimes:", possibleAdTimes);

  if (adStart) {
    return { start: adStart - 5, end: adEnd };
  }
  return null;
}

// === Fetch danmaku-related data ===
async function getCidFromPage() {
  const bvid = window.location.pathname.split('/')[2];
  const res = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
  const data = await res.json();
  return data.data[0]?.cid || null;
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

// === Parse ad timestamps from danmaku ===
function findAdTimestamps(danmaku) {
  let timePairs = [];

  danmaku.forEach(d => {
    const start = d.time;
    const text = d.textContent;
    const endInfo = extractTimeFromText(text);

    if (endInfo && !isNaN(start)) {
      // console.log(`广告开始：${formatTime(start)}s，结束：${formatTime(endInfo.time)}s，内容：“${text}”`);
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

  // const match3 = text.match(/(\d+(?:[\.\,，]\d+))\s*(分钟|分|min|m)?/i);
  // if (match3 && parseFloat(match3[1]) < 30) {
  //   return { time: Math.floor(parseFloat(match3[1]) * 60), confidence: 0.3 };
  // }

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
  // console.log(`将在 ${formatTime(start)} → ${formatTime(end)} 自动/手动跳过广告`);
  // console.log('is suspicious ad:', isSuspiciousAd);
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
        btn.remove();
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
  if (isBtnAdd) {
    btn.remove();
    isBtnAdd = false;
    if (countdownTimer){
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
}

function addSkipBtn(end) {
  if (!isSuspiciousAd){
    btn.textContent = '跳过广告';
  }else {
    let countdown = COUNTDOWN;
    btn.textContent = `跳过疑似广告 (${countdown})`;
    countdownTimer = setInterval(() => {
      countdown--;
      if (countdown == -1){
        clearInterval(countdownTimer);
        countdownTimer = null;
        btn.remove();

        return;
      }else if (countdown > 0){
        btn.textContent = `跳过疑似广告 (${countdown})`;
      }

    }, 1000)
  }

  const container = currentVideo.parentElement;
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  btn.addEventListener('click', () => skipToEnd(end));
  container.appendChild(btn);
  isBtnAdd = true;
}

init();

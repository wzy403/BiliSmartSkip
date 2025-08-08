let SKIP_MODE = 'manual';   // 'auto' | 'manual'
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.skipMode) {
    SKIP_MODE = changes.skipMode.newValue;
    console.log("跳过模式已更改为：", SKIP_MODE);
  }
});
let skipped = false;        // 避免反复 seek 死循环
let isBtnAdd = false;
let currentVideo = null;
let currentAdSkipHandler = null;
const btn = document.createElement('button');
Object.assign(btn.style, {
  position: 'absolute',
  right: '24px',
  // bottom: '80px',
  bottom: '10%',
  padding: '8px 16px',
  background: 'rgba(0, 0, 0, 0.7)',    // 半透明黑
  color: '#fff',
  border: '1px solid rgba(255, 255, 255, 0.3)', // 细边框
  borderRadius: '20px',               // 药丸圆角
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

btn.textContent = '跳过广告';

console.log("Bilibili 弹幕广告跳过插件已启动");

// 获取 CID（弹幕ID）
async function getCidFromPage() {
  const bvid = window.location.pathname.split('/')[2];
  console.log("当前视频 BVID:", bvid);
  const videoInfo = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
  const data = await videoInfo.json();
  const cid = data.data[0]?.cid;
  return cid || null;
}

// 拉取弹幕 XML
async function fetchDanmakuXML(cid) {
  console.log("获取弹幕 XML，CID:", cid);
  const url = `https://comment.bilibili.com/${cid}.xml`;
  const response = await fetch(url);
  const text = await response.text();
  return new window.DOMParser().parseFromString(text, "text/xml");
}

function zhNumToInt(str) {
  // 如果本来就是阿拉伯数字，直接返回
  if (/^\d+$/.test(str)) return Number(str);

  const map = { 零:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };

  // 只有 “十” 说明是 10
  if (str === '十') return 10;

  // 包含 “十” 的情况：X十Y / 十Y / X十
  if (str.includes('十')) {
    const [left , right] = str.split('十');
    const tens  = left  ? map[left]  : 1;         // “十七” 没写左边，默认 1×10
    const units = right ? map[right] : 0;         // “三十” 没写右边，默认 +0
    return tens * 10 + units;
  }

  // 个位数
  return map[str];
}

function extractTimeFromText(text) {
  // 1. 格式：4:25 或 04:25
  const match1 = text.match(/(\d{1,2})[:：](\d{2})/);
  if (match1) {
    const min = parseInt(match1[1], 10);
    const sec = parseInt(match1[2], 10);
    return {time: min * 60 + sec, confidence: 1};
  }

  // 2. 格式：4分25秒
  const match2 = text.match(/((?:[一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九]|0?\d))分((?:[一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九]|0?\d{1,2}))秒?/);

  if (match2) {
    const min = zhNumToInt(match2[1]);
    const sec = zhNumToInt(match2[2]);
    return {time: min * 60 + sec, confidence: 1};
  }

  // 4. 格式：4.25 或 3.5 分钟 → 小数分钟
  const match4 = text.match(/(\d+(?:[\.\,，]\d+))\s*(分钟|分|min|m)?/i);
  if (match4) {
    const min = parseFloat(match4[1]);
    if (min < 30) return {time: Math.floor(min * 60), confidence: 0.3};  // 忽略明显无关的大数字
  }

  return null;
}


// 识别含广告的弹幕
function findAdTimestamps(xmlDoc) {
  const danmus = Array.from(xmlDoc.getElementsByTagName("d"));

  const timePairs = []; // 存储广告开始 + 结束时间段

  danmus.forEach(d => {
    const adStartTime = parseFloat(d.getAttribute("p").split(",")[0]);
    const text = d.textContent;

    // 提取用户写的时间点（广告结束）
    const adEndTimeInfo = extractTimeFromText(text);

    if (adEndTimeInfo !== null && !isNaN(adStartTime)) {
      console.log(`广告开始：${adStartTime}s，结束：${adEndTimeInfo.time}s，内容：“${text}”`);
      timePairs.push({
        start: adStartTime,
        end: adEndTimeInfo.time,
        text: text,
        confidence: adEndTimeInfo.confidence
      });
    }
  });

  if (timePairs.length === 0) return [];

  // 按照出现频率找出最多人说的“广告结束时间”
  const endTimeCounts = {};
  timePairs.forEach(p => {
    const rounded = Math.round(p.end); // 可以四舍五入归一
    endTimeCounts[rounded] = (endTimeCounts[rounded] || 0) + p.confidence;
  });

  const predictedEndTime = Object.entries(endTimeCounts).sort((a, b) => b[1] - a[1])[0];

  if (predictedEndTime[1] < 0.9) {
    return []
  }

  // Find the start time and end time
  const PET = parseInt(predictedEndTime[0]);
  let startTime = null;
  let endTime = PET;
  for(const time of timePairs){
    const roundCurrStartTime = Math.round(time.start)
    const roundCurrEndTime = Math.round(time.end);
    if(!startTime && roundCurrEndTime === PET){
      startTime = time.start + 5;
    }else if(roundCurrEndTime === PET && roundCurrStartTime - PET > 0){
      endTime = time.start - 5;
      break;
    }
  }

  if (startTime) {
    console.log(`最终判定：广告开始于 ${formatTime(startTime)}，结束于 ${formatTime(endTime)}`);
    return [startTime, endTime];
  } else {
    return [];
  }
}


function formatTime(seconds) {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ❶ 你现有的逻辑：得到 [start, end]
async function getSkipSegment() { 
  const adTimes = await findAdTimestamps(await fetchDanmakuXML(await getCidFromPage()));
  console.log("获取到的广告时间段:", adTimes);
  return adTimes.length === 2 ? { start: adTimes[0], end: adTimes[1] } : null;
}

function init(){
  chrome.storage.local.get(['skipMode'], result => {
    SKIP_MODE = result.skipMode || 'manual';
    console.log("当前跳过模式：", SKIP_MODE);
    mainLogic();
  });
  observeURLChange();
}

function cleanUp(){
  isBtnAdd = false;
  skipped = false;
  
  if (btn.parentElement) {
    btn.remove();
  }

  if (currentVideo || currentAdSkipHandler) {
    currentVideo.removeEventListener('timeupdate', currentAdSkipHandler);
    currentVideo = null;
    currentAdSkipHandler = null;
  }

  console.log("清理完成，移除所有事件监听和按钮");
}


function mainLogic(){
  cleanUp();
  (async () => {
    const seg = await getSkipSegment();
    if (!seg) return;

    waitForVideo(() => attachSkipper(seg));
  })();
}


function observeURLChange(){
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("URL changed:", lastUrl);
      mainLogic();
    }
  });
  observer.observe(document, { subtree: true, childList: true });
}


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

// 真正的“跳过”逻辑
function attachSkipper({ start, end }) {
  console.log(`将在 ${start.toFixed(1)}s (${formatTime(start)}) → ${end.toFixed(1)}s (${formatTime(end)}) 之间自动跳过`);
  currentAdSkipHandler = () => {
    const t = currentVideo.currentTime;

    // 进入广告区且还没跳过 → 直接把 currentTime 设到结束点
    if (SKIP_MODE === 'auto') {
      if (!skipped && t >= start && t < end) {
        skipToEnd(end);
      }

      // 如果用户拖回去重看，把标记重置，允许再次跳
      if (skipped && t < start - 0.2) {
        skipped = false;
      }

    }else {
      // 进广告区并且按钮还没插入 → 插入
      if (!isBtnAdd && t >= start && t < end) {
        addSkipBtn(end);
      }
      // 用户拖出广告区还没点按钮 → 把按钮收回
      if (btn && (t < start - 0.2 || t > end + 0.2)) {
        btn.remove();
        isBtnAdd = false;
      }
    }
  };

  currentVideo.addEventListener('timeupdate', currentAdSkipHandler);
}

function skipToEnd(end) {
  console.log(`用户点击跳过，空降到 ${formatTime(end)}`);
  currentVideo.currentTime = end + 0.05;
  setTimeout(() => {
    currentVideo.play().catch(err => {
      console.warn('跳过后自动播放失败:', err);
    });
  }, 500);

  skipped = true;
  if (isBtnAdd) {
    btn.remove();
    isBtnAdd = false;
  }
}

function addSkipBtn(end) {
  // 找到能定位的容器（video 父节点一般是 .bpx-player-video-area）
  const container = currentVideo.parentElement;
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  btn.addEventListener('click', () => skipToEnd(end));
  container.appendChild(btn);
  isBtnAdd = true;
}


init();
// == BiliSmartSkip: Main Entry Point ==
// Other modules loaded via manifest.json: constants.js, utils.js, api.js, detectors.js, skipper.js

// === Global State ===
let SKIP_MODE = 'manual';
let SKIP_SHORTCUT = null;
let skipped = false;
let isBtnAdd = false;
let currentVideo = null;
let currentAdSkipHandler = null;
let isSuspiciousAd = false;
let countdownTimer = null;
let currentAdSegment = null;
let keydownHandler = null;
let videoHealthTimer = null;

// === Initialize ===
function init() {
  console.log("Bilibili 广告跳过助手已启动");

  chrome.storage.local.get(['skipMode', 'skipShortcut'], result => {
    SKIP_MODE = result.skipMode || 'manual';
    SKIP_SHORTCUT = result.skipShortcut || null;
    registerShortcutListener();
    mainLogic();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.skipMode) {
        SKIP_MODE = changes.skipMode.newValue;
      }
      if (changes.skipShortcut) {
        SKIP_SHORTCUT = changes.skipShortcut.newValue || null;
        registerShortcutListener();
      }
    }
  });

  observeURLChange();
}

// === Keyboard shortcut listener ===
function registerShortcutListener() {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }

  if (!SKIP_SHORTCUT) return;

  keydownHandler = (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

    if (e.code !== SKIP_SHORTCUT.code) return;
    if (e.ctrlKey !== !!SKIP_SHORTCUT.ctrlKey) return;
    if (e.altKey !== !!SKIP_SHORTCUT.altKey) return;
    if (e.shiftKey !== !!SKIP_SHORTCUT.shiftKey) return;
    if (e.metaKey !== !!SKIP_SHORTCUT.metaKey) return;

    if (!isBtnAdd || !currentAdSegment || skipped) return;

    e.preventDefault();
    e.stopPropagation();
    skipToEnd(currentAdSegment.end);
  };

  document.addEventListener('keydown', keydownHandler);
}

// === Main logic ===
function mainLogic() {
  cleanUp();
  (async () => {
    const seg = await getSkipSegment();
    if (!seg) return;
    currentAdSegment = seg;
    waitForVideo(() => {
      attachSkipper(seg);
      monitorVideoHealth(seg);
    });
  })();
}

// === Lifecycle ===
function cleanUp() {
  skipped = false;
  isBtnAdd = false;
  currentAdSegment = null;

  if (btn.parentElement) btn.remove();

  if (currentVideo && currentAdSkipHandler) {
    currentVideo.removeEventListener('timeupdate', currentAdSkipHandler);
  }

  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  if (videoHealthTimer) {
    clearInterval(videoHealthTimer);
    videoHealthTimer = null;
  }

  isSuspiciousAd = false;
  currentVideo = null;
  currentAdSkipHandler = null;
}

function observeURLChange() {
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      mainLogic();
    }
  });
  observer.observe(document, { subtree: true, childList: true });
}

function waitForVideo(onVideoReady) {
  const videoElement = document.querySelector('video, bwp-video');
  if (videoElement) {
    currentVideo = videoElement;
    return onVideoReady();
  }

  const obs = new MutationObserver(() => {
    const video = document.querySelector('video, bwp-video');
    if (video) {
      obs.disconnect();
      currentVideo = video;
      onVideoReady();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function monitorVideoHealth(seg) {
  if (videoHealthTimer) {
    clearInterval(videoHealthTimer);
    videoHealthTimer = null;
  }

  videoHealthTimer = setInterval(() => {
    if (!currentVideo) {
      clearInterval(videoHealthTimer);
      videoHealthTimer = null;
      return;
    }

    if (!currentVideo.isConnected) {
      log('videoHealth: video element detached, re-querying');
      const newVideo = document.querySelector('video, bwp-video');
      if (newVideo && newVideo !== currentVideo) {
        if (currentAdSkipHandler) {
          currentVideo.removeEventListener('timeupdate', currentAdSkipHandler);
        }
        currentVideo = newVideo;
        // 不重置 skipped：同一个视频中广告已跳过就不应再跳
        // skipped 仅在 cleanUp()（切换视频时）重置
        isBtnAdd = false;
        attachSkipper(seg);
        log('videoHealth: re-attached to new video element');
      } else if (!newVideo) {
        log('videoHealth: no video element found, stopping monitor');
        clearInterval(videoHealthTimer);
        videoHealthTimer = null;
      }
    }
  }, 2000);
}

// === Multi-signal detection pipeline ===
async function getSkipSegment() {
  const bvid = getBvidFromPage();
  log('bvid:', bvid);
  if (!bvid) return null;

  const videoInfo = await fetchVideoInfo(bvid);
  log('videoInfo:', videoInfo);
  if (!videoInfo || !videoInfo.cid) return null;

  const { cid, desc, duration } = videoInfo;
  const selectSegment = (segment, source, requiresConfirmation = segment.requiresConfirmation !== false) => {
    const result = {
      ...segment, source, requiresConfirmation,
      confidence: requiresConfirmation ? 'low' : 'high'
    };
    isSuspiciousAd = requiresConfirmation;
    // Keep one concise decision visible even when verbose DEBUG logging is disabled.
    console.info('[BiliSmartSkip] detection:', { bvid, cid, ...result });
    return result;
  };

  const [playerInfo, danmaku] = await Promise.all([
    fetchPlayerInfo(bvid, cid),
    fetchDanmakuWithTime(cid, duration)
  ]);

  const { viewPoints, subtitles } = playerInfo;
  log('viewPoints:', viewPoints);
  log('subtitles available:', subtitles.length);
  log('danmaku count:', danmaku.length);
  let adTimes = null;
  let labelCandidate = null;

  // 1. Chapter markers (highest confidence)
  adTimes = detectFromChapters(viewPoints);
  log('1.chapters result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    log('HIT chapters:', adTimes);
    if (!adTimes.requiresConfirmation) return selectSegment(adTimes, 'chapters');
    labelCandidate = { segment: adTimes, source: 'chapters' };
  }

  // 2. Description timestamps (high confidence)
  adTimes = detectFromDescription(desc, duration);
  log('2.description result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    log('HIT description:', adTimes);
    if (!adTimes.requiresConfirmation) return selectSegment(adTimes, 'description');
    labelCandidate ||= { segment: adTimes, source: 'description' };
  }

  // 3. User-provided skip destinations take priority over inferred subtitle bounds.
  const timestamp = findAdTimestamps(danmaku, duration);
  log('3.danmaku-time result:', timestamp);
  if (timestamp && !timestamp.requiresConfirmation) {
    return selectSegment(timestamp, 'danmaku-time');
  }
  if (labelCandidate) return selectSegment(labelCandidate.segment, labelCandidate.source);

  // 4. Subtitle keywords locate candidates, but cannot establish safe seek boundaries.
  let subtitleCandidate = null;
  if (subtitles.length > 0) {
    const zhSub = subtitles.find(s => s.lan === 'zh-CN' || s.lan === 'ai-zh');
    const chosenSub = zhSub || subtitles[0];
    log('fetching subtitle:', chosenSub.lan, chosenSub.subtitle_url);
    const subtitleLines = await fetchSubtitleBody(chosenSub.subtitle_url);
    log('subtitle lines:', subtitleLines.length);
    adTimes = detectFromSubtitles(subtitleLines, danmaku);
    log('4.subtitles result:', adTimes);
    if (adTimes && checkAdSegVaild(adTimes, duration)) {
      subtitleCandidate = adTimes;
    }
  } else {
    log('4.subtitles: none available');
  }

  if (timestamp && subtitleCandidate) {
    // Agreement is useful for diagnostics, but two weak signals must not authorize a seek.
    console.info('[BiliSmartSkip] cross-check:', {
      bvid, cid, timestamp, subtitles: subtitleCandidate,
      overlap: Math.max(timestamp.start, subtitleCandidate.start) < Math.min(timestamp.end, subtitleCandidate.end),
      endDelta: Math.abs(timestamp.end - subtitleCandidate.end),
      requiresConfirmation: true
    });
  }
  if (timestamp) return selectSegment(timestamp, 'danmaku-time', true);
  if (subtitleCandidate) return selectSegment(subtitleCandidate, 'subtitles', true);

  // 5. Danmaku keyword matching (low confidence)
  isSuspiciousAd = true;
  adTimes = getAdTimeByKeywords(danmaku);
  log('5.danmaku-keywords result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    log('HIT danmaku-keywords (suspicious):', adTimes);
    return selectSegment(adTimes, 'danmaku-keywords', true);
  }

  log('No ad detected.');
  return null;
}

init();

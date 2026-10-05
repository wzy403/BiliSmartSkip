// == BiliSmartSkip: Main Entry Point ==
// Other modules loaded via manifest.json: constants.js, utils.js, api.js, detectors.js, skipper.js

// === Global State ===
let SKIP_MODE = 'manual';
let SKIP_SHORTCUT = null;
let skipped = false;
const skippedSegments = new Set();
let isBtnAdd = false;
let currentVideo = null;
let currentAdSkipHandler = null;
let isSuspiciousAd = false;
let countdownTimer = null;
let currentAdSegment = null;
let keydownHandler = null;
let videoHealthTimer = null;
let detectionGeneration = 0;

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

    if (!isBtnAdd || !btn.parentElement || !skipButtonSegment || skipped) return;

    e.preventDefault();
    e.stopPropagation();
    skipToEnd(skipButtonSegment.end, 'manual', skipButtonSegment);
  };

  document.addEventListener('keydown', keydownHandler);
}

// === Main logic ===
function mainLogic() {
  cleanUp();
  const generation = detectionGeneration;
  (async () => {
    const segments = await getSkipSegments();
    if (!segments.length || generation !== detectionGeneration) return;
    waitForVideo(() => {
      if (generation !== detectionGeneration) return;
      attachSkipper(segments);
      monitorVideoHealth(segments);
    });
  })().catch(error => console.warn('[BiliSmartSkip] detection failed:', error));
}

// === Lifecycle ===
function cleanUp() {
  detectionGeneration++;
  skipped = false;
  skippedSegments.clear();
  isBtnAdd = false;
  currentAdSegment = null;

  btnCleanUp();

  if (currentVideo && currentAdSkipHandler) {
    currentVideo.removeEventListener('timeupdate', currentAdSkipHandler);
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
  const videoKey = () => `${getBvidFromPage()}:${getVideoPage()}`;
  let lastVideo = videoKey();
  const observer = new MutationObserver(() => {
    const current = videoKey();
    if (current !== lastVideo) {
      lastVideo = current;
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
        btnCleanUp();
        currentVideo = newVideo;
        // Keep the per-interval skip history when the player replaces its element.
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
async function getSkipSegment(inputs = null) {
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
    log('detection:', { bvid, cid, ...result });
    return result;
  };

  const [playerInfo, danmaku] = await Promise.all([
    fetchPlayerInfo(bvid, cid),
    fetchDanmakuWithTime(cid, duration)
  ]);

  const { viewPoints, subtitles } = playerInfo;
  if (inputs) Object.assign(inputs, { bvid, cid, duration, title: videoInfo.title || '',
    chapters: viewPoints, danmaku, subtitleTracks: subtitles });
  log('viewPoints:', viewPoints);
  log('subtitles available:', subtitles.length);
  log('danmaku count:', danmaku.length);
  let adTimes = null;
  let labelCandidate = null;

  // 1. Chapter markers (highest confidence)
  adTimes = detectFromChapters(viewPoints);
  log('1.chapters result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    if (!adTimes.requiresConfirmation) return selectSegment(adTimes, 'chapters');
    labelCandidate = { segment: adTimes, source: 'chapters' };
  }

  // 2. Description timestamps (high confidence)
  adTimes = detectFromDescription(desc, duration);
  log('2.description result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
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
  let subtitleLines = [];
  if (subtitles.length > 0) {
    const zhSub = subtitles.find(s => s.lan === 'zh-CN' || s.lan === 'ai-zh');
    const chosenSub = zhSub || subtitles[0];
    log('fetching subtitle:', chosenSub.lan, chosenSub.subtitle_url);
    subtitleLines = await fetchSubtitleBody(chosenSub.subtitle_url);
    if (inputs) inputs.subtitles = subtitleLines;
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
    log('cross-check:', {
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
  adTimes = getAdTimeByKeywords(danmaku, subtitleLines);
  log('5.danmaku-keywords result:', adTimes);
  if (adTimes && checkAdSegVaild(adTimes, duration)) {
    return selectSegment(adTimes, 'danmaku-keywords', true);
  }

  log('No ad detected.');
  return null;
}

// Preserve the primary-source fallback while adding complete, independent breaks.
// The callback-free input object is local to this request, so navigation cannot
// mix evidence from different videos.
async function getSkipSegments() {
  const inputs = {};
  let primary = await getSkipSegment(inputs);
  const fallback = primary ? [primary] : [];
  if (!inputs.cid || typeof BiliSegmentDetector === 'undefined') return fallback;
  try {
    if (!inputs.subtitles) {
      const tracks = inputs.subtitleTracks || [];
      const chosen = tracks.find(s => s.lan === 'zh-CN' || s.lan === 'ai-zh') || tracks[0];
      inputs.subtitles = chosen ? await fetchSubtitleBody(chosen.subtitle_url) : [];
    }
    primary = refineTimestampBounds(primary, inputs.subtitles, inputs.danmaku);
    const proposals = BiliSegmentDetector.detectSegments(inputs, {
      getSubtitleEvidence, extractTimeFromText, getTimestampSkipCues, getAdLabelEvidence
    });
    const segments = combineSkipSegments(primary, proposals);
    log('segments:', { bvid: inputs.bvid, cid: inputs.cid,
      segments, retainedContent: proposals.filter(segment => segment.skipDecision === 'keep') });
    return segments;
  } catch (error) {
    console.warn('[BiliSmartSkip] complete-segment detection failed; primary fallback:', String(error));
    return primary ? [primary] : [];
  }
}

function combineSkipSegments(primary, proposals) {
  const valid = proposals.filter(segment => segment.skipDecision !== 'keep'
    && Number.isFinite(segment.start) && Number.isFinite(segment.end)
    && segment.start >= 0 && segment.end > segment.start);
  const overlap = (a, b) => Math.max(a.start, b.start) < Math.min(a.end, b.end);
  let retained = primary;
  let conflict = null;
  if (retained?.source === 'danmaku-time' && retained.requiresConfirmation === false) {
    const contradiction = valid.find(segment => overlap(segment, retained)
      && (segment.reviewReasons?.includes('conflicting-time-destinations')
        || segment.boundaryEvidence?.end?.kind === 'commercial-continuation-after-timestamp'
        || (Math.abs(segment.end - retained.end) > 3
          && (segment.boundaryEvidence?.end?.kind === 'explicit-return'
            || (segment.requiresConfirmation === false && segment.boundaryEvidence?.end?.kind === 'chapter-end')))));
    if (contradiction) {
      conflict = { ...contradiction, requiresConfirmation: true, autoEligible: false,
        confidence: 'low', boundaryConfidence: 'uncertain', reason: 'cross-source-boundary-conflict',
        conflictingTimestamp: { start: retained.start, end: retained.end, matchedKeywords: retained.matchedKeywords },
        reviewReasons: [...(contradiction.reviewReasons || []), 'trusted-destination-conflicts-with-observed-boundary'] };
      retained = null;
    }
  }
  if (retained) {
    // A source with explicit boundaries remains authoritative. A structural
    // candidate can refine a community start only when its end agrees closely.
    const replacement = valid.find(segment => overlap(segment, retained)
      && (retained.requiresConfirmation !== false
        ? (segment.requiresConfirmation === false || (segment.start <= retained.start + (retained.boundaryPaddingSeconds || 0)
          && segment.end >= retained.end - (retained.boundaryPaddingSeconds || 0)))
        : retained.source === 'danmaku-time' && segment.requiresConfirmation === false
          && Math.abs(segment.end - retained.end) <= 3 && segment.start <= retained.start));
    if (replacement) retained = null;
  }
  const selected = conflict ? [conflict] : retained ? [retained] : [];
  for (const proposal of valid.slice().sort((a, b) => Number(a.requiresConfirmation !== false) - Number(b.requiresConfirmation !== false)
    || a.start - b.start)) {
    if (!selected.some(segment => overlap(segment, proposal))) selected.push(proposal);
  }
  return selected.sort((a, b) => a.start - b.start);
}

init();

// == BiliSmartSkip: Main Entry Point ==
// Other modules loaded via manifest.json: constants, utils, api, detectors, pitch-model,
// ad-signals, segment-detector and skipper.

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
// Gather every public input once, let each evidence family propose intervals,
// then keep the best-supported proposal wherever proposals overlap.
async function loadDetectionInputs() {
  const bvid = getBvidFromPage();
  log('bvid:', bvid);
  if (!bvid) return null;

  const videoInfo = await fetchVideoInfo(bvid);
  log('videoInfo:', videoInfo);
  if (!videoInfo || !videoInfo.cid) return null;

  const { cid, desc, duration } = videoInfo;
  const [playerInfo, danmaku] = await Promise.all([
    fetchPlayerInfo(bvid, cid),
    fetchDanmakuWithTime(cid, duration)
  ]);
  const tracks = playerInfo.subtitles;
  const track = tracks.find(s => s.lan === 'zh-CN' || s.lan === 'ai-zh') || tracks[0];
  const subtitles = track ? await fetchSubtitleBody(track.subtitle_url) : [];
  log('inputs:', { chapters: playerInfo.viewPoints.length, subtitles: subtitles.length, danmaku: danmaku.length });
  return { bvid, cid, duration, title: videoInfo.title || '', desc: desc || '',
    chapters: playerInfo.viewPoints, danmaku, subtitles };
}

// Lower rank wins an overlap. An author's own label outranks inference; a
// complete sponsor break and a corroborated community destination outrank
// anything that still needs confirmation; among those, intervals with an
// observed start and end outrank transcript wording alone.
function proposalRank(segment) {
  const trusted = segment.requiresConfirmation === false;
  if (segment.source === 'chapters' || segment.source === 'description') return trusted ? 0 : 6;
  if (segment.source === 'segment-detector') return trusted ? 1 : 4;
  if (segment.source === 'danmaku-time') return trusted ? 2 : 3;
  return 5;
}

function reconcileSegments(proposals) {
  const usable = proposals.filter(segment => segment && segment.skipDecision !== 'keep'
    && Number.isFinite(segment.start) && Number.isFinite(segment.end)
    && segment.start >= 0 && segment.end > segment.start);
  const overlap = (a, b) => Math.max(a.start, b.start) < Math.min(a.end, b.end);
  const conflict = (kept, other) => ({ requiresConfirmation: true, autoEligible: false, confidence: 'low',
    reason: 'cross-source-boundary-conflict',
    conflictingSegment: { start: other.start, end: other.end, source: other.source } });
  const selected = [];
  for (const proposal of usable.slice().sort((a, b) => proposalRank(a) - proposalRank(b)
    || (b.support || 0) - (a.support || 0) || a.start - b.start)) {
    const rivals = selected.filter(segment => overlap(segment, proposal));
    if (!rivals.length) { selected.push({ ...proposal }); continue; }
    for (const rival of rivals) {
      // An author's own label stands regardless of what anyone else observed.
      if (proposalRank(rival) === 0 || rival.source === proposal.source) continue;
      if (proposal.boundaryEvidence?.end?.kind === 'explicit-return' && rival.end - proposal.end > 5) {
        // The speaker said the video resumes here. A destination typed by
        // viewers that lands beyond it is not followed, trusted or not: show
        // the interval the transcript bounds (when it fits between the others).
        if (rivals.length === 1) selected[selected.indexOf(rival)] = { ...proposal, ...conflict(proposal, rival) };
        else Object.assign(rival, conflict(rival, proposal));
      } else if (rival.requiresConfirmation === false && proposal.requiresConfirmation === false
        && Math.abs(rival.end - proposal.end) > 5) {
        // Two trusted inferences cannot both be right about where the ad ends:
        // keep the better-ranked interval visible, but do not seek on it.
        Object.assign(rival, conflict(rival, proposal));
      }
    }
  }
  return selected.sort((a, b) => a.start - b.start);
}

// One evidence family failing must not silence the others.
function proposalsFrom(name, detect) {
  try {
    return detect();
  } catch (error) {
    console.warn(`[BiliSmartSkip] ${name} detection failed; continuing without it:`, String(error));
    return [];
  }
}

function detectSkipSegments(inputs) {
  // Without a duration only the author's own chapter times can be used; the
  // other families decline by themselves.
  const duration = Number.isFinite(inputs.duration) && inputs.duration > 0 ? inputs.duration : Infinity;
  const proposals = [
    ...proposalsFrom('label', () => detectLabelledSegments(inputs.chapters, inputs.desc, duration)),
    // Chapter labels are handled above, with description timestamps.
    ...proposalsFrom('sponsor-break', () => BiliSegmentDetector.detectSegments(inputs, {
      getSubtitleEvidence, extractTimeFromText, getTimestampSkipCues, getAdLabelEvidence
    }).filter(segment => segment.reason !== 'explicit-ad-chapter')),
    ...proposalsFrom('community', () => BiliAdSignals.detect(inputs, {
      model: typeof BILI_PITCH_MODEL === 'undefined' ? null : BILI_PITCH_MODEL
    }))
  ];
  return reconcileSegments(proposals).map(segment => ({
    ...segment,
    requiresConfirmation: segment.requiresConfirmation !== false,
    confidence: segment.requiresConfirmation === false ? 'high' : 'low'
  }));
}

async function getSkipSegments() {
  const inputs = await loadDetectionInputs();
  if (!inputs) return [];
  const segments = detectSkipSegments(inputs);
  for (const segment of segments) log('detection:', { bvid: inputs.bvid, cid: inputs.cid, ...segment });
  if (!segments.length) log('No ad detected.');
  return segments;
}

init();

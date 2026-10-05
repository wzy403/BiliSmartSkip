// == BiliSmartSkip: Skip Button UI & Event Handling ==

let buttonEventHandlers = {
  click: null,
  mouseenter: null,
  mouseleave: null,
  play: null,
  pause: null
};
let skipButtonSegment = null;

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

// === Skip logic ===
function groupSkipPrompts(segments) {
  const prompts = [];
  for (let i = 0; i < segments.length; i++) {
    const first = segments[i], next = segments[i + 1];
    // A short uncertain introduction and the nearby trusted break share one
    // interaction window. This only groups UI; automatic seeks use raw intervals.
    const related = first.requiresConfirmation !== false
      && first.end - first.start <= COUNTDOWN
      && next?.requiresConfirmation === false
      && next.start >= first.end && next.start - first.end <= COUNTDOWN;
    const members = related ? [first, next] : [first];
    if (related) i++;
    prompts.push({ ...first, end: members[members.length - 1].end, members });
  }
  return prompts;
}

function attachSkipper(segment) {
  const segments = (Array.isArray(segment) ? segment : [segment]).slice().sort((a, b) => a.start - b.start);
  const prompts = groupSkipPrompts(segments);
  let currentPrompt = null;
  if (currentAdSkipHandler) currentVideo.removeEventListener('timeupdate', currentAdSkipHandler);
  btnCleanUp();
  isBtnAdd = false;
  log('attachSkipper:', { segmentCount: segments.length });
  currentAdSkipHandler = () => {
    const t = currentVideo.currentTime;
    const active = segments.find(item => t >= item.start && t < item.end);
    const prompt = prompts.find(item => t >= item.start && t < item.end) || null;
    if (prompt !== currentPrompt) {
      btnCleanUp();
      isBtnAdd = false;
      currentPrompt = prompt;
    }
    currentAdSegment = active || null;
    if (!prompt) return;
    // Trust and repeat prevention belong to each interval, not to the video.
    const requiresConfirmation = active?.requiresConfirmation !== false;
    skipped = !!active && skippedSegments.has(`${active.start}:${active.end}`);
    isSuspiciousAd = requiresConfirmation;
    if (active && SKIP_MODE === 'auto' && !skipped && !requiresConfirmation) {
      skipToEnd(active.end, 'auto');
    } else if (btn.parentElement && !requiresConfirmation && buttonEventHandlers.play) {
      // Confirmation can upgrade the visible prompt without removing/readding it.
      cleanUpCountdown();
      btn.textContent = '跳过广告';
    } else if (!isBtnAdd && !prompt.members.some(item => skippedSegments.has(`${item.start}:${item.end}`))) {
      addSkipBtn(prompt.end, requiresConfirmation, prompt);
    }
  };

  currentVideo.addEventListener('timeupdate', currentAdSkipHandler);
}

function skipToEnd(end, trigger = 'manual', target = currentAdSegment) {
  // Guard: if video ref is stale, bail out without setting skipped
  if (!currentVideo || !currentVideo.isConnected) {
    log('skipToEnd: video element not connected, aborting');
    return;
  }
  // A user seek may update the media clock before timeupdate removes the old
  // button. Never let that stale button or shortcut jump backwards.
  const position = currentVideo.currentTime;
  if (!target || position < target.start || position >= target.end
    || !Number.isFinite(end) || end <= position || end !== target.end) {
    btnCleanUp();
    return;
  }

  // 立即设置 skipped，防止 timeupdate 在 seeked 回调前重复触发 skipToEnd
  skipped = true;
  for (const member of target.members || [target]) skippedSegments.add(`${member.start}:${member.end}`);

  const wasPlaying = !currentVideo.paused;
  log('skip:', {
    trigger, source: target.source,
    from: currentVideo.currentTime, to: end,
    confidence: target.confidence, wasPlaying
  });

  // Clean up UI immediately
  btnCleanUp();
  isBtnAdd = false;

  // Perform the seek
  currentVideo.currentTime = end + 0.05;

  // Use seeked event to confirm seek, with a timeout fallback
  let settled = false;

  function onSeeked() {
    if (settled) return;
    settled = true;
    currentVideo.removeEventListener('seeked', onSeeked);
    clearTimeout(fallbackTimer);
    ensurePlaying(wasPlaying);
  }

  currentVideo.addEventListener('seeked', onSeeked, { once: true });

  // Fallback: if seeked never fires within 1 second, proceed anyway
  const fallbackTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    currentVideo.removeEventListener('seeked', onSeeked);
    log('skipToEnd: seeked event timed out, using fallback');
    ensurePlaying(wasPlaying);
  }, 1000);
}

function ensurePlaying(wasPlaying) {
  if (!currentVideo || !currentVideo.paused) return;
  if (!wasPlaying) return;

  log('ensurePlaying: video paused after seek, attempting resume');
  currentVideo.play().catch(() => {
    // play() rejected (autoplay policy) — click native play button as fallback
    log('ensurePlaying: play() rejected, clicking native play button');
    const nativePlayBtn =
      document.querySelector('.bpx-player-ctrl-play .bpx-player-ctrl-play-icon')
      || document.querySelector('.bpx-player-ctrl-btn.bpx-player-ctrl-play')
      || document.querySelector('.squirtle-video-start');
    if (nativePlayBtn) {
      nativePlayBtn.click();
      log('ensurePlaying: clicked native play button');
    }
  });
}

function btnCleanUp() {
  btn.remove();
  skipButtonSegment = null;
  cleanUpBtnEvents();
}

function cleanUpBtnEvents() {
  if (buttonEventHandlers.click) {
    btn.removeEventListener('click', buttonEventHandlers.click);
    buttonEventHandlers.click = null;
  }
  cleanUpCountdown();
}

function cleanUpCountdown() {
  if (countdownTimer !== null) {
    clearTimeout(countdownTimer);
    countdownTimer = null;
  }
  if (buttonEventHandlers.mouseenter) {
    btn.removeEventListener('mouseenter', buttonEventHandlers.mouseenter);
    buttonEventHandlers.mouseenter = null;
  }
  if (buttonEventHandlers.mouseleave) {
    btn.removeEventListener('mouseleave', buttonEventHandlers.mouseleave);
    buttonEventHandlers.mouseleave = null;
  }
  if (buttonEventHandlers.play) {
    currentVideo.removeEventListener('play', buttonEventHandlers.play);
    buttonEventHandlers.play = null;
  }
  if (buttonEventHandlers.pause) {
    currentVideo.removeEventListener('pause', buttonEventHandlers.pause);
    buttonEventHandlers.pause = null;
  }
}

function possibleAdCountdown(counter) {
  let remainingMs = counter * 1000, startedAt = null, hovered = false;
  const render = () => { btn.textContent = `跳过疑似广告 (${Math.ceil(remainingMs / 1000)})`; };
  const consumeElapsed = () => {
    if (startedAt !== null) remainingMs = Math.max(0, remainingMs - (performance.now() - startedAt));
    startedAt = null;
  };
  const countdownPause = () => {
    consumeElapsed();
    if (countdownTimer !== null) clearTimeout(countdownTimer);
    countdownTimer = null;
    if (remainingMs <= 0) btnCleanUp();
  };
  const countdownStart = () => {
    if (countdownTimer !== null || hovered || currentVideo.paused || remainingMs <= 0) return;
    startedAt = performance.now();
    countdownTimer = setTimeout(() => {
      countdownTimer = null;
      consumeElapsed();
      if (remainingMs <= 0) { btnCleanUp(); return; }
      render();
      countdownStart();
    }, Math.min(1000, remainingMs));
  };

  buttonEventHandlers.mouseenter = () => { hovered = true; countdownPause(); };
  btn.addEventListener('mouseenter', buttonEventHandlers.mouseenter);
  buttonEventHandlers.mouseleave = () => { hovered = false; countdownStart(); };
  btn.addEventListener('mouseleave', buttonEventHandlers.mouseleave);
  buttonEventHandlers.play = countdownStart;
  currentVideo.addEventListener('play', buttonEventHandlers.play);
  buttonEventHandlers.pause = countdownPause;
  currentVideo.addEventListener('pause', buttonEventHandlers.pause);
  render();
  countdownStart();
}

function addSkipBtn(end, requiresConfirmation = isSuspiciousAd, target = currentAdSegment) {
  log('addSkipBtn called, end=', formatTime(end));
  cleanUpBtnEvents();
  skipButtonSegment = target;
  if (!requiresConfirmation) {
    btn.textContent = '跳过广告';
  } else {
    possibleAdCountdown(COUNTDOWN);
  }

  const container = currentVideo.parentElement;
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  buttonEventHandlers.click = () => skipToEnd(end, 'manual', target);
  btn.addEventListener('click', buttonEventHandlers.click);
  container.appendChild(btn);
  isBtnAdd = true;
}

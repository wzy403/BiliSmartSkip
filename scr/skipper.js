// == BiliSmartSkip: Skip Button UI & Event Handling ==

let buttonEventHandlers = {
  click: null,
  mouseenter: null,
  mouseleave: null,
  play: null,
  pause: null
};

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
  currentVideo.currentTime = end + 0.05;
  setTimeout(() => {
    currentVideo.play().catch(err => console.warn('Autoplay failed:', err));
  }, 300);
  skipped = true;
  btnCleanUp();
  isBtnAdd = false;
}

function btnCleanUp() {
  btn.remove();
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  cleanUpBtnEvents();
}

function cleanUpBtnEvents() {
  if (buttonEventHandlers.click) {
    btn.removeEventListener('click', buttonEventHandlers.click);
    buttonEventHandlers.click = null;
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
  let countdown = counter;
  btn.textContent = `跳过疑似广告 (${countdown})`;

  const countdownStart = () => {
    countdownTimer = setInterval(() => {
      countdown--;
      if (countdown == -1) {
        btnCleanUp();
        return;
      } else if (countdown > 0) {
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
  if (!isSuspiciousAd) {
    btn.textContent = '跳过广告';
  } else {
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

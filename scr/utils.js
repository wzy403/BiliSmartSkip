// == BiliSmartSkip: Utility Functions ==

function log(...args) { if (DEBUG) console.log('[BiliSmartSkip]', ...args); }

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

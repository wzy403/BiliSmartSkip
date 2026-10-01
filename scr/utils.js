// == BiliSmartSkip: Utility Functions ==

function log(...args) { if (DEBUG) console.log('[BiliSmartSkip]', ...args); }

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function zhNumToInt(str) {
  if (/^\d+$/.test(str)) return Number(str);
  const map = { 零:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  if (/^零[一二三四五六七八九]$/.test(str)) return map[str[1]];
  if (str === '十') return 10;
  if (str.includes('十')) {
    const [left, right] = str.split('十');
    return (left ? map[left] : 1) * 10 + (right ? map[right] : 0);
  }
  return map[str];
}

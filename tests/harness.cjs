// Minimal browser fixture: production scripts run unchanged, with deterministic APIs/events.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.style = {};
    this.listeners = new Map();
    this.parentElement = null;
    this.textContent = '';
  }
  addEventListener(type, callback, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, once: !!options.once });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(l => l.callback !== callback));
  }
  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      if (listener.once) this.removeEventListener(type, listener.callback);
      listener.callback({ target: this });
    }
  }
  appendChild(child) { child.parentElement = this; }
  remove() { this.parentElement = null; }
  click() { this.dispatch('click'); }
}

function createHarness(fixture = {}) {
  const video = new Element();
  video.parentElement = new Element();
  video.isConnected = true;
  video.paused = false;
  video.seeks = [];
  video.position = 0;
  Object.defineProperty(video, 'currentTime', {
    get() { return this.position; },
    set(value) { this.position = value; this.seeks.push(value); }
  });
  video.play = async () => { video.paused = false; video.dispatch('play'); };

  const document = new Element();
  document.body = new Element();
  document.createElement = () => new Element();
  document.querySelector = selector => selector.includes('video') ? video : null;
  const logs = [];
  const storageListeners = [];
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;
  let subtitleFetches = 0;
  const schedule = (callback, delay, repeat) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay, repeat, due: now + delay });
    return id;
  };
  const context = vm.createContext({
    document,
    location: { href: 'https://www.bilibili.com/video/BV_fixture' },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: element => ({ position: element.style.position || 'static' }),
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    chrome: { storage: {
      // Suppress startup network activity; exercise getSkipSegment explicitly below.
      local: { get() {} },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    } },
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    getBvidFromPage: () => 'BV_fixture',
    getVideoPage: () => 1,
    fetchVideoInfo: async () => ({ cid: 14, desc: '', duration: 600, ...fixture.videoInfo }),
    fetchPlayerInfo: async () => ({
      viewPoints: fixture.chapters || [],
      subtitles: fixture.subtitles?.length ? [{ lan: 'zh-CN', subtitle_url: 'fixture://subtitles' }] : []
    }),
    fetchDanmakuWithTime: async () => fixture.danmaku || [],
    fetchSubtitleBody: async () => { subtitleFetches++; return fixture.subtitles || []; },
    __video: video
  });
  const scripts = ['constants', 'utils', 'detectors', 'skipper', 'content'];
  if (fs.existsSync(path.join(__dirname, '..', 'scr', 'segment-detector.js'))) scripts.splice(3, 0, 'segment-detector');
  for (const file of scripts) {
    const filename = path.join(__dirname, '..', 'scr', `${file}.js`);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  const evaluate = code => vm.runInContext(code, context);
  return {
    video, logs, context, evaluate,
    get button() { return evaluate('btn'); },
    get subtitleFetches() { return subtitleFetches; },
    setMode(mode) {
      storageListeners.forEach(listener => listener({ skipMode: { newValue: mode } }, 'local'));
    },
    async detectAndAttach(mode = 'auto') {
      this.setMode(mode);
      const segment = await context.getSkipSegment();
      context.__segment = segment;
      if (segment) evaluate('currentVideo = __video; currentAdSegment = __segment; attachSkipper(__segment)');
      return segment;
    },
    async detectAllAndAttach(mode = 'auto') {
      this.setMode(mode);
      const segments = typeof context.getSkipSegments === 'function'
        ? await context.getSkipSegments() : [await context.getSkipSegment()].filter(Boolean);
      context.__segments = segments;
      if (segments.length) evaluate('currentVideo = __video; attachSkipper(__segments.length === 1 ? __segments[0] : __segments)');
      return segments;
    },
    tick(time) { video.position = time; video.dispatch('timeupdate'); },
    advanceTimers(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        const [id, timer] = next;
        now = timer.due;
        if (timer.repeat) timer.due += timer.delay;
        else timers.delete(id);
        timer.callback();
      }
      now = target;
    }
  };
}

module.exports = { createHarness };

// Read only the requested video's public metadata from the page's JS world.
// The isolated content script receives it through this injected script element.
(() => {
  const script = document.currentScript;
  if (!script?.dataset) return;
  script.dataset.videoInfo = '';

  try {
    const bvid = script.dataset.bvid;
    const video = window.__INITIAL_STATE__?.videoData;
    if (!bvid || !video || video.bvid !== bvid) return;

    const numericValue = value => typeof value === 'number' && Number.isFinite(value)
      ? value : typeof value === 'string' && /^\d+$/.test(value) ? value : null;
    const data = {
      bvid: video.bvid,
      aid: numericValue(video.aid),
      cid: numericValue(video.cid),
      title: typeof video.title === 'string' ? video.title : '',
      desc: typeof video.desc === 'string' ? video.desc : '',
      duration: numericValue(video.duration),
      pages: Array.isArray(video.pages) ? video.pages.filter(page => page && typeof page === 'object').map(page => ({
        page: numericValue(page.page),
        cid: numericValue(page.cid),
        duration: numericValue(page.duration)
      })) : []
    };
    script.dataset.videoInfo = JSON.stringify(data);
  } catch (_) {
    // Missing or changing page state must not interrupt the site's scripts.
  }
})();

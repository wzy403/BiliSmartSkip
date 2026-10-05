const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');

const repoRoot = path.resolve(__dirname, '..');

function loadProduction(ref, { sourceDir } = {}) {
  if (ref && sourceDir) throw new Error('Choose a Git ref or source directory, not both');
  const directory = sourceDir ? path.resolve(sourceDir) : null;
  const commit = ref ? execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { cwd: repoRoot, encoding: 'utf8' }).trim() : null;
  const scripts = ['constants', 'utils', 'detectors', 'skipper', 'content'];
  const manifest = commit ? JSON.parse(execFileSync('git', ['show', `${commit}:manifest.json`],
    { cwd: repoRoot, encoding: 'utf8' })) : null;
  const hasModule = name => manifest
    ? manifest.content_scripts.some(script => script.js?.some(filename => filename.endsWith(`/${name}.js`)))
    : fs.existsSync(path.join(directory || path.join(repoRoot, 'scr'), `${name}.js`));
  if (hasModule('segment-detector')) scripts.splice(3, 0, 'segment-detector');
  if (hasModule('heatmap-verifier')) scripts.splice(scripts.indexOf('content'), 0, 'heatmap-verifier');
  const sources = new Map(scripts.map(name => {
    const filename = path.join(repoRoot, 'scr', `${name}.js`);
    const source = commit
      ? execFileSync('git', ['show', `${commit}:scr/${name}.js`], { cwd: repoRoot, encoding: 'utf8' })
      : fs.readFileSync(directory ? path.join(directory, `${name}.js`) : filename, 'utf8');
    return [filename, source];
  }));
  // Reuse the deterministic browser fixture without changing it or any production source.
  // Intercept script reads and optional module discovery for this exact snapshot.
  const harnessModule = { exports: {} };
  const harnessPath = path.join(repoRoot, 'tests', 'harness.cjs');
  vm.runInNewContext(fs.readFileSync(harnessPath, 'utf8'), {
    module: harnessModule, __dirname: path.dirname(harnessPath),
    require: name => name === './source-directory.cjs' ? path.join(repoRoot, 'scr') : name === 'node:fs' ? {
      existsSync: filename => sources.has(filename),
      readFileSync: (filename, encoding) => sources.has(filename)
        ? sources.get(filename) : fs.readFileSync(filename, encoding)
    } : require(name)
  }, { filename: harnessPath });
  const sourceSha256 = createHash('sha256').update([...sources].map(([filename, source]) =>
    `${path.basename(filename)}\0${source}`).join('\0')).digest('hex');
  if (directory && fs.existsSync(path.join(directory, 'snapshot.json'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));
    if (manifest.sourceSha256 && manifest.sourceSha256 !== sourceSha256) throw new Error('Snapshot source hash does not match snapshot.json');
  }
  const files = [...sources].map(([filename, source]) => ({ filename: path.basename(filename), bytes: Buffer.byteLength(source) }));
  const codeSize = { files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: gzipSync([...sources.values()].join('\n')).length };
  return { createHarness: harnessModule.exports.createHarness, commit, sourceSha256, sourceDir: directory, codeSize };
}

async function runVideo(record, production, { heatmap } = {}) {
  const h = production.createHarness({
    videoInfo: { cid: record.cid, duration: record.duration, desc: record.desc || '', title: record.title || '',
      ...(record.aid === undefined ? {} : { aid: record.aid }) },
    chapters: record.chapters || [], subtitles: record.subtitles || [], danmaku: record.danmaku || [], heatmap
  });
  h.context.getBvidFromPage = () => record.bvid;
  const traces = [];
  for (const [name, source] of Object.entries({ detectFromChapters: 'chapters', detectFromDescription: 'description',
    detectFromSubtitles: 'subtitles', findAdTimestamps: 'danmaku-time', getAdTimeByKeywords: 'danmaku-keywords' })) {
    const original = h.context[name];
    h.context[name] = (...args) => {
      const result = original(...args);
      if (result) traces.push({ result, source });
      return result;
    };
  }
  const started = performance.now();
  const segments = await h.detectAllAndAttach('auto');
  const detectionMs = performance.now() - started;
  const automaticSegments = [];
  for (const segment of segments) {
    const before = h.video.seeks.length;
    h.tick(segment.start);
    if (h.video.seeks.length > before) automaticSegments.push(segment);
  }
  const annotate = segment => {
    const source = segment.source || traces.find(trace => trace.result === segment)?.source || null;
    const matchedKeywords = segment.matchedKeywords || (source === 'subtitles'
      ? h.evaluate('AD_CONTENT_KEYWORDS').filter(keyword => (record.subtitles || []).some(line =>
        line.from < segment.end && line.to > segment.start && line.content.includes(keyword))) : []);
    return { ...segment, source, matchedKeywords };
  };
  const candidates = segments.map(annotate), automatic = automaticSegments.map(annotate);
  return JSON.parse(JSON.stringify({
    candidate: candidates[0] || null, auto: automatic[0] || null,
    candidates, automaticSegments: automatic, detectionMs,
    seekDestinations: h.video.seeks,
    diagnostics: h.logs.filter(log => log.level !== 'log').map(log => log.args)
  }));
}

module.exports = { loadProduction, runVideo, repoRoot };

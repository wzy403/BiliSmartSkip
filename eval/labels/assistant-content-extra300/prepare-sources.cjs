#!/usr/bin/env node
// Data preparation only. No advertisement detection or automatic review decisions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const base = __dirname;
const rel = p => path.relative(root, p);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (cp.execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() !== 'test-branch') {
  throw new Error('Content review writes require test-branch');
}
const inputFile = 'eval/data/danmaku-audit-20261001/new-public.jsonl';
const input = fs.readFileSync(path.join(root, inputFile));
const inputSha256 = hash(input);
const lines = input.toString('utf8').split('\n').filter(Boolean);
const original = lines.map(JSON.parse);
if (original.length !== 300) throw new Error('Expected 300 input records');
const enrichments = new Map();
const filenames = process.argv.slice(2).flatMap(filename => {
  const abs = path.resolve(filename);
  return fs.statSync(abs).isDirectory()
    ? fs.readdirSync(abs).filter(n => n.endsWith('.json')).sort().map(n => path.join(abs, n))
    : [abs];
});
for (const filename of filenames) {
  const absolute = path.resolve(filename);
  if (!absolute.startsWith(base + path.sep)) throw new Error('Enrichment must be inside this review directory');
  const bytes = fs.readFileSync(absolute);
  const items = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  for (const item of items) {
    const key = `${item.bvid}:${item.cid}`;
    const previous = enrichments.get(key);
    if (previous?.record.subtitles?.length && !item.subtitles?.length) continue;
    enrichments.set(key, { record: item, file: rel(absolute), sha256: hash(bytes) });
  }
}
fs.mkdirSync(path.join(base, 'sources'), { recursive: true });
fs.mkdirSync(path.join(base, 'records'), { recursive: true });
const index = [];
const acquisitionFields = ['capturedAt', 'method', 'metadata', 'error', 'subtitles', 'subtitleReason',
  'subtitleFetchedAt', 'subtitleMethod', 'subtitleLanguage', 'subtitleSource'];
for (const [i, row] of original.entries()) {
  const enriched = enrichments.get(`${row.bvid}:${row.cid}`);
  const src = enriched?.record || row;
  const subtitles = src.subtitles || [];
  const sourceFile = path.join(base, 'sources', `${row.bvid}.json`);
  const acquisition = { ...row.acquisition, ...src.acquisition };
  // Deliberately exclude danmaku, community references, annotations, and sampling strata.
  const safe = {
    bvid: row.bvid, cid: row.cid, title: src.title ?? row.title,
    duration: src.duration ?? row.duration, desc: src.desc ?? row.desc,
    subtitles, acquisition: Object.fromEntries(acquisitionFields.filter(k => Object.hasOwn(acquisition, k)).map(k => [k, acquisition[k]])),
    provenance: {
      inputFile, inputSha256, inputLine: i + 1, inputLineSha256: hash(lines[i]),
      acquisitionFile: enriched?.file || inputFile,
      acquisitionSha256: enriched?.sha256 || inputSha256,
      sourceUrl: `https://www.bilibili.com/video/${row.bvid}/?p=${row.page || 1}`
    }
  };
  const bytes = JSON.stringify(safe, null, 2) + '\n';
  const recordFile = path.join(base, 'records', `${row.bvid}.json`);
  const existing = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile)) : null;
  if (existing?.record.fullTranscriptRead === true) {
    if (!fs.existsSync(sourceFile) || fs.readFileSync(sourceFile, 'utf8') !== bytes) {
      throw new Error(`Refusing to alter reviewed source: ${row.bvid}`);
    }
  } else {
    fs.writeFileSync(sourceFile, bytes);
    const pendingReasons = subtitles.length
      ? ['已取得字幕，尚未由助手完整阅读及作出内容判断。']
      : [`没有可审阅字幕；采集状态 ${safe.acquisition.subtitles}，原因 ${safe.acquisition.subtitleReason || 'unknown'}。未据此判定无广告。`];
    if (['failed', 'error'].includes(safe.acquisition.metadata)) pendingReasons.push('公开元数据或BV/CID身份核验尚未成功。');
    fs.writeFileSync(recordFile, JSON.stringify({
      kind: 'assistant-content-review', reviewer: null, modality: 'not-reviewed',
      algorithmPredictionsSeen: false, communityAdLabelsSeen: false, danmakuJumpTimesSeen: false,
      source: { ...safe.provenance, transcriptFile: rel(sourceFile), transcriptSha256: hash(bytes) },
      record: {
        bvid: row.bvid, cid: row.cid, duration: safe.duration,
        reviewStatus: subtitles.length && !['failed', 'error'].includes(safe.acquisition.metadata) ? 'needs-review' : 'needs-source',
        fullTranscriptRead: false, videoSummary: null, adPresence: 'uncertain',
        segments: [], normalSpeechRanges: [], pendingReasons,
        limitations: ['助手内容参考；尚未完成内容审核，未观看视频或听取音频。']
      }
    }, null, 2) + '\n');
  }
  index.push({ inputLine: i + 1, bvid: row.bvid, cid: row.cid, duration: safe.duration,
    subtitleCount: subtitles.length, subtitleCharacters: subtitles.reduce((n, s) => n + s.content.length, 0),
    transcriptFile: rel(sourceFile), transcriptSha256: hash(bytes),
    recordFile: rel(recordFile), acquisition: safe.acquisition });
}
fs.writeFileSync(path.join(base, 'source-index.json'), JSON.stringify({
  kind: 'blind-content-source-index', inputFile, inputSha256, records: index
}, null, 2) + '\n');
console.log(JSON.stringify({ total: index.length, withSubtitles: index.filter(r => r.subtitleCount).length,
  subtitleRows: index.reduce((n, r) => n + r.subtitleCount, 0) }));

// Save an explicitly authored review after its complete transcript was read.
// No content inference: every summary, decision, boundary and evidence row is supplied.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
module.exports = function save(inputLine, decision) {
  if (!((inputLine >= 31 && inputLine <= 50) || (inputLine >= 101 && inputLine <= 175) || (inputLine >= 226 && inputLine <= 250) || inputLine === 291 || inputLine === 292)) throw new Error('Outside assigned range');
  const base = __dirname;
  const entry = JSON.parse(fs.readFileSync(path.join(base, 'source-index.json'))).records.find(r => r.inputLine === inputLine);
  const sourceBytes = fs.readFileSync(path.join(base, 'sources', `${entry.bvid}.json`));
  const source = JSON.parse(sourceBytes);
  const n = source.subtitles.length;
  if (!n || ['failed', 'error'].includes(source.acquisition?.metadata)) throw new Error('Missing source or identity');
  const recordFile = path.join(base, 'records', `${entry.bvid}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile));
  if (record.source.transcriptSha256 !== crypto.createHash('sha256').update(sourceBytes).digest('hex')) throw new Error('Source hash changed');
  if (!decision.summary || !decision.readAll) throw new Error('Explicit full-read declaration and summary required');
  const segments = (decision.segments || []).map(s => {
    const { evidenceRows, ...rest } = s;
    return { ...rest, boundaryConfidence: 'subtitle_only', evidence: evidenceRows.map(i => {
      const t = source.subtitles[i]; if (!t) throw new Error('Evidence index out of range');
      return { from: t.from, to: t.to, text: t.content };
    }) };
  });
  record.reviewer = 'assistant-extra300-middle';
  record.modality = 'full-cached-subtitles';
  Object.assign(record.record, {
    reviewStatus: decision.status || 'reviewed', fullTranscriptRead: true,
    videoSummary: decision.summary, adPresence: decision.adPresence,
    readCoverage: { subtitleRows: n, firstIndex: 0, lastIndex: n - 1, allRowsRead: true },
    segments, normalSpeechRanges: decision.normalSpeechRanges || [], pendingReasons: decision.pendingReasons || [],
    limitations: ['仅完整阅读可用字幕，未观看画面或听取音频；字幕缺口与纯画面内容保持未知。', ...(decision.limitations || [])]
  });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ inputLine, bvid: entry.bvid, status: record.record.reviewStatus, rows: n, segments: segments.length }));
};

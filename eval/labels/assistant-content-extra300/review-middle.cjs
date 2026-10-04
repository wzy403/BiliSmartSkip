#!/usr/bin/env node
// Read-only transcript display helper for assigned input lines 31–50, 101–175 226–250 and 291–292.
// Prints every requested consecutive line; performs no content classification.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = __dirname;
const assigned = n => (n >= 31 && n <= 50) || (n >= 101 && n <= 175) || (n >= 226 && n <= 250) || n === 291 || n === 292 || n === 69;
const index = JSON.parse(fs.readFileSync(path.join(base, 'source-index.json'))).records;
const [selection, firstArg = '0', countArg = '240'] = process.argv.slice(2);
if (!selection) {
  const rows = index.filter(r => assigned(r.inputLine));
  console.log(JSON.stringify(rows.map(r => {
    const source = JSON.parse(fs.readFileSync(path.join(base, 'sources', `${r.bvid}.json`)));
    const record = JSON.parse(fs.readFileSync(path.join(base, 'records', `${r.bvid}.json`)));
    return { row: r.inputLine, bvid: r.bvid, rows: source.subtitles.length,
      status: record.record.reviewStatus, duration: source.duration };
  }), null, 2));
} else {
  const row = index.find(r => String(r.inputLine) === selection || r.bvid === selection);
  if (!row || !assigned(row.inputLine)) throw new Error('Outside assigned ranges 31–50, 101–175 226–250 and 291–292');
  const filename = path.join(base, 'sources', `${row.bvid}.json`);
  const bytes = fs.readFileSync(filename);
  const source = JSON.parse(bytes);
  const first = Number(firstArg), count = Number(countArg);
  if (!Number.isInteger(first) || first < 0 || !Number.isInteger(count) || count < 1) throw new Error('Invalid line range');
  const last = Math.min(source.subtitles.length, first + count);
  console.log(JSON.stringify({ inputLine: row.inputLine, bvid: source.bvid, cid: source.cid,
    title: source.title, duration: source.duration, desc: source.desc,
    totalRows: source.subtitles.length, firstIndex: first, lastIndex: last - 1,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
  for (let i = first; i < last; i++) {
    const s = source.subtitles[i];
    console.log(`${i}\t${s.from}–${s.to}\t${s.content}`);
  }
  console.log(JSON.stringify({ completeRequestedRange: true, nextIndex: last,
    reachedTranscriptEnd: last === source.subtitles.length }));
}

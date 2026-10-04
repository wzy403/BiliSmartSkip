#!/usr/bin/env node
'use strict';
// Scope-only repair: retain each existing normal-speech judgment only where
// cached subtitles actually exist. Does not create judgments or alter ad labels.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const base = __dirname, root = path.resolve(base, '../../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).split(path.sep).join('/');
if (cp.execFileSync('git', ['branch', '--show-current'], {cwd:root, encoding:'utf8'}).trim() !== 'test-branch') throw Error('test-branch required');
const changes = [];
for (const name of fs.readdirSync(path.join(base, 'records')).filter(name => name.endsWith('.json')).sort()) {
  const file = path.join(base, 'records', name), before = fs.readFileSync(file), top = JSON.parse(before);
  const sourceBytes = fs.readFileSync(path.resolve(root, top.source.transcriptFile));
  if (hash(sourceBytes) !== top.source.transcriptSha256) throw Error(`Source changed: ${name}`);
  const source = JSON.parse(sourceBytes), union = [];
  for (const row of [...source.subtitles].sort((a,b) => a.from-b.from)) {
    if (!(Number.isFinite(row.from) && Number.isFinite(row.to) && row.to > row.from)) throw Error(`Invalid source timestamp: ${name}`);
    if (typeof (row.content ?? row.text) !== 'string' || !(row.content ?? row.text).trim()) continue;
    const last = union.at(-1);
    if (last && row.from <= last.end + 0.00001) last.end = Math.max(last.end, row.to);
    else union.push({start:row.from,end:row.to});
  }
  const originalRanges = top.record.normalSpeechRanges;
  const correctedRanges = originalRanges.flatMap(range => union.map(covered => ({
    ...range, start:Math.max(range.start,covered.start), end:Math.min(range.end,covered.end),
  })).filter(range => range.end > range.start + 0.00001));
  if (JSON.stringify(originalRanges) === JSON.stringify(correctedRanges)) continue;
  top.record.normalSpeechRanges = correctedRanges;
  const after = Buffer.from(JSON.stringify(top,null,2)+'\n');
  if (hash(fs.readFileSync(file)) !== hash(before)) throw Error(`Concurrent record writer: ${name}; retry after writers stop`);
  fs.writeFileSync(file+'.tmp', after); fs.renameSync(file+'.tmp', file);
  changes.push({
    bvid:top.record.bvid,inputLine:top.source.inputLine,recordFile:relative(file),
    sourceSha256:top.source.transcriptSha256,recordBeforeSha256:hash(before),recordAfterSha256:hash(after),
    originalRanges,correctedRanges,
  });
}
if (changes.length) {
  const logFile = path.join(base,'normal-range-corrections.json');
  const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile)) : {
    kind:'normal-speech-subtitle-coverage-corrections',
    scope:'Existing normalSpeechRanges intersected with actual subtitle union; original reasons preserved. Advertisement boundaries, ad/skip decisions, reviewStatus and visual observations are unchanged.',runs:[],
  };
  log.runs.push({correctedAt:new Date().toISOString(),changes});
  fs.writeFileSync(logFile,JSON.stringify(log,null,2)+'\n');
}
console.log(JSON.stringify({correctedRecords:changes.length,log:changes.length ? relative(path.join(base,'normal-range-corrections.json')) : null}));

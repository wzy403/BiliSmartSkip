'use strict';
// Serialization helper for explicit, individually read assistant decisions.
// Does not infer ads, search keywords, or decide completion on its own.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const base = __dirname, root = path.resolve(base, '../../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
module.exports = function save(bvid, spec) {
  if (cp.execFileSync('git', ['branch', '--show-current'], {cwd:root,encoding:'utf8'}).trim() !== 'test-branch') throw Error('test-branch required');
  const file = path.join(base, 'records', `${bvid}.json`), top = JSON.parse(fs.readFileSync(file));
  const line = top.source.inputLine;
  if (!((line >= 51 && line <= 75) || (line >= 201 && line <= 225) || line === 289 || line === 290)) throw Error('Outside reviewer C allocation');
  const raw = fs.readFileSync(path.join(base, 'sources', `${bvid}.json`));
  const source = JSON.parse(raw), subs = source.subtitles;
  if (hash(raw) !== top.source.transcriptSha256 || !subs.length || subs.length !== spec.expectedRows) throw Error('Reviewed source identity/row count changed');
  if (!spec.summary || !Array.isArray(spec.segments)) throw Error('Explicit summary and segment decisions required');
  const segments = spec.segments.map(s => ({start:s.start,end:s.end,contentType:s.contentType,skipDecision:s.skipDecision,reason:s.reason,confidence:s.confidence || 'high',boundaryConfidence:'subtitle_only',startUncertainty:s.startUncertainty || [s.start,s.start],endUncertainty:s.endUncertainty || [s.end,s.end],evidence:s.evidenceIndices.map(i => {if(!subs[i])throw Error('Unknown evidence index');return {from:subs[i].from,to:subs[i].to,text:subs[i].content};})}));
  const normal = [];
  for (const row of subs) {
    let ranges = [{start:row.from,end:row.to}];
    for (const s of segments) ranges = ranges.flatMap(r => r.end<=s.start||r.start>=s.end ? [r] : [{start:r.start,end:Math.min(r.end,s.start)},{start:Math.max(r.start,s.end),end:r.end}].filter(x=>x.end>x.start));
    for (const r of ranges) {
      const last=normal.at(-1);
      if(last&&r.start<=last.end+0.00001)last.end=Math.max(last.end,r.end);
      else normal.push({...r,reason:'已连续阅读全文；这里只断言实际字幕覆盖的正文，未将字幕空白归为正文。'});
    }
  }
  top.reviewer='extra300_full_content_c';top.modality='full-cached-subtitles';
  Object.assign(top.record,{reviewStatus:spec.status || 'reviewed',fullTranscriptRead:true,readCoverage:{subtitleRows:subs.length,firstIndex:0,lastIndex:subs.length-1,allRowsRead:true},videoSummary:spec.summary,adPresence:spec.adPresence,segments,normalSpeechRanges:normal,pendingReasons:spec.pendingReasons || [],limitations:['仅连续完整阅读当前缓存字幕；未观看视频画面或听音频，不能排除无字幕画面商业信息。','自动字幕可能错识；广告边界依据连续上下文和字幕时间，未按未来评估容差缩短。',...(spec.limitations || [])]});
  fs.writeFileSync(file,JSON.stringify(top,null,2)+'\n');
  console.log(JSON.stringify({bvid,line,status:top.record.reviewStatus,rows:subs.length,segments:segments.map(s=>[s.start,s.end,s.contentType,s.skipDecision])}));
};

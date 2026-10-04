#!/usr/bin/env node
'use strict';
// Bookkeeping flags only: absence of subtitles does not determine ad presence.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const base=__dirname,root=path.resolve(base,'../../..');
if(cp.execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim()!=='test-branch')throw Error('test-branch required');
const visualKeys=['visualObservations','visualReview','visualEvidence'];
const nonempty=value=>Array.isArray(value)?value.length>0:value&&typeof value==='object'&&Object.keys(value).length>0;
const records=[];
for(const name of fs.readdirSync(path.join(base,'records')).filter(x=>x.endsWith('.json'))){
  const top=JSON.parse(fs.readFileSync(path.join(base,'records',name))),r=top.record;
  if(r.reviewStatus!=='reviewed')continue;
  const declaredVisual=[top,r,top.secondaryReview,r.secondaryReview].filter(Boolean).some(c=>visualKeys.some(k=>nonempty(c[k]))||c.frameIndexes||c.frameManifests||c.frameManifest||c.framesManifest||c.mediaFile||c.media);
  if(declaredVisual)continue;
  const s=JSON.parse(fs.readFileSync(path.resolve(root,top.source.transcriptFile))).subtitles.filter(row=>typeof(row.content??row.text)==='string'&&(row.content??row.text).trim()).sort((a,b)=>a.from-b.from);
  let cursor=0;const gaps=[];
  for(const row of s){if(row.from-cursor>30)gaps.push({from:cursor,to:row.from,seconds:row.from-cursor});cursor=Math.max(cursor,row.to);}
  if(r.duration-cursor>30)gaps.push({from:cursor,to:r.duration,seconds:r.duration-cursor});
  if(gaps.length)records.push({inputLine:top.source.inputLine,bvid:r.bvid,reviewer:top.reviewer,gaps});
}
records.sort((a,b)=>a.inputLine-b.inputLine);
fs.writeFileSync(path.join(base,'reviewed-gap-audit.json'),JSON.stringify({kind:'reviewed-subtitle-gaps-without-recorded-visual-observation',generatedAt:new Date().toISOString(),scope:'Metadata flags only. Recognizes top/record visualObservations, visualReview, visualEvidence and secondary-review media references. Existing visual declarations are excluded, without claiming that a script proves actual visual coverage. No semantic label or reviewStatus is changed.',records},null,2)+'\n');
console.log(JSON.stringify({flaggedVideos:records.length,records}));

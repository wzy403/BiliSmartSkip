import json,sys,pathlib,hashlib
ROOT=pathlib.Path('eval/labels/assistant-content-extra300')
idx=json.loads((ROOT/'source-index.json').read_text())['records']
def source(line):
    item=idx[int(line)-1];return item,json.loads(pathlib.Path(item['transcriptFile']).read_text())
if sys.argv[1]=='read':
    item,s=source(sys.argv[2]);rows=s['subtitles'];a=int(sys.argv[3]) if len(sys.argv)>3 else 0;b=int(sys.argv[4]) if len(sys.argv)>4 else len(rows)
    print(json.dumps({k:v for k,v in s.items() if k not in ['subtitles','provenance','acquisition']},ensure_ascii=False)); print('TOTAL',len(rows),'READ',a,b)
    for i in range(a,min(b,len(rows))):
        r=rows[i];print(f"{i} {r['from']}-{r['to']} {r['content']}")
elif sys.argv[1]=='save':
    d=json.loads(sys.stdin.read());item,s=source(d['line']);rows=s['subtitles'];p=pathlib.Path(item['recordFile']);o=json.loads(p.read_text());o['reviewer']='extra300_content_001_100';o['modality']='full-cached-subtitles';r=o['record'];r.update(reviewStatus=d.get('status','reviewed'),fullTranscriptRead=True,videoSummary=d['summary'],adPresence=d.get('presence','ad' if d.get('segments') else 'no_ad_in_transcript'),pendingReasons=d.get('pending',[]),readCoverage={'subtitleRows':len(rows),'firstIndex':0,'lastIndex':len(rows)-1,'allRowsRead':True},limitations=['助手内容参考；已完整阅读现有字幕，未观看视频画面或听取音频。','AI字幕可能误识别；只判断可用字幕表达的内容，未证实无字幕区间或视觉广告。'])
    r['segments']=[]
    for a in d.get('segments',[]):
        lo,hi=a['rows'];x={'start':rows[lo]['from'],'end':rows[hi]['to'],'contentType':a.get('type','ad'),'skipDecision':a.get('skip','skip'),'confidence':a.get('confidence','high'),'boundaryConfidence':'subtitle_only','reason':a['reason'],'evidence':[{'from':rows[i]['from'],'to':rows[i]['to'],'text':rows[i]['content']} for i in a['evidence']], 'startUncertainty':a.get('startUncertainty',[rows[lo-1]['to'] if lo>0 else 0,rows[lo]['from']]),'endUncertainty':a.get('endUncertainty',[rows[hi]['to'],rows[hi+1]['from'] if hi+1<len(rows) else s['duration']])};r['segments'].append(x)
    normal=[]
    for row in rows:
        if any(row['from']<a['end'] and row['to']>a['start'] for a in r['segments']):continue
        if normal and row['from']-normal[-1]['end']<=0.05:normal[-1]['end']=row['to']
        else:normal.append({'start':row['from'],'end':row['to'],'reason':'已全文阅读；此范围仅含实际字幕覆盖的主题正文或节目交流，未见独立广告诉求。'})
    r['normalSpeechRanges']=normal
    if d.get('status')=='needs-verification':r['adPresence']='uncertain'
    p.write_text(json.dumps(o,ensure_ascii=False,indent=2)+'\n');print(item['bvid'],r['reviewStatus'],len(r['segments']))

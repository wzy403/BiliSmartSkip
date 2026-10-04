const fs=require('fs');
const root='eval/labels/assistant-content-extra300/';
function read(p){return JSON.parse(fs.readFileSync(root+p));}
function frame(bv,tag,time,observation){const f=read(`acquisition/media/frames/${bv}/${tag}/frames.json`).find(f=>Math.abs(f.time-time)<.01);if(!f)throw Error('frame absent');return {...f,observation};}
function save(bv,fn){const p=root+'records/'+bv+'.json',o=JSON.parse(fs.readFileSync(p));fn(o,o.record);fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n');}
const media=read('acquisition/media/verified-media.json');
save('BV172hdz7EAF',(o,r)=>{
 const bv=r.bvid, s=r.segments[0];
 s.start=63;s.end=116;s.startUncertainty=[62,63];s.endUncertainty=[115,116];s.boundaryConfidence='subtitle-plus-selected-frames';
 s.reason='完整字幕与实际抽取画面共同确认：63秒“这课后题”起，没答案、搜索失败/付费压缩包、聚餐求助连续为元宝搜题推广铺垫；随后单题/整页搜题演示、试用号召、一键下载，以及元宝给学习建议的收尾持续到115秒，116秒转回下载IDE的编程笑话。不能把102.3秒口播结束当作广告结束。';
 s.evidence=s.evidence.filter(x=>x.from<116);
 s.visualEvidence=[frame(bv,'setup',63,'硬字幕“这课后题”，开始课后题无答案的需求铺垫。'),frame(bv,'setup',67,'搜索引擎“找了一早上”。'),frame(bv,'setup',72,'付费压缩包“咋还要钱？”；后接聚餐求助。'),frame(bv,'boundaries',81,'腾讯元宝图标、硬字幕“让腾讯元宝来解决”。'),frame(bv,'boundaries',104,'元宝标识及“一键下载”，口播结束后的推广收尾。'),frame(bv,'boundaries',115,'元宝界面给出学习建议，硬字幕“还得多实操！”'),frame(bv,'boundaries',116,'转入Visual Studio下载太慢的编程剧情。')];
 r.segments.push({start:130,end:143,contentType:'ad',skipDecision:'keep',confidence:'medium',boundaryConfidence:'selected-frames',startUncertainty:[129,130],endUncertainty:[142,143],reason:'指针抽象难理解→问问AI→代码输出→学习虽能用AI但考试得靠自己，构成前文商业工具使用的剧情回顾。它直接连接编程学习与考试的主题，保留完整情节；无独立购买/下载号召。广告属性依据同片元宝推广的上下文与工具画面，商业关系并未另行核实。',evidence:[],visualEvidence:[frame(bv,'boundaries',130,'指针的应用，硬字幕“抽象概念！”'),frame(bv,'boundaries',136,'硬字幕“问问AI！”'),frame(bv,'boundaries',138,'AI界面显示代码输出。'),frame(bv,'boundaries',140,'硬字幕“学习虽能用AI”。'),frame(bv,'boundaries',142,'硬字幕“考试得靠自己啊”。'),frame(bv,'boundaries',143,'转入考场/人肉编译器的后续情节。')]});
 r.reviewStatus='reviewed';r.adPresence='ad';r.pendingReasons=[];
 r.videoSummary='猫和老鼠画面改编的大学新生学编程短剧：课堂理解困难、找课后题答案受阻，插入腾讯元宝搜题及学习建议推广，随后回到IDE下载、调试、指针和考试笑话。独立功能推介含完整需求铺垫与视觉收尾；后续AI使用的剧情回顾保留。';
 r.limitations=['助手完整阅读24行字幕，并实际查看全片每5秒抽帧、59–73秒及72–145秒每1秒抽帧；未听音频，未声称逐帧或连续全片观看。抽帧间的瞬时画面仍可能遗漏。'];
 o.modality='full-cached-subtitles-plus-selected-local-frames';
 o.secondaryReview={reviewer:'assistant-extra300-root',fullTranscriptRead:true,subtitleRows:24,firstIndex:0,lastIndex:23,allRowsRead:true,decision:'补看画面将主广告从仅口播80.07–102.3扩大为含需求铺垫与视觉收尾的63–116；后续AI剧情回顾广告保留。'};
 o.visualObservations={reviewer:'assistant-extra300-root',media:media.find(m=>m.bvid===bv),frameIndexes:[root+`acquisition/media/frames/${bv}/frames.json`,root+`acquisition/media/frames/${bv}/setup/frames.json`,root+`acquisition/media/frames/${bv}/boundaries/frames.json`],method:'Selected decoded still frames at 5-second and 1-second intervals; no audio listened and no continuous/full-frame viewing claim.'};
});
save('BV12u2WB4EfP',(o,r)=>{
 const bv=r.bvid,s=r.segments.find(s=>s.contentType==='ad');
 s.start=47.86;s.end=89;s.startUncertainty=[47.86,49];s.endUncertainty=[88,89];s.boundaryConfidence='subtitle-plus-selected-frames';
 s.reason='从换新电脑/旧电脑如何处理的口播铺垫开始，连续转转上门回收、服务便利、支持品类、打包处理与品牌收尾。实际画面88秒仍为转转标识与收尾字幕，89秒恢复植物大战僵尸对局，故完整保留至89秒。';
 s.visualEvidence=[frame(bv,'boundaries',49,'游戏背景上硬字幕“最近换了新电脑”。'),frame(bv,'boundaries',54,'转入回收人员和旧电脑实拍推介。'),frame(bv,'boundaries',88,'转转品牌卡与“找转转这种大平台准没错”收尾。'),frame(bv,'boundaries',89,'恢复植物大战僵尸对局。')];
 r.reviewStatus='reviewed';r.adPresence='ad';r.pendingReasons=[];
 r.videoSummary='植物大战僵尸套娃礼盒巨人海无车噩梦挑战。介绍规则后插入转转旧电脑回收推广，随后长段游戏实战与背景音乐，最后点赞关注收尾。游戏实战不是广告；没有因歌词ASR乱码直接判为无广告，已补看覆盖全片的抽帧及广告边界。';
 r.limitations=['助手完整阅读69行字幕，实际查看全片每10秒抽帧及39–97秒每1秒抽帧。长字幕空白对应抽帧可见游戏实战；未听音频，未声称连续全片或逐帧观看，抽帧间瞬时叠加仍可能遗漏。'];
 o.modality='full-cached-subtitles-plus-selected-local-frames';o.secondaryReview={reviewer:'assistant-extra300-root',fullTranscriptRead:true,subtitleRows:69,firstIndex:0,lastIndex:68,allRowsRead:true,decision:'全字幕与抽帧复核确认完整转转广告47.86–89秒，89秒后恢复游戏主体。'};
 o.visualObservations={reviewer:'assistant-extra300-root',media:media.find(m=>m.bvid===bv),frameIndexes:[root+`acquisition/media/frames/${bv}/overview/frames.json`,root+`acquisition/media/frames/${bv}/boundaries/frames.json`],method:'Selected decoded still frames at 10-second and 1-second intervals; no audio listened and no continuous/full-frame viewing claim.'};
});

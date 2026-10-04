import subprocess,re,json,sys,pathlib,hashlib
from PIL import Image,ImageDraw,ImageFont
base=pathlib.Path('eval/labels/assistant-content-extra300/acquisition/media')
bv,tag,start,end,step=sys.argv[1],sys.argv[2],float(sys.argv[3]),float(sys.argv[4]),float(sys.argv[5])
media=pathlib.Path(sys.argv[6]) if len(sys.argv)>6 else base/(bv+'.mp4')
out=base/'frames'/bv/tag;out.mkdir(parents=True,exist_ok=True)
vf=f"select='between(t,{start},{end})*(isnan(prev_selected_t)+gte(t-prev_selected_t,{step}))',scale=480:-2,showinfo"
p=subprocess.run(['/opt/homebrew/bin/ffmpeg','-y','-i',str(media),'-vf',vf,'-fps_mode','vfr',str(out/'frame-%03d.jpg')],capture_output=True,text=True,check=True)
times=[float(x) for x in re.findall(r'pts_time:([\d.]+)',p.stderr)]
files=sorted(out.glob('frame-*.jpg'))
assert len(times)==len(files)
rows=[dict(time=t,file=str(f),sha256=hashlib.sha256(f.read_bytes()).hexdigest()) for t,f in zip(times,files)]
(out/'frames.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',22)
for off in range(0,len(rows),9):
 group=rows[off:off+9];w,h=Image.open(group[0]['file']).size
 sheet=Image.new('RGB',(w*3,(h+28)*3),'white');draw=ImageDraw.Draw(sheet)
 for j,r in enumerate(group):
  x=(j%3)*w;y=(j//3)*(h+28);draw.text((x+5,y+2),f"{r['time']:.3f}s",fill='black',font=font);sheet.paste(Image.open(r['file']),(x,y+28))
 sheet.save(out/f'contact-{off//9+1:02}.jpg',quality=92)
print(json.dumps(dict(bvid=bv,tag=tag,frames=len(rows),contacts=(len(rows)+8)//9)))

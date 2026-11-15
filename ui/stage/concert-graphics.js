/* One deterministic 1920×1080 drawing surface for preview, PGM and rendering. */
(function () {
'use strict';
const W=1920,H=1080, TAU=2*Math.PI;
const sans='"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif';
const serif='"Noto Serif CJK SC","Songti SC","SimSun",serif';
const brush='"Kaiti SC","KaiTi","STKaiti","Noto Serif CJK SC","SimSun",serif';
const mono='"Consolas","SFMono-Regular",monospace';
const pool=new Map();
const assetPath=(value)=>typeof value==='string'&&/^[a-f0-9]{32}\.(?:png|jpe?g|webp)$/i.test(value)?'/assets/'+value:'';
function picture(s){
 if(!s||!/^\/assets\/[a-f0-9]{32}\.(?:png|jpe?g|webp)$/i.test(s))return null;
 if(pool.has(s))return pool.get(s);
 const img=new Image(), ent={img,ok:false,p:null};
 ent.p=new Promise(resolve=>{img.onload=()=>{ent.ok=true;resolve();};img.onerror=()=>resolve();});
 pool.set(s,ent); if(pool.size>12)pool.delete(pool.keys().next().value);
 img.src=s;return ent;
}
function ready(cue){
 return Promise.all([
  picture(assetPath(cue?.portraitAsset))?.p,
  cue?.mainEnabled&&cue.full!==false&&!['lyrics','bug'].includes(cue.type)?picture(assetPath(cue.mainAsset))?.p:null,
 ]);
}
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const ease=x=>1-Math.pow(1-clamp(x),3);
const cut=(s,n=110)=>Array.from(String(s??'').trim()).slice(0,n).join('');
function rng(seed){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return (seed>>>0)/4294967296;};}
function line(c,x,y,u,v,co,weight=1){
 c.beginPath();c.moveTo(x,y);c.lineTo(u,v);c.strokeStyle=co;c.lineWidth=weight;c.stroke();
}
function ellipse(c,x,y,rx,ry,co,angle=0){
 c.beginPath();c.ellipse(x,y,rx,ry,angle,0,TAU);c.fillStyle=co;c.fill();
}
function glow(c,x,y,r,stops){
 const g=c.createRadialGradient(x,y,0,x,y,r);stops.forEach(([n,col])=>g.addColorStop(n,col));
 c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2);
}
function text(c,s,x,y,o={}){
 const {size=28,font=sans,weight=500,color='#fff',align='left',max=NaN}=o;
 s=cut(s);c.font=weight+' '+size+'px '+font;c.textAlign=align;c.textBaseline='alphabetic';c.fillStyle=color;
 if(Number.isFinite(max)&&c.measureText(s).width>max){
  const k=Math.max(.42,max/c.measureText(s).width);
  c.font=weight+' '+Math.floor(size*k)+'px '+font;
  c.fillText(s,x,y,max);
 } else c.fillText(s,x,y);
}
function tracked(c,s,x,y,spacing,color='#fff',size=16){
 c.font='500 '+size+'px '+mono;c.textAlign='left';c.textBaseline='alphabetic';c.fillStyle=color;
 Array.from(s).forEach(ch=>{c.fillText(ch,x,y);x+=c.measureText(ch).width+spacing;});
}
const texture=(()=>{
 const tex=document.createElement('canvas');tex.width=tex.height=384;
 const c=tex.getContext('2d'),q=rng(118);
 for(let i=0;i<510;i++){
  const x=Math.floor(q()*384),y=Math.floor(q()*384),w=q()<.10?2:1;
  c.fillStyle=i%2?'#ffdfbe19':'#09040a30';
  c.fillRect(x,y,w,1);
 }
 return tex;
})();
function photo(c,img,x,y,w,h,page){
 if(!img)return;
 const k=Math.max(w/img.naturalWidth,h/img.naturalHeight), sw=w/k,sh=h/k;
 c.drawImage(img,(img.naturalWidth-sw)/2,(img.naturalHeight-sh)*.32,sw,sh,x,y,w,h);
 if(page){const g=c.createLinearGradient(x,y,x,y+h);g.addColorStop(0,'#27101422');g.addColorStop(.56,'#2913130b');g.addColorStop(1,'#210e1d9c');c.fillStyle=g;c.fillRect(x,y,w,h);}
}
function titleWrap(c,s,n){
 const a=Array.from(cut(s,36)); if(a.length<=n)return [a.join('')];
 const step=Math.ceil(a.length/2);return [a.slice(0,step).join(''),a.slice(step).join('')];
}
function readLines(s,num=5){
 return String(s||'').split(/\r?\n/).map(z=>cut(z,72)).filter(Boolean).slice(0,num);
}
function poly(c,points,fill,stroke,width=1){c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();if(fill){c.fillStyle=fill;c.fill();}if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke();}}
function leaf(c,x,y,size,ang,col){
 c.save();c.translate(x,y);c.rotate(ang);c.scale(size/100,size/100);
 poly(c,[[0,44],[0,12],[-31,8],[-24,-3],[-50,-18],[-32,-18],[-35,-47],[-10,-32],[0,-60],[12,-32],[35,-47],[32,-20],[51,-17],[25,0],[31,9],[3,13],[5,44]],col);
 c.restore();
}
const q50={night:'#09223f',blue:'#133e69',lake:'#237e93',mint:'#84ddbe',lime:'#e0ed78',cloud:'#f6fcff',sun:'#ffc674'};
const finaleTypes=['award','bug','finaleCast'];
function plane(c,x,y,size,angle=0,fill=q50.cloud){
 c.save();c.translate(x,y);c.rotate(angle);c.scale(size/100,size/100);
 poly(c,[[-50,-17],[53,-29],[5,29],[-6,7],[-24,24],[-21,0]],fill);
 poly(c,[[-21,0],[53,-29],[-6,7],[-24,24]],'#9ecadf');
 line(c,-21,0,53,-29,'#e2f9ff',1.2);c.restore();
}
function record50(c,x,y,r,phase=0){
 c.save();c.translate(x,y);c.rotate(phase);ellipse(c,0,0,r,r,q50.night);
 for(let i=0;i<9;i++){
  const radius=r*(.91-i*.071);c.beginPath();c.arc(0,0,radius,-.2+i*.11,TAU-.7+i*.11);
  c.strokeStyle=i%3===0?q50.mint:q50.lake;c.lineWidth=Math.max(.5,r*.026);c.stroke();
 }
 ellipse(c,0,0,r*.272,r*.272,q50.lime);ellipse(c,0,0,r*.073,r*.073,q50.blue);
 c.restore();
}
function bitmap50(c,x,y,w,h,t){
 c.save();c.translate(x,y);c.scale(w/W,h/H);
 const g=c.createLinearGradient(200,0,1600,1120);
 g.addColorStop(0,'#0a334e');g.addColorStop(.45,'#197886');g.addColorStop(1,'#104367');
 c.fillStyle=g;c.fillRect(0,0,W,H);
 glow(c,1353,580,622,[[0,'#5dd4a29c'],[.5,'#387a7990'],[1,'#245b7100']]);
 c.save();c.globalAlpha*=.77;record50(c,1386,541,367,t*.16);c.restore();
 const q=rng(513);
 for(let i=0;i<141;i++){
  const x=(i%2===0?0:1450)+q()*(i%2===0?300:470),y=155+q()*870,r=17+q()*92;
  const palette=['#2f9465','#63a656','#9abb57','#e7bf46','#ef9d4b','#234e62'];
  c.globalAlpha*=.84;leaf(c,x,y,r,q()*TAU,palette[(q()*palette.length)|0]);c.globalAlpha/=.84;
 }
 for(let k=0;k<5;k++){
  c.beginPath();
  for(let i=0;i<=130;i++){const x=i*15, y=735+k*16+79*Math.sin(x/285+1.6)-34*Math.sin(x/1442+t*.18);c[i?'lineTo':'moveTo'](x,y);}
  c.strokeStyle=k===2?'#b9f5eab3':'#b9f5ea58';c.lineWidth=k===2?3:2;c.stroke();
 }
 c.save();c.globalAlpha*=.64;plane(c,1428,418,202,-.15);plane(c,1674,282,137,-.30);plane(c,921,768,114,-.12);c.restore();
 c.fillStyle=c.createPattern(texture,'repeat');c.fillRect(0,0,W,H);c.restore();
}
function drawing50(c,x,y,w,scale=1){
 c.save();c.translate(x,y);c.scale(w/143,scale);
 const silhouette='#61968a';
 // Original-inspired campus silhouette: angled classroom building, trees and lattice screen.
 poly(c,[[0,24],[3,14],[26,5],[51,12],[56,38],[1,38]],silhouette);
 poly(c,[[3,20],[28,10],[50,16],[50,34],[3,33]],'#72a18f');
 for(let row=0;row<3;row++)for(let i=0;i<7;i++){
   const bx=6+i*6, by=21+row*6-(i<4?i:(6-i))*.92;
   poly(c,[[bx,by],[bx+4,by-.9],[bx+4,by+2.7],[bx,by+3.5]],'#075178');
 }
 poly(c,[[93,36],[98,14],[114,7],[142,10],[143,40]],silhouette);
 for(let i=0;i<5;i++){
  line(c,100+i*8,23,106+i*8,33,'#10627e',.8);
  line(c,106+i*8,23,100+i*8,33,'#10627e',.8);
 }
 line(c,72,16,73,40,silhouette,4);
 for(const [xx,yy,rx,ry] of [[66,15,17,9],[73,10,18,12],[86,17,17,10],[58,23,12,8],[88,26,12,6],[60,35,21,4],[84,36,22,5]])
  ellipse(c,xx,yy,rx,ry,silhouette);
 c.fillStyle=silhouette;c.fillRect(0,37,143,5);c.restore();
}
function rail50(c,x,y,w,h,t,{compact=false,planeVisible=true}={}){
 const lip=Math.min(70,w*.14),g=c.createLinearGradient(x,y,x+w,y+h);
 g.addColorStop(0,compact?'#0264aff7':'#103c6af5');g.addColorStop(.58,compact?'#116ba5f6':'#175775f2');g.addColorStop(1,compact?'#125b8af4':'#197a7ae8');
 poly(c,[[x+16,y+6],[x+w-45,y+6],[x+w+7,y+24],[x+w-lip+10,y+h+9],[x+10,y+h+9]],'#0a2c50d9');
 poly(c,[[x+25,y],[x+w-62,y],[x+w,y+19],[x+w-lip,y+h],[x,y+h]],g,'#ebf364',2.1);
 if(compact){
  c.save();c.globalAlpha*=.91;drawing50(c,x+19,y+h-77,Math.min(w*.89,487),1.63);c.restore();
 }else{
  c.save();c.globalAlpha*=.75;drawing50(c,x+31,y-40,Math.min(w*.26,168),1);c.restore();
 }
 const d=c.createLinearGradient(x,0,x+w,0);
 d.addColorStop(0,'#b7e66d00');d.addColorStop(.27,'#e0e859');d.addColorStop(.86,'#8fe8bb');d.addColorStop(1,'#a9efd400');
 poly(c,[[x+3,y+h-9],[x+w-lip+8,y+h-9],[x+w-lip,y+h],[x,y+h]],d);
 if(planeVisible){
  const drift=Math.sin(t*2.1)*5;
  if(compact)plane(c,x+30+drift,y+h-33,116,-.17);else plane(c,x+w-63+drift,y+12,Math.min(102,w*.28),-.12);
 }
}
function text50(c,s,x,y,size,o={}){
 text(c,s,x,y,{size,font:o.brush?brush:sans,weight:o.weight?Math.round(o.weight/100)*100:800,color:o.color||q50.cloud,max:o.max,align:o.align||'left'});
}
function section50(c,s,x,y,size=22){
 text50(c,s,x,y,size,{color:q50.lime,weight:730,max:1250});
}
function cue50(c,cue,t,e){
 const title=cue.type==='title',special=cue.type==='guest';
 const label=title?'节目报幕':special?'特邀嘉宾':'参赛选手';
 const primary=title?(cue.title||cue.show||'深秋歌会'):(cue.name||label);
 const sub=title?(cue.name||cue.subtitle):(cue.title||cue.subtitle);
 const portrait=picture(assetPath(cue.portraitAsset));
 c.save();c.globalAlpha*=e;
  const x=107-(1-e)*30,y=797+(1-e)*22,w=521,h=208;
  rail50(c,x,y,w,h,t,{compact:true});
  const inset=portrait?.ok&&!title?93:0;
  if(inset){
   const px=x+41,py=y+29;c.fillStyle=q50.lime;c.fillRect(px,py,79,98);
   photo(c,portrait.img,px+2,py+2,75,94,true);
  }
  section50(c,label+(cue.number&&!title?'  /  '+cue.number:''),x+111+inset,y+39,20);
  text50(c,primary,x+111+inset,y+100,48,{max:w-135-inset});
  text50(c,sub||'',x+123+inset,y+144,28,{max:w-161-inset,weight:580,color:'#e7faff'});
  c.restore();
}
function lyric50(c,cue,t,e){
 const first=cut(cue.lyrics,94), second=cut(cue.lyric2,94);if(!first&&!second)return;
 c.save();c.globalAlpha*=e;c.translate(0,22*(1-e));
 const x=111,y=second&&first?951:977, r=43;
 const shade=c.createLinearGradient(120,0,1610,0);shade.addColorStop(0,'#04162ab3');shade.addColorStop(.7,'#05172b43');shade.addColorStop(1,'#05172b00');
 c.fillStyle=shade;c.fillRect(206,y-48,1396,second&&first?94:61);
 record50(c,x+r,967,r,t*.85);
 c.shadowColor='#030918';c.shadowBlur=14;c.shadowOffsetY=3;
 text50(c,first||second,x+109,y,48,{max:1258});
 if(first&&second)text50(c,second,x+110,y+41,29,{color:'#d8f2f5',weight:560,max:1450});
 c.restore();
}
function bug50(c,cue,t,e){
 c.save();c.globalAlpha*=e;
 const x=1623,y=925;
 c.save();c.globalAlpha*=.86;record50(c,x+53,y+43,42,t*.83);c.restore();
 plane(c,x+116+5*Math.sin(t*2),y+34,90,-.19);
 c.shadowColor='#081e35';c.shadowBlur=11;
 text50(c,cue.show||'深秋歌会',x+46,y+61,25,{brush:true,max:118,color:q50.lime});
 text50(c,cue.title||'北京理工大学',x+48,y+78,13,{color:'#d3f6f5',weight:650,max:112});
 c.restore();
}
function rank50(c,cue,t,e){
 const rows=(Array.isArray(cue.ranks)?cue.ranks:[]).slice(0,8), mini=rows.length>5;
 if(rows.length<=3){
  const x=108,y=760,w=552,h=240;
  c.save();c.globalAlpha*=e;rail50(c,x,y,w,h,t,{compact:true});
  text50(c,cue.title||'最终排名',x+91,y+52,41,{max:350,brush:true});
  if(cue.subtitle)text50(c,cue.subtitle,x+w-46,y+48,20,{max:165,align:'right',color:'#d8f6ef'});
  rows.forEach((row,i)=>{
   const a=ease((t-.43-i*.11)/.4);if(!a)return;
   c.save();c.globalAlpha*=a;
   const yy=y+96+i*46;
   text50(c,['冠军','亚军','季军'][i],x+117,yy,28,{color:q50.lime});
   text50(c,row.name,x+265,yy,31,{max:171});
   text50(c,row.score||'',x+w-48,yy,22,{align:'right',max:81,color:'#dbffe9'});
   c.restore();
  });
  c.restore();return;
 }
 const x=125,w=859,h=mini?64:84,y=964-108-rows.length*h;
 c.save();c.globalAlpha*=e;
 rail50(c,x,y,w,90,t);
 text50(c,cue.title||'最终排名',x+60,y+58,50,{max:w-316,brush:true});
 if(cue.subtitle)text50(c,cue.subtitle,x+w-120,y+57,24,{max:325,align:'right',color:'#d8f6ef',weight:550});
 rows.forEach((row,i)=>{
  const a=ease((t-.15-i*.10)/.54);if(!a)return;
  const yy=y+108+i*h;
  c.save();c.globalAlpha*=a;c.translate((1-a)*43,0);
  const gr=c.createLinearGradient(x,yy,x+w,yy);gr.addColorStop(0,i===0?'#28476ff9':'#123f67f4');gr.addColorStop(1,i===0?'#2a7a77f5':'#1e6179e8');
  poly(c,[[x+18,yy],[x+w,yy],[x+w-28,yy+h-11],[x,yy+h-11]],gr,i===0?q50.lime:'#87d8b986');
  text50(c,['冠军','亚军','季军'][i]||('第 '+(i+1)+' 名'),x+51,yy+h*.57,mini?27:40,{color:i===0?q50.lime:'#b1ead9',max:160});
  text50(c,row.name,x+244,yy+h*.57,mini?31:43,{max:w-560});
  text50(c,row.score||'',x+w-65,yy+h*.57,mini?27:34,{align:'right',max:230,color:q50.lime});
  c.restore();
 });
 c.restore();
}
function award50(c,cue,t,e){
 const portrait=picture(assetPath(cue.portraitAsset));
  const x=108,y=760,w=552,h=240;
  c.save();c.globalAlpha*=e;rail50(c,x,y,w,h,t,{compact:true});
  const use=Boolean(portrait?.ok);
  if(use){c.fillStyle=q50.lime;c.fillRect(x+95,y+77,98,112);photo(c,portrait.img,x+98,y+80,92,106,true);}
  text50(c,cue.title||'最佳人气奖',x+96,y+57,40,{brush:true,max:400,color:q50.lime});
  text50(c,cue.name||'获奖选手',x+(use?214:126),y+122,49,{brush:true,max:use?282:365});
  text50(c,cue.subtitle||cue.credits||'',x+(use?216:128),y+172,25,{max:use?273:340,weight:560,color:'#e2fcf9'});
  c.restore();
}
function cast50(c,cue,t,e){
 const rows=(Array.isArray(cue.ranks)?cue.ranks:[]).slice(0,6);
 const x=99,w=517,y=875,gap=7,bw=(w-2*gap)/3,h=61;
 c.save();c.globalAlpha*=e;
 rail50(c,x,y-76,w,60,t);
 text50(c,cue.title||'本轮选手',x+50,y-38,30,{max:385,brush:true});
 rows.forEach((row,i)=>{
  const a=ease((t-.29-i*.085)/.54);if(!a)return;
  const xx=x+(i%3)*(bw+gap),yy=y+Math.floor(i/3)*(h+gap);
  c.save();c.globalAlpha*=a;
  poly(c,[[xx+8,yy],[xx+bw,yy],[xx+bw-13,yy+h],[xx,yy+h]],'#185e78ee','#96d6ad',1.25);
  text50(c,String(i+1).padStart(2,'0'),xx+14,yy+h*.43,16,{color:q50.lime});
  text50(c,row.name,xx+41,yy+h*.52,25,{max:bw-52});
  text50(c,row.score||'',xx+41,yy+h*.83,14,{color:'#c8f5eb',max:bw-50,weight:520});c.restore();
 });
 c.restore();
}
const centerFrame=Object.freeze({x:312,y:206,w:1296,h:668});
function centerPath(c,b){
 const {x,y,w,h}=b,d=33;
 c.beginPath();c.moveTo(x+d,y);c.lineTo(x+w,y);c.lineTo(x+w,y+h-d);
 c.lineTo(x+w-d,y+h);c.lineTo(x,y+h);c.lineTo(x,y+d);c.closePath();
}
function centerSurface(c,cue,t){
 const b=centerFrame, {x,y,w,h}=b, maxAlpha=c.globalAlpha;
 c.save();centerPath(c,b);c.clip();
 c.globalAlpha=maxAlpha*.73;
 bitmap50(c,x,y,w,h,t);
 const native=cue.mainEnabled?picture(assetPath(cue.mainAsset)):null;
 if(native?.ok) {
  const img=native.img;
  const scale=(cue.mainFit==='contain'?Math.min:Math.max)(w/img.naturalWidth,h/img.naturalHeight);
  const ww=img.naturalWidth*scale,hh=img.naturalHeight*scale;
  c.globalAlpha=maxAlpha*.94;
  c.drawImage(img,x+(w-ww)/2,y+(h-hh)/2,ww,hh);
 }
 c.globalAlpha=maxAlpha;
 const g=c.createRadialGradient(960,531,234,960,531,734);
 g.addColorStop(0,'#04213de2');g.addColorStop(.49,'#082e4db0');g.addColorStop(1,'#0e395136');
 c.fillStyle=g;c.fillRect(x,y,w,h);
 c.restore();
 c.save(); centerPath(c,b);c.strokeStyle='#d8ed8c';c.lineWidth=2.2;c.stroke();
 line(c,x+33,y+10,x+229,y+10,'#92e6cddd',2);
 line(c,x+w-235,y+h-10,x+w-35,y+h-10,'#92e6cddd',2);
 plane(c,x+w-91,y+76,102,-.16);
 c.restore();
}
function centerHeading(c,cue,label,y=300){
 const subtitle=cue.show||'深秋歌会';
 text50(c,subtitle,960,y-27,23,{color:'#b7f8de',align:'center',max:720});
 text50(c,label,960,y+14,38,{color:q50.lime,brush:true,align:'center',max:1000});
 line(c,891,y+34,1029,y+34,'#9ce5bfaa',1.2);
}
function centerTitle(c,cue,e){
 const t=cue.type, title=t==='title', award=t==='award';
 const label=award?(cue.title||'最佳人气奖'):title?'节目报幕':t==='guest'?'特邀嘉宾':'参赛选手';
 const headline=title?(cue.title||cue.show||'深秋歌会'):(cue.name||label);
 const tagged=(!title&&!award&&cue.number)?label+'  /  '+cut(cue.number,12):label;
 centerHeading(c,cue,tagged,302);
 const portrait=(!title||cue.portraitAsset)?picture(assetPath(cue.portraitAsset)):null;
 if(portrait?.ok) {
  const xx=495,yy=386,ww=280,hh=330;
  c.fillStyle=q50.lime;c.fillRect(xx-3,yy-3,ww+6,hh+6);
  photo(c,portrait.img,xx,yy,ww,hh,true);
  plane(c,xx+ww-8,yy+27,78,-.21);
 }
 const hasPortrait=Boolean(portrait?.ok),tx=hasPortrait?838:960, align=hasPortrait?'left':'center';
 const max=hasPortrait?598:1086, ls=titleWrap(c,headline,hasPortrait?7:10);
 const titleY=ls.length===1?539:490;
 c.save();c.translate(0,(1-e)*18);c.globalAlpha*=e;
 ls.forEach((part,i)=>text50(c,part,tx,titleY+i*101,ls.length===1?(hasPortrait?88:123):(hasPortrait?80:95),{max,brush:true,align}));
 const lineY=ls.length===1?590:626;
 line(c,hasPortrait?tx:814,lineY,hasPortrait?tx+235:1106,lineY,'#d8eb91cc',2);
 const rows=[title?cue.name:award?cue.subtitle:cue.title,title?cue.subtitle:award?null:cue.subtitle,...readLines(cue.credits,3)].filter(Boolean).slice(0,4);
 rows.forEach((v,i)=>text50(c,v,tx,lineY+44+i*36,i?24:33,{max,align,color:i?'#c5ebe8':q50.cloud,weight:i?500:700}));
 c.restore();
}
function centerRanks(c,cue,t){
 const rows=Array.isArray(cue.ranks)?cue.ranks.slice(0,8):[];
 centerHeading(c,cue,cue.title||'最终排名');
 const n=rows.length,h=n<4?87:n<6?65:52, x=482,w=956;
 const y0=569-(n*h)/2;
 rows.forEach((row,i)=>{
  const f=ease((t-.27-i*.10)/.48);if(!f)return;
  const y=y0+i*h;
  c.save();c.globalAlpha*=f;c.translate(25*(1-f),0);
  poly(c,[[x+18,y],[x+w,y],[x+w-17,y+h-7],[x,y+h-7]],i===0?'#125868f5':'#0c3b60e8',i===0?q50.lime:'#a0d8c77f',i===0?2:1);
  text50(c,['冠军','亚军','季军'][i]||('第 '+(i+1)+' 名'),x+38,y+h*.59,n<4?34:25,{color:q50.lime,max:170});
  text50(c,row.name,x+217,y+h*.59,n<4?40:28,{max:478});
  text50(c,row.score||'',x+w-45,y+h*.59,n<4?33:24,{max:160,align:'right',color:'#d4ef9b'});
  c.restore();
 });
 if(cue.subtitle)text50(c,cue.subtitle,960,823,24,{align:'center',max:970,color:'#d3f8ee'});
}
function centerCast(c,cue,t){
 const rows=Array.isArray(cue.ranks)?cue.ranks.slice(0,6):[];
 centerHeading(c,cue,cue.title||'本轮选手');
 const x=476,w=968,gap=14,bw=(w-2*gap)/3,h=141,y0=rows.length>3?430:474;
 rows.forEach((row,i)=>{
  const f=ease((t-.22-i*.085)/.5);if(!f)return;
  const xx=x+(i%3)*(bw+gap),yy=y0+Math.floor(i/3)*(h+gap);
  c.save();c.globalAlpha*=f;
  poly(c,[[xx+15,yy],[xx+bw,yy],[xx+bw-15,yy+h],[xx,yy+h]],'#134f6ce8','#9be4c8',1.2);
  text50(c,String(i+1).padStart(2,'0'),xx+22,yy+48,28,{color:q50.lime});
  text50(c,row.name,xx+81,yy+60,39,{max:bw-105});
  text50(c,row.score||'',xx+82,yy+104,24,{max:bw-105,color:'#ceefe7',weight:500});
  c.restore();
 });
}
function drawFinale50(c,cue,center,t,e,motion){
 if(cue.type==='lyrics'){lyric50(c,cue,t,e);return;}
 if(cue.type==='bug'){bug50(c,cue,t,e);return;}
 if(center){
  c.save();
  centerSurface(c,cue,t);
  centerPath(c,centerFrame);c.clip();
  if(cue.type==='rank')centerRanks(c,cue,motion);
  else if(cue.type==='finaleCast')centerCast(c,cue,motion);
  else centerTitle(c,cue,e);
  c.restore();
  return;
 }
 if(cue.type==='rank')rank50(c,cue,motion,e);
 else if(cue.type==='award')award50(c,cue,t,e);
 else if(cue.type==='finaleCast')cast50(c,cue,motion,e);
 else cue50(c,cue,t,e);
}
function render(canvas,cue,opts={}){
 const c=canvas.getContext('2d');if(!c)return;
 c.setTransform(1,0,0,1,0,0);c.globalCompositeOperation='source-over';c.globalAlpha=1;
 c.clearRect(0,0,canvas.width,canvas.height);
 if(!cue||!['title','lyrics','rank','guest','contestant',...finaleTypes].includes(cue.type))return;
 const s=Math.min(canvas.width/W,canvas.height/H),x=(canvas.width-W*s)/2,y=(canvas.height-H*s)/2;
 c.save(); c.translate(x,y); c.scale(s,s);
 const time=Number.isFinite(opts.time)?opts.time:2, t=Math.max(0,time);const duration=Number(opts.duration)||0;
 const centered=cue.type!=='lyrics' && cue.type!=='bug' && cue.full!==false;
 const amount=opts.phase==='out'?1-ease(t/.46):ease(t/.61)*(duration>0?ease((duration-t)/.48):1);
 if(amount<=0){c.restore();return;}
 c.globalAlpha=amount;
 const e=opts.phase==='out'?1:ease(t/.67);
 const motion=opts.phase==='out'?2:t;
 drawFinale50(c,cue,centered,t,e,motion);
 c.restore();
}
window.StageGraphics={render,ready};
})();

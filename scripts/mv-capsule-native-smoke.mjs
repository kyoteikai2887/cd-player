import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { openLocalStore } from '../src/local/store.ts';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';
import { linkVideo } from '../src/local/musicVideos.ts';
import { themePatch } from '../src/ui/lib/theme.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'.cache','mv-native-'+Date.now());await mkdir(output);
const data=path.join(output,'data'), movie=path.join(output,'MV 中文 & 日本語.mkv');
await writeFile(movie,Buffer.from('1a45dfa3','hex'));
const store=await openLocalStore(data);let albumId,videoId;
try{const scan=await scanFolder(path.join(root,'.cache/audio-check'),path.join(data,'covers'),new AbortController().signal);
 await store.transact(d=>{mergeScan(d,scan);albumId=d.library.albums[0].id;linkVideo(d,albumId,movie);
   videoId=Object.keys(d.musicVideos)[0];d.potPlayerPath=path.join(output,'missing','PotPlayerMini64.exe');});
}finally{await store.close();}
const saved=()=>readFile(path.join(data,'library.json'),'utf8').then(JSON.parse);
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const report=path.join(output,'native.json');
const child=spawn(path.join(root,'src-tauri/target/debug/cd-player-desktop.exe'),['--smoke-data',data,'--smoke-report',report,'--smoke-manual'],{
 cwd:root,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
const done=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
const delay=ms=>new Promise(r=>setTimeout(r,ms));const run=promisify(execFile);
function connect(url){return new Promise((resolve,reject)=>{const socket=new WebSocket(url),pending=new Map();let id=0;
 socket.addEventListener('error',reject,{once:true});socket.addEventListener('message',e=>{const msg=JSON.parse(e.data),p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);});
 socket.addEventListener('open',()=>resolve({socket,send(method,params={}){return new Promise((r,j)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);j(Error(method+' timed out'));},15000);pending.set(key,{resolve:r,reject:j,timer});socket.send(JSON.stringify({id:key,method,params}));});}}));});}
async function evaluate(c,expression){const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(c,expression){for(let i=0;i<100;i++){if(await evaluate(c,expression))return;await delay(100);}throw Error('Timeout: '+expression);}
const snapshot=c=>evaluate(c,"window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot)");
async function act(c,action){const result=await evaluate(c,`(async()=>{const i=window.__TAURI_INTERNALS__.invoke,now=await i('clock_sample');return i('dispatch_action',{surface:'main',action:${JSON.stringify(action)},deadlineMs:now+4500});})()`);assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function click(c,selector){await until(c,'!!document.querySelector('+JSON.stringify(selector)+')');await evaluate(c,'document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"center"})');await delay(100);
 let p;for(let attempt=0;attempt<60;attempt++){
  p=await evaluate(c,'(()=>{const e=document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,reachable:h===e||e.contains(h)}})()');
  if(p.reachable)break;await delay(100);
 }
 assert.ok(p.reachable,'Pointer target blocked: '+selector);
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});}
async function shot(c,name){await evaluate(c,'document.fonts.ready.then(()=>true)');await delay(180);const r=await c.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
async function potProcesses(){const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"ConvertTo-Json -Compress -InputObject @(Get-Process PotPlayerMini64,PotPlayerMini,PotPlayer64,PotPlayer -ErrorAction SilentlyContinue | Select-Object Id,ProcessName)"],{windowsHide:true});return JSON.parse(r.stdout.trim()||'[]');}
const checks=[],layouts=[],pages={};let error,ownedPlayer=[];
try{
 for(let i=0;i<100&&!(pages.main&&pages.mini);i++){try{const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();for(const t of targets.filter(t=>t.type==='page')){const c=await connect(t.webSocketDebuggerUrl),surface=await evaluate(c,"document.querySelector('.cdp')?.dataset.surface");if(['main','mini'].includes(surface)&&!pages[surface])pages[surface]=c;else c.socket.close();}}catch{}if(!(pages.main&&pages.mini))await delay(150);}
 assert.ok(pages.main&&pages.mini);const c=pages.main;
 // Create a short silent VP8 movie locally; update the EBML DocType from WebM to Matroska.
 const recorded=await evaluate(c,`(async()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');let n=0;const paint=()=>{ctx.fillStyle='#163c57';ctx.fillRect(0,0,320,180);ctx.fillStyle='#c7ddec';ctx.font='20px sans-serif';ctx.fillText('CD Player MV test',55,90);ctx.fillRect(20+n++%280,130,20,8);};paint();const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);const finish=new Promise(r=>recorder.onstop=r);const timer=setInterval(paint,100);recorder.start();await new Promise(r=>setTimeout(r,1200));recorder.stop();await finish;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());const b=new Uint8Array(await new Blob(chunks).arrayBuffer());let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.slice(i,i+16384));return btoa(s);})()`);
 const webm=Buffer.from(recorded,'base64'),doctype=webm.indexOf(Buffer.from('webm'));assert.equal(webm[doctype-1],0x84);assert.equal(webm[4]&0x80,0x80);
 const mkv=Buffer.concat([webm.subarray(0,doctype-1),Buffer.from([0x88]),Buffer.from('matroska'),webm.subarray(doctype+4)]);mkv[4]+=4;await writeFile(movie,mkv);checks.push('synthetic Matroska VP8 fixture created locally');
 await act(c,{type:'setRepeat',repeat:'one'});await act(c,{type:'playAlbum',albumId});
 const state=await snapshot(c);assert.equal(state.player.status,'playing');const queue=state.player.queue;
 await evaluate(c,'document.querySelector("button[aria-label^=打开专辑]")?.click()');
 // The capsule always opens now-playing; shelf album cards have a stable data-album id.
 const card=await evaluate(c,`(()=>{const buttons=[...document.querySelectorAll('button')];const title=${JSON.stringify(state.library.albums.find(a=>a.id===albumId).title)};const b=buttons.find(b=>b.getAttribute('aria-label')==='打开专辑：'+title)||buttons.find(b=>b.textContent.includes(title)&&b.getAttribute('aria-label')?.includes('专辑'));if(b){b.click();return true;}return false;})()`);
 if(!card) await evaluate(c,`(()=>{const el=document.querySelector('[data-album-id="${albumId}"]');if(el)el.click();})()`);
 await until(c,'!!document.querySelector('+JSON.stringify('button[aria-label^="用 PotPlayer 播放："]')+')');
 await click(c,'button[aria-label^="用 PotPlayer 播放："]');await until(c,'!!document.querySelector("[data-code=notFound]")');
 assert.equal((await snapshot(c)).player.status,'playing');assert.equal(await evaluate(c,'!!document.querySelector("[data-code=notFound] button")'),true);checks.push('missing PotPlayer leaves music playing and offers player settings');
 await evaluate(c,"[...document.querySelectorAll('[data-code=notFound] button')].find(b=>b.textContent.includes('PotPlayer 设置')).click()");
 await until(c,"[...document.querySelectorAll('button')].some(b=>b.textContent.includes('自动查找'))");
 await evaluate(c,"[...document.querySelectorAll('button')].find(b=>b.textContent.includes('自动查找')).click()");
 for(let i=0;i<100;i++){if(!(await saved()).potPlayerPath.includes('missing'))break;await delay(100);}assert.ok(!(await saved()).potPlayerPath.includes('missing'));
 await click(c,'[role="dialog"] button[aria-label="关闭"]');
 await until(c,'!document.querySelector("[role=dialog]")');
 checks.push('native settings detects installed PotPlayer asynchronously');
 const existing=await potProcesses();
 if(existing.length===0){await click(c,'button[aria-label^="用 PotPlayer 播放："]');await until(c,'document.body.textContent.includes("已交给 PotPlayer")');
   await delay(500);ownedPlayer=(await potProcesses()).map(p=>p.Id);assert.ok(ownedPlayer.length>0);assert.equal((await snapshot(c)).player.status,'paused');assert.deepEqual((await snapshot(c)).player.queue,queue);
   await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($idToClose in @(${ownedPlayer.join(',')})){ $p=Get-Process -Id $idToClose -ErrorAction SilentlyContinue;if($p -and $p.ProcessName -match '^PotPlayer'){[void]$p.CloseMainWindow()} }`],{windowsHide:true});
   await delay(700);assert.equal((await snapshot(c)).player.status,'paused');checks.push('real PotPlayer opens synthetic MKV; music pauses, queue persists, closing does not resume');
 }else checks.push('real PotPlayer launch skipped: an existing user player instance was active');
 await rename(movie,movie+'.moved');await click(c,'button[aria-label^="用 PotPlayer 播放："]');await until(c,'!!document.querySelector("[data-code=fileMissing]")');
 assert.ok((await saved()).musicVideos[videoId]);checks.push('missing MKV remains linked and offers relink');await shot(c,'mv-missing');await rename(movie+'.moved',movie);
 // Display-only cover frames in real WebView2; leave core/private collection unchanged.
 const current=await snapshot(c);for(const theme of ['light','blue','charcoal'])for(const width of [900,1280]){
   const dpr=await evaluate(c,'devicePixelRatio');await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/mv-resize-smoke-window.ps1'),'-TargetProcessId',String(child.pid),'-ClientWidth',String(Math.round(width*dpr)),'-ClientHeight',String(Math.round(800*dpr))],{windowsHide:true});
   const cover='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#af291b"/><circle cx="200" cy="200" r="130" fill="#ffba56"/></svg>').toString('base64');
   const patch=themePatch(theme),settings={...current.settings,...patch,ui:{...current.settings.ui,main:{...current.settings.ui.main,...patch.ui?.main}}};
   const delta={settings,library:{...current.library,albums:current.library.albums.map(a=>a.id===albumId?{...a,cover:{thumbUrl:cover,fullUrl:cover}}:a)}};
   await evaluate(c,'window.__TAURI_INTERNALS__.invoke("push_snapshot",{surface:"main",delta:'+JSON.stringify(delta)+'})');await until(c,'document.querySelector(".cdp")?.dataset.theme==='+JSON.stringify(theme));
   await until(c,'(()=>{const images=[...document.querySelectorAll("[aria-label=播放控制] .cdp-frost img")];return images.length===2&&images.every(i=>i.complete&&i.naturalWidth>0)})()');
   const layout=await evaluate(c,`(()=>{const bar=document.querySelector('[aria-label=播放控制]'),light=bar.querySelector('.cdp-frost'),art=light.querySelector('img[data-layer="0"]'),r=bar.getBoundingClientRect(),a=art.getBoundingClientRect();return {theme:document.querySelector('.cdp').dataset.theme,width:innerWidth,images:light.querySelectorAll('img').length,blend:getComputedStyle(art).mixBlendMode,tone:getComputedStyle(bar).getPropertyValue('--frost-tone'),bar:{left:r.left,right:r.right},art:{left:a.left,right:a.right},overflow:document.documentElement.scrollWidth-innerWidth};})()`);
   assert.equal(layout.images,2);assert.equal(layout.blend,'color');assert.ok(layout.tone);assert.ok(layout.art.left<layout.bar.left&&layout.art.right>layout.bar.right);assert.equal(layout.overflow,0);layouts.push(layout);await shot(c,'capsule-'+theme+'-'+width);
 }
 checks.push('WebView2 capsule full-width blend and three themes at 900/1280px');
}catch(e){error=e;if(pages.main){await shot(pages.main,'failure').catch(()=>{});await writeFile(path.join(output,'failure-dom.json'),JSON.stringify(await evaluate(pages.main,"({text:document.body.innerText,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.outerHTML),snapshot:window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot)})").catch(()=>null),null,2));}}
finally{
 for(const c of Object.values(pages))c.socket.close();await writeFile(report.replace(/\.json$/,'.stop'),'finish isolated MV test');
 const timer=setTimeout(()=>child.kill(),10000);const code=await done;clearTimeout(timer);await writeFile(path.join(output,'native.log'),logs);
 if(ownedPlayer.length)await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($idToClose in @(${ownedPlayer.join(',')})){ $p=Get-Process -Id $idToClose -ErrorAction SilentlyContinue;if($p -and $p.ProcessName -match '^PotPlayer'){Stop-Process -Id $idToClose} };exit 0`],{windowsHide:true});
 if(!error&&code!==0)error=Error('Native test process exited '+code);
 await writeFile(path.join(output,'RESULT.json'),JSON.stringify({passed:!error,exitCode:code,checks,layouts,error:error?.stack,syntheticVideo:true,userDvdTested:false},null,2));console.log(JSON.stringify({output,passed:!error,checks,error:error?.message}));
}
if(error)throw error;


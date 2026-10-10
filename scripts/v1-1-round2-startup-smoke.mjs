import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { openLocalStore } from '../src/local/store.ts';
import { createDemoData } from '../src/mock/fixtures.ts';
import { SCENARIOS as NODE_SCENARIOS } from '../preview/scenarios.ts';

// Owned debug process and isolated data. Production switch checks write only this test collection.
// Cover frames are read-only snapshots in native WebView2. Optional real covers stay local.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'.cache','v1-1-native-'+Date.now());
await mkdir(output);
const directory=path.join(output,'data');
const initial=await openLocalStore(directory), demo=createDemoData();
try {await initial.transact(d=>{d.library=demo.library;d.lyricsByTrack=demo.lyricsByTrack;});} finally {await initial.close();}
const saved=()=>readFile(path.join(directory,'library.json'),'utf8').then(JSON.parse);
const before=await saved();
assert.equal(before.settings.ui.main.materialTheme,'charcoal');assert.equal(before.settings.accentColor,'#DB7A3D');
assert.equal(Object.hasOwn(before.settings.ui.main,'memorialPlates'),false);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const snapshots=[],shots=[],layouts=[],scales=[],widths=[],loads=[];
const v11Checks=[];const miniChecks=[],miniBranches=[],rawNativeReports=[];
const coverArg=process.argv.indexOf('--covers');
const covers=coverArg<0?[]:await readFile(process.argv[coverArg+1],'utf8').then(JSON.parse);
for(const c of covers) c.url='data:image/jpeg;base64,'+(await readFile(c.file)).toString('base64');
function connect(url){return new Promise((resolve,reject)=>{const socket=new WebSocket(url),pending=new Map();let seq=0;
 socket.addEventListener('error',reject,{once:true});socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
 socket.addEventListener('open',()=>resolve({socket,send(method,params={}){return new Promise((r,j)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);j(Error(method+' timeout'));},15000);pending.set(id,{resolve:r,reject:j,timer});socket.send(JSON.stringify({id,method,params}));});}}));});}
async function evaluate(c,expression){const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(c,expression){for(let n=0;n<70;n++){if(await evaluate(c,expression))return;await delay(150);}throw Error('Timed out: '+expression);}
const snap=c=>evaluate(c,"window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot)");
async function launch(round){const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const reportPath=path.join(output,'native-'+round+'.json');
 const child=spawn(path.join(root,'src-tauri/target/debug/cd-player-desktop.exe'),['--smoke-data',directory,'--smoke-report',reportPath,'--smoke-manual'],{cwd:root,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const done=new Promise((r,j)=>{child.once('exit',r);child.once('error',j);});const pages={};
 for(let n=0;n<80&&!(pages.main&&pages.mini);n++){try{const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();for(const t of targets.filter(t=>t.type==='page')){const c=await connect(t.webSocketDebuggerUrl),s=await evaluate(c,"document.querySelector('.cdp')?.dataset.surface");if(['main','mini'].includes(s)&&!pages[s])pages[s]=c;else c.socket.close();}}catch{}if(!(pages.main&&pages.mini))await delay(150);}
 assert.ok(pages.main&&pages.mini,'Native surfaces unavailable');
 return {child,pages,async stop(){Object.values(pages).forEach(c=>c.socket.close());await writeFile(reportPath.replace(/\.json$/,'.stop'),'finish isolated memorial check');const status=await done;await writeFile(path.join(output,'native-'+round+'.log'),log);const raw=JSON.parse(await readFile(reportPath,'utf8'));const expectedFailures=(raw.frontendErrors??[]).filter(s=>/^mini: resource failed: http:\/\/127\.0\.0\.1:\d+\/covers\/missing-cover\.webp$/.test(s));const onlyExpected=expectedFailures.length>0&&expectedFailures.length===raw.frontendErrors.length;rawNativeReports.push({round,status,rawPassed:raw.passed,expectedCoverFailureErrors:expectedFailures.length});if(onlyExpected){assert.equal(status,1);assert.equal(raw.manual,true);}else{assert.equal(status,0);assert.ok(raw.passed);}}};
}
async function shot(c,name){await evaluate(c,'document.fonts.ready.then(()=>true)');await delay(180);const r=await c.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));shots.push(name);}
async function click(c,selector){await until(c,'!!document.querySelector('+JSON.stringify(selector)+')');await evaluate(c,'document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"nearest"})');await delay(100);
 const p=await evaluate(c,'(()=>{const e=document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,reachable:h===e||e.contains(h)}})()');assert.ok(p.reachable,'Pointer target blocked: '+selector);
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});
}
async function escape(c){for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
async function inspect(c){return evaluate(c,"(()=>{const out={viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},forced:matchMedia('(forced-colors:active)').matches};for(const kind of ['etch','plate']){const e=document.querySelector('[data-memorial='+kind+']');if(!e){out[kind]=null;continue;}const s=getComputedStyle(e),r=e.getBoundingClientRect();const texts=[...e.parentElement.querySelectorAll('h2,p,button,li')].filter(n=>n!==e&&!n.contains(e)&&getComputedStyle(n).display!=='none');const overlaps=texts.filter(n=>{const t=n.getBoundingClientRect();return t.width&&t.height&&Math.min(t.right,r.right)-Math.max(t.left,r.left)>1&&Math.min(t.bottom,r.bottom)-Math.max(t.top,r.top)>1;}).map(n=>n.textContent.slice(0,120));out[kind]={display:s.display,background:s.backgroundImage,filter:s.filter,backdrop:s.backdropFilter,blend:s.mixBlendMode,pointer:s.pointerEvents,rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},overlaps,ariaHidden:e.getAttribute('aria-hidden')};}out.instrumentalText=[...document.querySelectorAll('p')].some(n=>n.textContent==='这首被标记为纯音乐，没有歌词。');return out;})()");}
const runFile=promisify(execFile);
async function resize(run,width,height=800){const c=run.pages.main,dpr=await evaluate(c,'devicePixelRatio');await runFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/v1-1-resize-smoke-window.ps1'),'-TargetProcessId',String(run.child.pid),'-ClientWidth',String(Math.round(width*dpr)),'-ClientHeight',String(Math.round(height*dpr))],{windowsHide:true,timeout:30000});await until(c,'Math.abs(innerWidth-'+width+')<=2&&Math.abs(innerHeight-'+height+')<=2');}

const checks=[];let active,error;try{for(let round=0;round<5;round++){active=await launch('startup-'+round);await delay(6500);const main=await snap(active.pages.main),mini=await snap(active.pages.mini);assert.equal(main.host.coreStatus,'ready');assert.equal(mini.host.coreStatus,'ready');assert.equal(main.player.status,'idle');await active.stop();active=null;checks.push({round,ready:true,normalExit:true,idle:true});await writeFile(path.join(output,'startup-progress.json'),JSON.stringify(checks));await delay(3500);}assert.deepEqual(await saved(),before);const reopened=await openLocalStore(directory);await reopened.close();await writeFile(path.join(output,'startup-report.json'),JSON.stringify({passed:true,version:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,checks,rawNativeReports,noUserData:true,noAudio:true,noSettingsOrLibraryWrite:true,restartGapMs:3500},null,2));console.log(JSON.stringify({output,passed:true,startupCycles:checks.length}));}catch(e){error=e;await writeFile(path.join(output,'startup-failure.json'),JSON.stringify({error:String(e),stack:e.stack},null,2));}finally{if(active)await active.stop();}if(error)throw error;

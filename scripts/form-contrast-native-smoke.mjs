import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { openLocalStore } from '../src/local/store.ts';
import { createDemoData } from '../src/mock/fixtures.ts';

// Isolated real WebView2 render. Production settings/editor first; complex read-only
// states then use the same PlayerUI and preview fixtures, with the actual native host.
// No online query, audio, candidate adoption, save, or default collection access.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const glassFloor=process.argv.includes('--glass-floor');
const output=path.join(root,'.cache','form-contrast-native-'+Date.now());await mkdir(output);
const directory=path.join(output,'data'),nativeReport=path.join(output,'native.json');
const store=await openLocalStore(directory),demo=createDemoData();
try {await store.transact(data=>{data.library=demo.library;data.lyricsByTrack=demo.lyricsByTrack;
  data.settings={...demo.settings,glassIntensity:1,motion:'reduced',ui:{...demo.settings.ui,main:{materialTheme:'charcoal'}}};});}
finally {await store.close();}
const digest=async()=>createHash('sha256').update(await readFile(path.join(directory,'library.json'))).digest('hex');
const before=await digest();
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
const child=spawn(path.join(root,'src-tauri/target/debug/cd-player-desktop.exe'),
  ['--smoke-data',directory,'--smoke-report',nativeReport,'--smoke-manual'],
  {cwd:root,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
const completed=new Promise((r,j)=>{child.once('exit',r);child.once('error',j);});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function connect(url){return new Promise((resolve,reject)=>{const socket=new WebSocket(url),pending=new Map();let seq=0;
  socket.addEventListener('error',reject,{once:true});socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);
    if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
  socket.addEventListener('open',()=>resolve({socket,send(method,params={}){return new Promise((r,j)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);j(Error(method+' timeout'));},15000);
    pending.set(id,{resolve:r,reject:j,timer});socket.send(JSON.stringify({id,method,params}));});}}));});}
const evaluate=async(cdp,expression)=>{const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
async function until(cdp,expression){for(let n=0;n<70;n++){const r=await evaluate(cdp,expression);if(r)return r;await delay(150);}throw Error(expression);}
const pointers=[];
async function click(cdp,label){const expr=`[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)})`;
  await until(cdp,`!!(${expr})`);await evaluate(cdp,`(${expr}).scrollIntoView({block:'nearest'})`);await delay(150);
  const p=await evaluate(cdp,`(()=>{const e=${expr},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,reachable:e===h||e.contains(h)};})()`);
  assert.ok(p.reachable,label+' occluded');for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1});pointers.push({label,...p});await delay(200);}
async function capture(cdp,name){await evaluate(cdp,'document.fonts.ready.then(()=>true)');await delay(550);
  const computed=await evaluate(cdp,`(()=>{const r=document.querySelector('.cdp'),g=document.querySelector('.glass-strong,.cdp-menu');
    const color=property=>{const probe=document.createElement('span');probe.style.cssText='position:absolute;display:none;background-color:var('+property+')';r.append(probe);const value=getComputedStyle(probe).backgroundColor;probe.remove();return value;};
    const capsule=document.querySelector('.glass--frost-see'),frost=capsule?.querySelector('.cdp-frost');
    return {theme:r.dataset.theme,nativeBackdrop:r.dataset.backdrop,glass:getComputedStyle(r).getPropertyValue('--glass'),raisedAccent:getComputedStyle(r).getPropertyValue('--accent-ink-raised'),
      solid:r.dataset.solid==='true',strongBody:color('--glass-body-strong'),ordinaryBody:color('--glass-body'),
      forcedColors:matchMedia('(forced-colors: active)').matches,calcMaxSupported:CSS.supports('color','rgba(0,0,0,calc(max(0.48,0.32) + 0.16 + 0.3))'),
      capsule:capsule&&{filter:getComputedStyle(capsule).backdropFilter,frostOpacity:frost&&getComputedStyle(frost).opacity},
      surface:g&&{ink2:getComputedStyle(g).getPropertyValue('--ink-2'),ink3:getComputedStyle(g).getPropertyValue('--ink-3'),accent:getComputedStyle(g).getPropertyValue('--accent-ink')},
      menus:document.querySelectorAll('[role="menu"]').length,lines:document.querySelectorAll('[data-line-id]').length,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(d=>d.getAttribute('aria-label')||d.querySelector('h2')?.textContent)};})()`);
  assert.ok(await evaluate(cdp,`!document.body.innerText.includes('播放核心没有响应')`));
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(shot.data,'base64'));
  return {name,...computed};}
let cdp,report,error;
try {
  for(let n=0;n<80&&!cdp;n++){try{const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();for(const t of targets.filter(t=>t.type==='page')){
    const c=await connect(t.webSocketDebuggerUrl);if(await evaluate(c,`document.querySelector('.cdp')?.dataset.surface`)==='main'){cdp=c;break;}c.socket.close();}}catch{}if(!cdp)await delay(150);}
  assert.ok(cdp,'Native page unavailable');
  const host=await evaluate(cdp,`window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot.host)`);
  const shots=[];
  await click(cdp,'设置');shots.push(await capture(cdp,'production-settings-charcoal-max'));
  await click(cdp,'关闭');
  const track=demo.library.tracks.find(t=>demo.lyricsByTrack[t.id]?.lines.length>2);assert.ok(track);
  const opened=await evaluate(cdp,`(async()=>{const i=window.__TAURI_INTERNALS__.invoke,now=await i('clock_sample');return i('dispatch_action',{surface:'main',deadlineMs:now+4500,action:{type:'openLyricsEditor',trackId:${JSON.stringify(track.id)}}});})()`);assert.ok(opened.ok);
  await until(cdp,`document.querySelector('button[aria-label="关闭歌词编辑"]')!==null`);
  shots.push(await capture(cdp,'production-editor-charcoal-max'));
  await click(cdp,'导入');shots.push(await capture(cdp,'production-import-menu-charcoal-max'));
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await click(cdp,'关闭歌词编辑');assert.equal(await digest(),before);

  // The read-only fixture bundle is kept in evidence, never added to production assets.
  const source=`import React from 'react';import {createRoot} from 'react-dom/client';
    import {PlayerUI} from './src/ui/PlayerUI.tsx';import {UIBootContext} from './src/ui/lib/env.ts';
    import {SCENARIOS,withTheme} from './preview/scenarios.ts';
    const h=document.createElement('div');document.body.replaceChildren(h);let root=createRoot(h),seq=0;window.qaActions=[];
    window.qaRender=(id,theme,intensity,host)=>{const s=SCENARIOS.find(s=>s.id===id);if(!s)throw Error(id);
      const snapshot=withTheme(s.build(),theme);snapshot.host={...snapshot.host,...host,surfaceVisible:true,coreStatus:'ready'};
      if(${glassFloor}&&id==='lr-ready')snapshot.library={...snapshot.library,albums:snapshot.library.albums.map(a=>({...a,cover:{thumbUrl:'/covers/white.svg',fullUrl:'/covers/white.svg',width:600,height:600}}))};
      snapshot.settings={...snapshot.settings,glassIntensity:intensity,motion:'reduced'};
      root.render(React.createElement(UIBootContext.Provider,{value:s.boot??{}},React.createElement(PlayerUI,{key:++seq,snapshot,surface:'main',onAction:async a=>{window.qaActions.push(a.type);return {ok:true,status:'cancelled'};}})));return true;};`;
  const built=await build({stdin:{contents:source,resolveDir:root,sourcefile:'readonly-native-forms.tsx',loader:'tsx'},bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,outdir:output,loader:{'.woff2':'dataurl'},minify:true});
  const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text,css=built.outputFiles.find(f=>f.path.endsWith('.css')).text;
  // Keep the actual backend probe/heartbeat alive while replacing only the visible
  // tree with read-only frames. Navigating away would remove the production bridge
  // and correctly make the native watchdog report an unavailable renderer.
  await evaluate(cdp,`document.head.querySelectorAll('link[rel="stylesheet"],style').forEach(e=>e.remove());document.head.append(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(css)}}));`);
  await evaluate(cdp,js);
  for(const theme of ['charcoal','light','blue'])for(const scenario of glassFloor?['settings','metadata','meta-album','ed','ed-tap','ed-compare','ed-empty','lr-ready','library']:['settings','metadata','meta-album','ed','ed-compare','ed-empty']){
    await evaluate(cdp,`window.qaRender(${JSON.stringify(scenario)},${JSON.stringify(theme)},1,${JSON.stringify(host)})`);
    await until(cdp,`document.querySelector('.cdp')?.dataset.theme===${JSON.stringify(theme)}`);
    shots.push(await capture(cdp,scenario+'-'+theme+'-max'));
  }
  await evaluate(cdp,`window.qaRender('ed','charcoal',0.65,${JSON.stringify(host)})`);await delay(250);shots.push(await capture(cdp,'ed-charcoal-default'));
  if(glassFloor){
    const alpha=rgba=>rgba.startsWith('rgba(')?Number(rgba.split(',').at(-1).replace(')','')):1;
    for(const theme of ['charcoal','light','blue']){
      for(const scenario of ['metadata','meta-album','ed','library']){
        await evaluate(cdp,`window.qaRender(${JSON.stringify(scenario)},${JSON.stringify(theme)},0.65,${JSON.stringify(host)})`);await delay(150);
        const shot=await capture(cdp,scenario+'-'+theme+'-default');shots.push(shot);
        const max=shots.find(s=>s.name===scenario+'-'+theme+'-max');assert.ok(max.calcMaxSupported);assert.equal(max.strongBody,shot.strongBody);
        const expected={charcoal:0.94,light:0.78,blue:0.72}[theme];assert.ok(Math.abs(alpha(max.strongBody)-expected)<0.001,JSON.stringify(max));
        assert.ok(alpha(max.ordinaryBody)<alpha(shot.ordinaryBody),'Ordinary glass no longer follows strength');
        if(scenario==='library'){assert.equal(max.capsule.frostOpacity,'0.6');assert.notEqual(max.capsule.filter,'none');assert.deepEqual(max.capsule,shot.capsule);}
      }
      await evaluate(cdp,`window.qaRender('library',${JSON.stringify(theme)},0,${JSON.stringify(host)})`);await delay(150);
      const solid=await capture(cdp,'library-'+theme+'-solid');shots.push(solid);assert.ok(solid.solid);assert.equal(alpha(solid.strongBody),1);assert.equal(solid.capsule.filter,'none');assert.equal(solid.capsule.frostOpacity,'1');
      await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
      await evaluate(cdp,`window.qaRender('ed',${JSON.stringify(theme)},1,${JSON.stringify(host)})`);await delay(150);
      const forced=await capture(cdp,'ed-'+theme+'-forced');shots.push(forced);assert.ok(forced.forcedColors);
      await cdp.send('Emulation.setEmulatedMedia',{features:[]});
    }
  }
  const actions=await evaluate(cdp,'window.qaActions');assert.ok(actions.every(a=>a==='reportUnsavedChanges'),'Read-only states dispatched write action: '+actions);
  assert.equal(await digest(),before);
  report={passed:true,prototypeVersion:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,host,
    productionSettingsAndEditor:true,actualWebView2:true,staticComplexStates:true,shots,pointerChecks:pointers,
    glassFloorChecks:glassFloor,whiteCoverBehindLyricsCandidates:glassFloor,defaultAndMaxStrongBodyEqual:glassFloor,
    ordinaryGlassStillFollowsStrength:glassFloor,capsuleTransparencyAndSolidFallbackChecked:glassFloor,
    collectionBytesUnchanged:true,noAudio:true,noNetworkQuery:true,noDefaultUserData:true,noDataSave:true,
    limits:['Complex conflict/review states use read-only synthetic preview snapshots in the actual native WebView2; no real save/conflict request','Screenshots and computed colors are visual QA, not an exhaustive pixel contrast or GPU certification']};
}catch(e){error=e;await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(e),stack:e.stack},null,2));}
finally{cdp?.socket.close();await writeFile(nativeReport.replace(/\.json$/,'.stop'),'finish isolated read-only forms');const exit=await completed;
  await writeFile(path.join(output,'native.log'),logs);if(!error){assert.equal(exit,0);assert.ok(JSON.parse(await readFile(nativeReport,'utf8')).passed);}}
if(error)throw error;
assert.equal(await digest(),before);const reopened=await openLocalStore(directory);await reopened.close();report.storeReopened=true;
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:true,screenshots:report.shots.length}));

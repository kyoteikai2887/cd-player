import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openLocalStore } from '../src/local/store.ts';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';
import { parseLyrics } from '../src/core/lyrics.ts';
import { createAudioFolder } from '../tests/helpers/audioFiles.ts';

// Release-mode application, same production sources. Only the compiled app identity
// and an acceptance-only own-window destroy permission differ. No debug smoke flags.
// Never accepts the production installer, profile, or binary as the test target.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stage=path.resolve(root,process.argv[2]??'.cache/release-gui-installer-core22');
assert.ok(stage.startsWith(path.join(root,'.cache')+path.sep),'Stage must stay inside project cache');
const identity='local.cdplayer.v1.release-validation.20261005',product='CD 播放器发布验收';
const config=JSON.parse(await readFile(path.join(stage,'bundle-project/src-tauri/tauri.conf.json'),'utf8'));
assert.equal(config.identifier,identity);assert.equal(config.productName,product);
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
assert.equal(config.version,version);
const capabilities=config.app.security.capabilities;
assert.equal(capabilities.length,1);assert.deepEqual(capabilities[0].permissions,['core:window:allow-destroy']);
const expectedBinary=await readFile(path.join(stage,'CD播放器.exe'));
assert.ok(expectedBinary.includes(Buffer.from(identity)),'The executable was not built with the isolated identity');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const output=path.join(root,'.cache','installed-release-gui-'+Date.now());await mkdir(output);
const target=path.join(output,'安装目录 中文空格');
const installer=path.join(stage,'bundle-project/src-tauri/target/release/bundle/nsis',product+'_'+version+'_x64-setup.exe');
await access(installer);
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
async function powershell(script){const child=spawn('pwsh',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';"+script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const code=await new Promise((r,j)=>{child.once('exit',r);child.once('error',j);});assert.equal(code,0,err||out);return out.trim();}
const folders=JSON.parse(await powershell(`@{roaming=[Environment]::GetFolderPath('ApplicationData');local=[Environment]::GetFolderPath('LocalApplicationData')}|ConvertTo-Json -Compress`));
const profile=path.join(folders.roaming,identity),webviewProfile=path.join(folders.local,identity);
for(const f of [profile,webviewProfile])assert.equal(path.basename(f),identity);
const registration='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+identity;
const productKey='HKCU:\\Software\\cdplayer\\'+identity;
assert.equal(await powershell(`(Test-Path -LiteralPath ${psQuote(registration)}) -or (Test-Path -LiteralPath ${psQuote(profile)}) -or (Test-Path -LiteralPath ${psQuote(webviewProfile)})`),'False','Existing acceptance state must be reviewed, not overwritten');
const actualDefault=path.join(folders.roaming,'local.cdplayer.v1','library.json');
const optionalHash=async f=>{try{return sha(await readFile(f));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const beforeDefault=await optionalHash(actualDefault);
async function fingerprints(folder){const result={};for(const e of await readdir(folder,{withFileTypes:true})){
  if(e.isDirectory())for(const [n,h] of Object.entries(await fingerprints(path.join(folder,e.name))))result[e.name+'/'+n]=h;
  else if(e.isFile())result[e.name]=sha(await readFile(path.join(folder,e.name)));}return result;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function connect(url){return new Promise((resolve,reject)=>{const socket=new WebSocket(url),pending=new Map();let seq=0;
  socket.addEventListener('error',reject,{once:true});socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Owned WebView closed'));}pending.clear();});
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
  socket.addEventListener('open',()=>resolve({socket,send(method,params={}){return new Promise((r,j)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);j(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve:r,reject:j,timer});socket.send(JSON.stringify({id,method,params}));});}}));});}
const evaluate=async(c,expression)=>{const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
async function until(read,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){try{const r=await read();if(r)return r;}catch{}await delay(125);}throw Error(label);}
const snapshot=c=>evaluate(c,`window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot)`);
const act=async(c,action)=>{const r=await evaluate(c,`(async()=>{const i=window.__TAURI_INTERNALS__.invoke,n=await i('clock_sample');return i('dispatch_action',{surface:'main',action:${JSON.stringify(action)},deadlineMs:n+4500});})()`);assert.ok(r.ok,JSON.stringify(r));return r;};
async function start(label){const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const child=spawn(path.join(target,'cd-player-desktop.exe'),[],{cwd:target,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const exited=new Promise((r,j)=>{child.once('exit',r);child.once('error',j);});const pages={};
  try{await until(async()=>{const ts=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();for(const t of ts.filter(t=>t.type==='page')){
    const c=await connect(t.webSocketDebuggerUrl),surface=await evaluate(c,`document.querySelector('.cdp')?.dataset.surface`);
    if(['main','mini'].includes(surface)&&!pages[surface])pages[surface]=c;else c.socket.close();}return pages.main&&pages.mini;},'Installed release WebViews did not initialize');
    await until(async()=>{const s=await snapshot(pages.main);return s.host.coreStatus==='ready'&&s.host.surfaceVisible;},'Installed release did not become ready');
    const lock=JSON.parse(await readFile(path.join(profile,'writer.lock'),'utf8'));assert.ok(lock.pid>0);
    return {child,exited,pages,backendPid:lock.pid,label,saveLog:()=>writeFile(path.join(output,label+'.log'),log)};
  }catch(e){Object.values(pages).forEach(c=>c.socket.close());child.kill();await exited;await writeFile(path.join(output,label+'.log'),log);throw e;}}
async function stop(run){
  // This permission exists only in the acceptance build. Destroying both owned
  // windows triggers the production ExitRequested -> request_exit -> stop_backend.
  await evaluate(run.pages.main,`window.__TAURI_INTERNALS__.invoke('plugin:window|destroy',{label:'mini'})`);
  const closing=evaluate(run.pages.main,`window.__TAURI_INTERNALS__.invoke('plugin:window|destroy',{label:'main'})`).catch(()=>undefined);
  const code=await Promise.race([run.exited,delay(12000).then(()=>{throw Error('Installed release did not exit normally');})]);await closing;
  Object.values(run.pages).forEach(c=>c.socket.close());await run.saveLog();assert.equal(code,0);
  await until(async()=>{try{await access(path.join(profile,'writer.lock'));return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}},'Normal release shutdown retained writer lease');
  try{process.kill(run.backendPid,0);throw Error('Installed backend remained alive');}catch(e){if(e.code!=='ESRCH')throw e;}
  return {exitCode:code,backendExited:true,writerLeaseReleased:true};}
async function screenshot(c,label){await evaluate(c,'document.fonts.ready.then(()=>true)');await delay(350);const r=await c.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,label+'.png'),Buffer.from(r.data,'base64'));}
const collection=data=>sha(Buffer.from(JSON.stringify({library:data.library,lyricsByTrack:data.lyricsByTrack,archivedLyrics:data.archivedLyrics})));
let active,report,installed=false;
const checks=[];
try{
  const exit=Number(await powershell(`$p=Start-Process -FilePath ${psQuote(installer)} -ArgumentList ${psQuote('/S /NS /D='+target)} -PassThru -WindowStyle Hidden;if(-not $p.WaitForExit(120000)){throw 'Setup timeout'};$p.ExitCode`));assert.equal(exit,0);installed=true;
  assert.equal(sha(await readFile(path.join(target,'cd-player-desktop.exe'))),sha(expectedBinary));
  for(const folder of ['runtime','web'])assert.deepEqual(await fingerprints(path.join(target,folder)),await fingerprints(path.join(stage,folder)));
  checks.push({name:'installed-release-and-production-resources',passed:true});
  active=await start('first-empty-start');const first=await snapshot(active.pages.main);assert.equal(first.library.tracks.length,0);assert.equal(first.player.status,'idle');
  assert.ok(await evaluate(active.pages.main,`document.body.innerText.includes('把抓好的 CD 放进来')`));await screenshot(active.pages.main,'first-empty-start');
  checks.push({name:'first-release-gui-start-empty-profile-ready',passed:true});
  await act(active.pages.main,{type:'updateSettings',patch:{background:'blue',glassIntensity:0.65,accentColor:'#6CACE4',ui:{main:{materialTheme:'charcoal'}}}});
  await until(async()=>(await snapshot(active.pages.main)).settings.ui.main.materialTheme==='charcoal','Own settings update did not publish');
  checks.push({name:'first-gui-normal-exit',passed:true,...await stop(active)});active=null;
  assert.equal(JSON.parse(await readFile(path.join(profile,'library.json'),'utf8')).settings.ui.main.materialTheme,'charcoal');
  const fixture=path.join(output,'synthetic-music');await createAudioFolder(fixture,8);const sourceHashes=await fingerprints(fixture);
  const store=await openLocalStore(profile);let tracks;
  try{const scan=await scanFolder(fixture,path.join(profile,'covers'),new AbortController().signal);await store.transact(data=>{
    mergeScan(data,scan);data.roots=[];const track=data.library.tracks[0];track.title='发行启动验收 · 原创曲目';track.userEditedFields=['title'];track.revision++;
    data.lyricsByTrack[track.id]={...parseLyrics('[00:00.00]原创第一句\n[00:04.00]原创第二句',track.id),locked:true,offsetMs:125};data.library.revision++;
  });tracks=store.view().library.tracks;await store.backup();}finally{await store.close();}
  const saved=JSON.parse(await readFile(path.join(profile,'library.json'),'utf8')),savedCollection=collection(saved),backupHashes=await fingerprints(path.join(profile,'backups'));
  active=await start('second-saved-start');const second=await snapshot(active.pages.main);assert.equal(second.library.tracks.length,tracks.length);assert.equal(second.settings.ui.main.materialTheme,'charcoal');assert.equal(second.player.status,'idle');
  assert.ok(await evaluate(active.pages.main,`document.querySelector('.cdp').dataset.theme==='charcoal'`));await screenshot(active.pages.main,'second-saved-start');
  checks.push({name:'restart-keeps-collection-settings-and-paused-state',passed:true,tracks:tracks.length});
  await act(active.pages.main,{type:'openLyricsEditor',trackId:tracks[0].id});
  await until(()=>evaluate(active.pages.main,`document.querySelector('textarea[aria-label="第 1 行原文"]')?.value==='原创第一句'`),'Saved lyrics were not shown');
  const edited=await snapshot(active.pages.main);assert.equal(edited.lyricsEditor.document.locked,true);assert.equal(edited.lyricsEditor.document.offsetMs,125);
  await screenshot(active.pages.main,'saved-lyrics-editor');await act(active.pages.main,{type:'closeLyricsEditor'});
  checks.push({name:'saved-manual-metadata-lyrics-offset-lock-and-backup-retained',passed:true});
  await act(active.pages.main,{type:'setWindowMode',mode:'mini'});await until(async()=>(await snapshot(active.pages.mini)).host.surfaceVisible,'Installed mini did not become visible');
  await screenshot(active.pages.mini,'installed-mini');await act(active.pages.main,{type:'setWindowMode',mode:'full'});
  await until(async()=>(await snapshot(active.pages.main)).host.surfaceVisible,'Installed main did not return');checks.push({name:'installed-release-main-mini-switch',passed:true});
  checks.push({name:'second-gui-normal-exit',passed:true,...await stop(active)});active=null;
  assert.equal(collection(JSON.parse(await readFile(path.join(profile,'library.json'),'utf8'))),savedCollection);assert.deepEqual(await fingerprints(path.join(profile,'backups')),backupHashes);
  const uninstall=path.join(target,'uninstall.exe');const removed=Number(await powershell(`$p=Start-Process -FilePath ${psQuote(uninstall)} -ArgumentList ${psQuote('/S _?='+target)} -PassThru -WindowStyle Hidden;if(-not $p.WaitForExit(120000)){throw 'Uninstall timeout'};$p.ExitCode`));assert.equal(removed,0);installed=false;
  assert.equal(await powershell(`(Test-Path -LiteralPath ${psQuote(registration)}) -or (Test-Path -LiteralPath ${psQuote(productKey)})`),'False');
  assert.equal(collection(JSON.parse(await readFile(path.join(profile,'library.json'),'utf8'))),savedCollection);assert.deepEqual(await fingerprints(path.join(profile,'backups')),backupHashes);assert.deepEqual(await fingerprints(fixture),sourceHashes);
  assert.equal(await optionalHash(actualDefault),beforeDefault,'Default user collection bytes changed');
  checks.push({name:'uninstall-after-gui-retains-owned-profile-and-backup',passed:true});
  report={passed:true,prototypeVersion:version,identity,releaseMode:true,productionSourcesUnchanged:true,acceptanceOnlyWindowDestroyPermission:true,
    checks,defaultUserCollectionBytesUnchanged:true,originalSyntheticAudioUnchanged:true,noAudioStarted:true,noOnlineQuery:true,
    actualInstalledReleaseGuiFirstAndSecondStart:true,interactiveInstallerPagesTested:false,
    limits:['Compiled identity/product metadata and own-window destroy permission differ from the public production binary; runtime/web and application sources are identical',
      'This checks the production shutdown path through ExitRequested; physical tray menu click and dirty-draft native confirmation still need manual acceptance',
      'WebView2 already present; no clean Windows/missing-runtime test','No physical devices, sleep/wake, multi-monitor or DPI change']};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  // Only this explicitly named acceptance profile is removed after success.
  for(const folder of [profile,webviewProfile])assert.equal(path.basename(folder),identity);
  await powershell(`foreach($p in @(${psQuote(profile)},${psQuote(webviewProfile)})){if([IO.Path]::GetFileName([IO.Path]::GetFullPath($p))-ne ${psQuote(identity)}){throw 'Wrong acceptance cleanup path'};if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse}}`);
}catch(error){if(active){Object.values(active.pages).forEach(c=>c.socket.close());active.child.kill();await active.exited;await active.saveLog();}
  await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,installed,checks},null,2));throw error;}
console.log(JSON.stringify({output,passed:true,checks:checks.length,version}));

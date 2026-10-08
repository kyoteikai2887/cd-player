import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createAudioFolder } from '../tests/helpers/audioFiles.ts';
import { openLocalStore } from '../src/local/store.ts';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'.cache','lifecycle-native-'+Date.now());await mkdir(output);
const music=path.join(output,'original-fixtures'),data=path.join(output,'data');
await createAudioFolder(music,8);
async function fingerprints(folder) {
  const result={};for(const e of await readdir(folder,{withFileTypes:true})) {
    if(e.isDirectory())for(const [rel,hash]of Object.entries(await fingerprints(path.join(folder,e.name))))result[e.name+'/'+rel]=hash;
    else if(e.isFile())result[e.name]=createHash('sha256').update(await readFile(path.join(folder,e.name))).digest('hex');
  }return result;
}
const originals=await fingerprints(music),store=await openLocalStore(data);
try {const scan=await scanFolder(music,path.join(data,'covers'),new AbortController().signal);
  assert.equal(scan.tracks.length,4);await store.transact(d=>{mergeScan(d,scan);d.settings.accentColor='#123456';});
} finally {await store.close();}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,message,ms=10000) {const start=Date.now();while(Date.now()-start<ms){if(await fn())return;await delay(100);}throw Error(message);}
function connect(url) {return new Promise((resolve,reject)=>{
  const socket=new WebSocket(url),pending=new Map();let seq=0;
  socket.addEventListener('error',reject,{once:true});
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
  socket.addEventListener('open',()=>resolve({socket,send(method,params={}){return new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}}));
});}
async function evaluate(cdp,expression) {const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function start(label) {
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const report=path.join(output,label+'.json');
  const child=spawn(path.join(root,'src-tauri/target/debug/cd-player-desktop.exe'),
    ['--smoke-data',data,'--smoke-report',report,'--smoke-manual'],
    {cwd:root,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  let cdp;
  try {
    await until(async()=>{try {const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for(const page of pages.filter(p=>p.type==='page')){const c=await connect(page.webSocketDebuggerUrl);
        if(await evaluate(c,`document.querySelector('.cdp')?.dataset.surface`)==='main'){cdp=c;return true;}c.socket.close();}
    }catch{}return false;},'Native window did not initialize',20000);
    await until(async()=>{try {return await evaluate(cdp,`(async()=>{const r=await window.__TAURI_INTERNALS__.invoke('request_snapshot');return r.snapshot.host.coreStatus==='ready'&&r.snapshot.library.tracks.length===4;})()`);}catch{return false;}},'Native core not ready');
    const backendPid=JSON.parse(await readFile(path.join(data,'writer.lock'),'utf8')).pid;
    return {child,exited,cdp,report,backendPid,saveLog:()=>writeFile(path.join(output,label+'.log'),log)};
  } catch(error) {cdp?.socket.close();child.kill();await exited;await writeFile(path.join(output,label+'.log'),log);throw error;}
}
async function act(cdp,action) {
  const r=await evaluate(cdp,`(async()=>{const i=window.__TAURI_INTERNALS__.invoke,n=await i('clock_sample');return i('dispatch_action',{surface:'main',action:${JSON.stringify(action)},deadlineMs:n+4500});})()`);
  assert.equal(r.ok,true,JSON.stringify(r));
}
const dead=pid=>{try {process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}};
let active;
const checks=[];
try {
  for(let attempt=1;attempt<=3;attempt++) {
    active=await start('crash-'+attempt);
    await act(active.cdp,{type:'updateSettings',patch:{fontScale:1+attempt*.05}});
    await act(active.cdp,{type:'hideToTray'});
    const before=await readFile(path.join(data,'library.json'));
    active.cdp.socket.close();active.child.kill('SIGKILL');await active.exited;
    const began=Date.now();await until(()=>dead(active.backendPid),'Orphan backend did not exit after parent death',8000);
    await until(async()=>{try {await readFile(path.join(data,'writer.lock'));return false;}catch(e){return e.code==='ENOENT';}},'Orphan backend kept writer lease');
    assert.deepEqual(await readFile(path.join(data,'library.json')),before);
    const reopened=await openLocalStore(data);await reopened.close();await active.saveLog();
    checks.push({attempt,forcedOwnedHostTermination:true,backendExited:true,backendExitWaitMs:Date.now()-began,
      writerLeaseReleased:true,persistedBytesUnchanged:true,storeReopened:true});active=undefined;
  }
  const before=await readFile(path.join(data,'library.json'));
  active=await start('normal-reopen');
  const loaded=await evaluate(active.cdp,`(async()=>{const {snapshot:s}=await window.__TAURI_INTERNALS__.invoke('request_snapshot');return {tracks:s.library.tracks.length,accent:s.settings.accentColor,fontScale:s.settings.fontScale};})()`);
  assert.deepEqual(loaded,{tracks:4,accent:'#123456',fontScale:1.15});
  active.cdp.socket.close();await writeFile(active.report.replace(/\.json$/,'.stop'),'finish lifecycle test');
  assert.equal(await active.exited,0);assert.equal(JSON.parse(await readFile(active.report,'utf8')).passed,true);
  assert.ok(dead(active.backendPid));assert.deepEqual(await readFile(path.join(data,'library.json')),before);
  const reopened=await openLocalStore(data);await reopened.close();await active.saveLog();active=undefined;
  assert.deepEqual(await fingerprints(music),originals);
  const report={passed:true,prototypeVersion:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,
    checks,finalNativeReopen:true,settingsRetained:true,normalExitAndLockReopen:true,
    originalSyntheticFilesUnchanged:true,defaultUserDataModified:false,audioStarted:false,
    limits:['Forced termination affects only this script-owned isolated native host; no machine sleep or power-loss test',
      'Inspector used for lifecycle setup; background soak separately runs without an inspector']};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,output,crashRestarts:checks.length}));
} catch(error) {await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack},null,2));throw error;}
finally {if(active){active.cdp.socket.close();await writeFile(active.report.replace(/\.json$/,'.stop'),'cleanup isolated test');
  const timer=setTimeout(()=>active.child.kill(),10000);await active.exited.finally(()=>clearTimeout(timer));await active.saveLog();}}

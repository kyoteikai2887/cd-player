import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';
import { openLocalStore } from '../src/local/store.ts';
import { parseLyrics } from '../src/core/lyrics.ts';
import { createAudioFolder } from '../tests/helpers/audioFiles.ts';

// Explicit authorized metadata-only query. Independent collection/profile; never saves candidates.
const folder=process.argv[2];
assert.ok(folder&&path.isAbsolute(folder),'An explicitly authorized absolute CD folder is required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'.cache','lyrics-review-native-'+Date.now());
await mkdir(output);
const directory=path.join(output,'data'),nativeReport=path.join(output,'native.json');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fingerprints(base) {
  const values={};
  for(const e of await readdir(base,{withFileTypes:true})) {
    if(e.isDirectory())for(const [rel,hash]of Object.entries(await fingerprints(path.join(base,e.name))))values[e.name+'/'+rel]=hash;
    else if(e.isFile())values[e.name]=digest(await readFile(path.join(base,e.name)));
  }
  return values;
}
const beforeFiles=await fingerprints(folder);
const fixtures=path.join(output,'original-fixtures');await createAudioFolder(fixtures,8);
const fixture=path.join(fixtures,'Disc 1','01 原创音.flac');
const store=await openLocalStore(directory);
let tracks;
try {
  const scan=await scanFolder(folder,path.join(directory,'covers'),new AbortController().signal);
  assert.equal(scan.tracks.length,7);
  await store.transact(data=>{
    mergeScan(data,scan);data.roots=[];
    data.settings={...data.settings,background:'blue',accentColor:'#6CACE4'};
    // Actual tags only. Any explicit playback would use an original synthetic file, never user audio.
    for(const track of data.library.tracks) {
      data.files[track.id]={...data.files[track.id],path:fixture};
      data.lyricsByTrack[track.id]={...parseLyrics('',track.id),locked:false};
    }
    for(const album of data.library.albums)album.cover=null;
  });
  tracks=store.view().library.tracks;
} finally {await store.close();}
const persisted=()=>readFile(path.join(directory,'library.json'),'utf8').then(JSON.parse);
const immutable=data=>digest(Buffer.from(JSON.stringify({library:data.library,lyricsByTrack:data.lyricsByTrack})));
const beforeCollection=immutable(await persisted());
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const child=spawn(path.join(root,'src-tauri/target/debug/cd-player-desktop.exe'),
  ['--smoke-data',directory,'--smoke-report',nativeReport,'--smoke-manual'],
  {cwd:root,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b.toString());child.stderr.on('data',b=>logs+=b.toString());
const completed=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function connect(url) {
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(url),pending=new Map();let seq=0;
    socket.addEventListener('error',reject,{once:true});
    socket.addEventListener('message',event=>{const msg=JSON.parse(event.data),entry=pending.get(msg.id);if(!entry)return;
      pending.delete(msg.id);clearTimeout(entry.timer);msg.error?entry.reject(Error(JSON.stringify(msg.error))):entry.resolve(msg.result);});
    socket.addEventListener('open',()=>resolve({socket,send(method,params={}){return new Promise((resolve,reject)=>{
      const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}}));
  });
}
const evaluate=async(cdp,expression)=>{const result=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const act=async(cdp,action)=>{const result=await evaluate(cdp,`(async()=>{const i=window.__TAURI_INTERNALS__.invoke;const now=await i('clock_sample');return i('dispatch_action',{surface:'main',action:${JSON.stringify(action)},deadlineMs:now+4500});})()`);
  assert.equal(result.ok,true,JSON.stringify(result));return result;};
async function until(cdp,expression,limit=10000) {
  const start=Date.now();while(Date.now()-start<limit){const result=await evaluate(cdp,expression);if(result)return result;await delay(150);}
  throw Error('Native UI condition did not become true: '+expression.slice(0,120));
}
const reviewExpr=`[...document.querySelectorAll('[role="dialog"]')].find(d=>d.querySelector('h2')?.textContent==='歌词候选')`;
async function ready(cdp) {return until(cdp,`(()=>{const d=${reviewExpr};if(!d)return false;const r=[...d.querySelectorAll('[role="radio"]')];
  if(r.length)return r.map(e=>({id:e.dataset.candidate,label:e.getAttribute('aria-label'),text:e.innerText}));
  if(d.innerText.includes('没有找到候选'))return {noResults:true};if(d.innerText.includes('搜索没有完成'))throw Error('Real lyric service failed: '+d.innerText);return false;})()`,50000);}
async function click(cdp,selector,label) {
  await evaluate(cdp,`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)});
    if(!el||el.disabled)throw Error('Unavailable control: '+${JSON.stringify(label)});el.click();})()`);
}
async function screenshot(cdp,name) {
  // Export metadata/layout only; hide remotely sourced lyric text and the original draft text.
  await evaluate(cdp,`(()=>{const s=document.createElement('style');s.id='qa-hide-lyric-text';s.textContent='[aria-label^="候选歌词"] ol, textarea {visibility:hidden!important}';document.head.append(s);})()`);
  try {await delay(100);const result=await cdp.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));}
  finally {await evaluate(cdp,`document.getElementById('qa-hide-lyric-text')?.remove()`);}
}
async function searchCount() {
  try {return (await readFile(path.join(directory,'logs/diagnostics.ndjson'),'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    .filter(e=>e.event==='action_sent'&&e.action==='searchLyricsCandidates').length;}catch{return 0;}
}
let cdp,report,primaryError;
try {
  for(let n=0;n<100&&!cdp;n++) {
    try {const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for(const t of targets.filter(t=>t.type==='page')){const candidate=await connect(t.webSocketDebuggerUrl);
        if(await evaluate(candidate,`document.querySelector('.cdp')?.dataset.surface`)==='main'){cdp=candidate;break;}candidate.socket.close();}}
    catch {}if(!cdp)await delay(150);
  }
  assert.ok(cdp,'Isolated native main surface unavailable');
  const selected=tracks.filter(t=>['CIRCE','ENDROLL','ENDROLL -HaThA-'].includes(t.title));
  assert.equal(selected.length,3);
  const results=[];
  for(const track of selected) {
    const result=await act(cdp,{type:'searchLyricsCandidates',trackId:track.id});assert.equal(result.status,'started');
    const candidates=await ready(cdp);assert.ok(Array.isArray(candidates)&&candidates.length);
    assert.ok(await evaluate(cdp,`(${reviewExpr}).innerText.includes(${JSON.stringify(track.title)})`));
    if(track.title==='ENDROLL')for(const theme of ['blue','light','charcoal']) {
      await act(cdp,{type:'updateSettings',patch:{background:theme==='charcoal'?'light':theme,ui:{main:{materialTheme:theme==='charcoal'?'charcoal':'standard'}}}});
      await screenshot(cdp,'endroll-'+theme);
    } else await screenshot(cdp,track.title==='CIRCE'?'circe':'endroll-hatha');
    results.push({title:track.title,candidateCount:candidates.length,candidates:candidates.map(c=>({label:c.label,text:c.text}))});
    await act(cdp,{type:'closeLyricsReview'});
    assert.equal(immutable(await persisted()),beforeCollection,'Preview changed saved lyrics or library');
  }
  const track=selected.find(t=>t.title==='ENDROLL');
  await act(cdp,{type:'openLyricsEditor',trackId:track.id});
  await until(cdp,`!!document.querySelector('[aria-label="歌词编辑工具"]')`);
  await click(cdp,'button','开始输入');
  await until(cdp,`!!document.querySelector('textarea[aria-label="第 1 行原文"]')`);
  const draft='未保存的原创检查草稿';
  await evaluate(cdp,`(()=>{const e=document.querySelector('textarea[aria-label="第 1 行原文"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(draft)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(cdp,`document.body.innerText.includes('有未保存的修改')`);
  await click(cdp,'button','导入');await click(cdp,'[role="menuitem"]','从在线候选导入…');
  await ready(cdp);
  const searchesBefore=await searchCount();
  await evaluate(cdp,`(()=>{const d=${reviewExpr},e=d.querySelector('input[aria-label="曲名"]');e.focus();e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    d.querySelector('form').requestSubmit();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}));
    e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));
    e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));})()`);
  await delay(350);assert.equal(await searchCount(),searchesBefore);
  assert.ok(await evaluate(cdp,`!!(${reviewExpr})`),'IME Escape closed the candidate dialog');
  await evaluate(cdp,`(${reviewExpr}).dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}))`);
  assert.equal(immutable(await persisted()),beforeCollection);
  await evaluate(cdp,`[...(${reviewExpr}).querySelectorAll('button')].find(b=>b.textContent.includes('导入到编辑草稿')).click()`);
  await until(cdp,`!(${reviewExpr})&&document.body.innerText.includes('已导入原文')`);
  const importedRows=await evaluate(cdp,`document.querySelectorAll('[data-line-id]').length`);assert.ok(importedRows>1);
  assert.equal(immutable(await persisted()),beforeCollection,'Draft import saved remote lyrics');
  assert.ok(await evaluate(cdp,`document.body.innerText.includes('有未保存的修改')`));
  await screenshot(cdp,'draft-import');
  await click(cdp,'button','撤销');
  await until(cdp,`document.querySelector('textarea[aria-label="第 1 行原文"]')?.value===${JSON.stringify(draft)}`);
  assert.equal(immutable(await persisted()),beforeCollection);
  report={passed:true,prototypeVersion:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,
    explicitUserMetadataAuthorization:true,realProvider:'LRCLIB',results,realReviewDisplayed:true,
    previewDidNotSave:true,dirtyEditorDraftImported:true,importedRows,importCanUndo:true,
    imeCompositionEventsGuarded:true,ctrlSContained:true,realOsJapaneseImeManuallyTested:false,
    candidatesSavedToCollection:false,audioStarted:false,userAudioUsed:false,defaultUserStoreModified:false,
    completeRemoteLyricsIncluded:false,limits:['IME events exercised in WebView2; physical Japanese IME still needs manual confirmation','No claim that any candidate matches the exact recording or timing']};
} catch(error) {
  primaryError=error;await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack},null,2));
} finally {
  if(cdp)cdp.socket.close();
  await writeFile(nativeReport.replace(/\.json$/,'.stop'),'finish isolated lyric candidate review');
  const exit=await completed;await writeFile(path.join(output,'native.log'),logs);
  if(!primaryError){assert.equal(exit,0,logs);assert.equal(JSON.parse(await readFile(nativeReport,'utf8')).passed,true);}
}
if(primaryError)throw primaryError;
const reopened=await openLocalStore(directory);await reopened.close();
assert.deepEqual(await fingerprints(folder),beforeFiles,'Original CD files changed');
assert.equal(immutable(await persisted()),beforeCollection);
report.originalAudioAndAttachmentsUnchanged=true;report.storeReopened=true;
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({output,passed:true,realTracksPreviewed:report.results.length,dirtyDraftNotSaved:true}));

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// WebView2 devtools are enabled only for this isolated debug process, never for the release app.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const output = path.join(root, '.cache', 'mini-lyrics-native-' + Date.now());
await mkdir(output);
const child = spawn(process.execPath, [path.join(root, 'scripts/ui-r2-2-smoke.mjs'), '--fixture',
  path.join(root, '.cache/audio-check/Disc 1/01 原创音.flac')], {
  cwd: root, windowsHide: true, env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', session;
child.stdout.on('data', bytes => {
  const text = bytes.toString(); logs += text;
  for (const line of text.split('\n')) try { const value = JSON.parse(line); if (value.workspace && value.stop) session = value; } catch {}
});
child.stderr.on('data', bytes => { logs += bytes.toString(); });
const completed = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url), pending = new Map(); let seq = 0;
    socket.addEventListener('error', reject, { once: true });
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data), entry = pending.get(msg.id);
      if (!entry) return; pending.delete(msg.id); clearTimeout(entry.timer);
      if (msg.error) entry.reject(Error(JSON.stringify(msg.error))); else entry.resolve(msg.result);
    });
    socket.addEventListener('open', () => resolve({ socket, send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      });
    } }));
  });
}
const evaluate = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const act = async (cdp, action) => {
  const result = await evaluate(cdp, `(async()=>{const i=window.__TAURI_INTERNALS__.invoke;
    const now=await i('clock_sample');return i('dispatch_action',{surface:document.querySelector('.cdp').dataset.surface,action:${JSON.stringify(action)},deadlineMs:now+4500});})()`);
  assert.equal(result.ok, true, JSON.stringify(result));
};
async function gpu(nativePid) {
  const script = `$ErrorActionPreference='Stop'; try {
    $all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${nativePid});
    for($n=0;$n -lt 5;$n++){ foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)){[void]$ids.Add([int]$p.ProcessId)}} }
    $samples=@(); for($n=0;$n -lt 4;$n++){
      $v=Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine;
      $selected=@($v | Where-Object { $_.Name -match '^pid_(\\d+)_.*engtype_3D' -and $ids.Contains([int]$Matches[1]) });
      $sum=($selected | Measure-Object UtilizationPercentage -Sum).Sum;
      $samples+=@{sum3DEnginePercent=[double]$sum;engineInstances=$selected.Count}; Start-Sleep -Milliseconds 650;
    }; @{available=$true;samples=$samples;processCount=$ids.Count} | ConvertTo-Json -Depth 5 -Compress
  } catch { @{available=$false;reason=$_.Exception.Message} | ConvertTo-Json -Compress }`;
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  let text = ''; helper.stdout.on('data', b => { text += b.toString(); });
  helper.stderr.on('data', () => {});
  await new Promise((resolve, reject) => { helper.once('exit', resolve); helper.once('error', reject); });
  return JSON.parse(text.trim());
}

let main, mini, report, primaryError;
const samples=[];
try {
  for (let n=0;n<80&&(!main||!mini);n++) {
    try {
      const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const target of targets.filter(t=>t.type==='page')) {
        const candidate=await connect(target.webSocketDebuggerUrl);
        const surface=await evaluate(candidate, `document.querySelector('.cdp')?.dataset.surface`);
        if(surface==='main'&&!main)main=candidate;
        else if(surface==='mini'&&!mini)mini=candidate;
        else candidate.socket.close();
      }
    } catch {}
    if(!main||!mini)await delay(150);
  }
  assert.ok(main&&mini&&session);
  await evaluate(mini, `(async()=>{window.__miniEvents=[];
    const i=window.__TAURI_INTERNALS__;const id=i.transformCallback(e=>window.__miniEvents.push(e.payload));
    await i.invoke('plugin:event|listen',{event:'cd-snapshot',target:{kind:'Any'},handler:id});})()`);
  const snapshot=cdp=>evaluate(cdp, `window.__TAURI_INTERNALS__.invoke('request_snapshot')`);
  await act(main,{type:'setMuted',muted:true});
  const before=(await snapshot(main)).snapshot;
  const track=before.library.tracks.find(t=>t.id==='track-blue')??before.library.tracks[0];
  await act(main,{type:'openLyricsEditor',trackId:track.id});
  const doc=(await snapshot(main)).snapshot.lyricsEditor.document;
  await act(main,{type:'saveLyrics',trackId:track.id,baseRevision:doc.revision,patch:{kind:'synced',offsetMs:0,lines:[
    {id:'native-mini-a',startMs:0,original:'原创第一句'},
    {id:'native-mini-b',startMs:1000,original:'原创第二句'},
    {id:'native-mini-break',startMs:2000,original:''},
    {id:'native-mini-c',startMs:3000,original:'原创第三句'},
  ],language:'zh-Hans',translationLanguage:null,locked:false}});
  await act(main,{type:'closeLyricsEditor'});
  await act(main,{type:'playAlbum',albumId:track.albumId,startTrackId:track.id});
  await act(main,{type:'togglePlayback'});
  await act(main,{type:'seek',positionMs:100});
  await act(main,{type:'updateSettings',patch:{miniShowLyrics:true}});
  await act(main,{type:'setWindowMode',mode:'mini'});
  const capture=async label=>{
    await delay(450);
    const value=await evaluate(mini, `(async()=>{const s=(await window.__TAURI_INTERNALS__.invoke('request_snapshot')).snapshot;
      const card=document.querySelector('[class*="card"][data-lyrics]'),line=document.querySelector('[class*="lyricLine"]');
      const rect=el=>el?{x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}:null;
      let fibre=document.querySelector('.cdp')?.[Object.keys(document.querySelector('.cdp')).find(k=>k.startsWith('__reactFiber'))];
      let rendered=null;for(let n=0;fibre&&n<20;n++,fibre=fibre.return){if(fibre.memoizedProps?.snapshot){rendered=fibre.memoizedProps.snapshot;break;}}
      return {host:s.host,player:s.player,rendered:rendered?{host:rendered.host,sequence:rendered.player.sampleSequence}:null,
      events:(window.__miniEvents??[]).slice(-8).map(e=>({sequence:e.sequence,host:e.snapshot.host,sampleSequence:e.snapshot.player?.sampleSequence})),lyrics:{kind:s.lyrics?.kind,trackId:s.lyrics?.trackId,lineCount:s.lyrics?.lines.length},
      shown:document.querySelector('.cdp')?.dataset.visible,text:line?.textContent,card:rect(card),line:rect(line),
      opacity:line?getComputedStyle(line).opacity:null,animation:line?getComputedStyle(line).animation:null};})()`);
    samples.push({label,...value});
    assert.equal(value.shown,String(value.host.surfaceVisible),'Rendered visibility differs from the native window');
    const shot=await mini.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(path.join(output,label+'.png'),Buffer.from(shot.data,'base64'));
    return value;
  };
  await capture('initial');
  for(const [position,expected,label] of [[1100,'原创第二句','second'],[2100,'♪','break'],[3100,'原创第三句','third']]) {
    await act(mini,{type:'seek',positionMs:position});
    const sample=await capture(label);
    assert.equal(sample.text,expected,'Mini lyric text: '+JSON.stringify(sample));
    assert.equal(sample.opacity,'1','Mini line opacity');
    assert.ok(sample.line.y+sample.line.height<=sample.card.y+sample.card.height,'Lyric outside mini card');
  }
  await act(mini,{type:'seek',positionMs:100});
  await act(mini,{type:'togglePlayback'});
  await capture('playing-first');
  for(const [expected,label] of [['原创第二句','playing-second'],['♪','playing-break'],['原创第三句','playing-third']]) {
    for(let n=0;n<30;n++) {
      if(await evaluate(mini,`document.querySelector('[class*="lyricLine"]')?.textContent`)===expected)break;
      await delay(50);
    }
    const value=await capture(label);assert.equal(value.text,expected);assert.equal(value.opacity,'1');
  }
  await act(mini,{type:'togglePlayback'});
  await mini.send('Page.reload');await delay(700);
  const reload=await capture('reloaded');assert.equal(reload.text,'原创第三句');assert.equal(reload.opacity,'1');
  await act(mini,{type:'hideToTray'});await delay(100);
  await act(main,{type:'setWindowMode',mode:'mini'});
  const restored=await capture('restored');assert.equal(restored.text,'原创第三句');assert.equal(restored.opacity,'1');
  report={passed:true,samples,defaultUserDataModified:false,realAudioUsed:false};
} catch(error) {primaryError=error;report={passed:false,error:String(error),samples};}
finally {
  main?.socket.close();mini?.socket.close();
  if(session)await writeFile(session.stop,'stop');else child.kill();
  const exit=await completed;
  await writeFile(path.join(output,'native.log'),logs);
  await writeFile(path.join(output,'report.json'),JSON.stringify({...report,exit},null,2));
  console.log(JSON.stringify({output,passed:report.passed,error:report.error,samples:report.samples?.map(s=>({label:s.label,text:s.text,visible:s.shown,opacity:s.opacity})),exit}));
}
if(primaryError)throw primaryError;

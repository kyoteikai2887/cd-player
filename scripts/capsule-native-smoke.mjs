import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// WebView2 devtools are enabled only for this isolated debug process, never for the release app.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memorial = process.argv.includes('--memorial');
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const output = path.join(root, '.cache', 'capsule-native-' + Date.now());
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
    const now=await i('clock_sample');return i('dispatch_action',{surface:'main',action:${JSON.stringify(action)},deadlineMs:now+4500});})()`);
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
let cdp, report, primaryError;
try {
  for (let n = 0; n < 80 && !cdp; n++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const target of targets.filter(t => t.type === 'page')) {
        const candidate = await connect(target.webSocketDebuggerUrl);
        if (await evaluate(candidate, `document.querySelector('.cdp')?.dataset.surface`) === 'main') { cdp = candidate; break; }
        candidate.socket.close();
      }
    } catch {}
    if (!cdp) await delay(150);
  }
  assert.ok(cdp && session, 'Isolated native main surface was not ready');
  await evaluate(cdp, 'document.fonts.ready.then(()=>true)');
  await act(cdp, { type: 'setMuted', muted: true });
  await evaluate(cdp, `document.querySelector('button[aria-label^="播放 "]').click()`);
  await delay(350);
  if (!memorial) await act(cdp, { type: 'togglePlayback' });
  await delay(150);
  await cdp.send('Performance.enable');
  const rounds = [];
  for (const theme of ['light', 'blue', 'charcoal']) {
    await act(cdp, { type: 'updateSettings', patch: { background: theme === 'charcoal' ? 'blue' : theme,
      ...(memorial ? { accentColor: '#DB7A3D' } : {}),
      glassIntensity: .65, ui: { main: { materialTheme: theme === 'charcoal' ? 'charcoal' : 'standard' } } } });
    await delay(150);
    const before = await cdp.send('Performance.getMetrics');
    const [scroll, graphics] = await Promise.all([
      evaluate(cdp, `(async()=>{const s=document.querySelector('[data-scroller="library"]');
        const c=document.querySelector('.glass--frost-see');if(!s||!c)throw Error('Capsule or shelf missing');
        const frames=[];let last=performance.now(),start=last;
        await new Promise(resolve=>{function frame(t){frames.push(t-last);last=t;
          s.scrollTop=(Math.sin((t-start)/450)+1)*230;if(t-start<3200)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});
        const style=getComputedStyle(c), frost=getComputedStyle(c.querySelector('.cdp-frost'));
        return {theme:document.querySelector('.cdp').dataset.theme,scrollTop:s.scrollTop,frames,
          filter:style.backdropFilter,frostOpacity:frost.opacity,text:c.innerText};})()`),
      gpu(session.pid),
    ]);
    assert.equal(scroll.theme, theme); assert.match(scroll.filter, /blur\(24px\)/);
    assert.equal(scroll.frostOpacity, '0.6'); assert.ok(scroll.frames.length > 20);
    const after = await cdp.send('Performance.getMetrics');
    const playback = await evaluate(cdp, `window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>({status:r.snapshot.player.status,muted:r.snapshot.player.muted}))`);
    if (memorial) { assert.equal(playback.status, 'playing'); assert.equal(playback.muted, true); }
    const value = (data, name) => data.metrics.find(m => m.name === name)?.value ?? 0;
    const frames = scroll.frames.slice(2).sort((a, b) => a - b);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, theme + '.png'), Buffer.from(shot.data, 'base64'));
    await evaluate(cdp, `document.querySelector('[data-scroller="library"]').scrollTop=390`);
    await delay(500);
    const topbar = await evaluate(cdp, `(()=>{const bar=document.querySelector('[class*="barWrap"][data-scrolled="true"]');
      if(!bar)throw Error('Scrolled topbar missing'); const c=getComputedStyle(bar),r=bar.getBoundingClientRect();
      return {filter:c.backdropFilter,background:c.backgroundColor,rect:{x:r.x,y:r.y,width:r.width,height:r.height},scrollTop:document.querySelector('[data-scroller="library"]').scrollTop};})()`);
    const barShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, 'topbar-' + theme + '-500ms.png'), Buffer.from(barShot.data, 'base64'));
    rounds.push({ theme, playback, filter: scroll.filter, frostOpacity: scroll.frostOpacity,
      frameCount: scroll.frames.length, frameMedianMs: frames[Math.floor(frames.length / 2)],
      frameP95Ms: frames[Math.floor(frames.length * .95)],
      mainThreadTaskSeconds: value(after, 'TaskDuration') - value(before, 'TaskDuration'), gpu: graphics, topbarAfter500ms: topbar });
  }
  await act(cdp, { type: 'updateSettings', patch: { glassIntensity: 0 } }); await delay(100);
  const fallback = await evaluate(cdp, `(()=>{const c=document.querySelector('.glass--frost-see');return {
    filter:getComputedStyle(c).backdropFilter,opacity:getComputedStyle(c.querySelector('.cdp-frost')).opacity};})()`);
  assert.deepEqual(fallback, { filter: 'none', opacity: '1' });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  const contrast = await evaluate(cdp, `(()=>{const c=document.querySelector('.glass--frost-see');return {
    active:matchMedia('(forced-colors: active)').matches,filter:getComputedStyle(c).backdropFilter,background:getComputedStyle(c).backgroundColor};})()`);
  assert.equal(contrast.active, true); assert.equal(contrast.filter, 'none');
  report = { passed: true, memorial, playbackDuringScroll: memorial, themes: rounds, solidFallback: fallback, forcedColors: contrast,
    sourceFixtureOnly: true, defaultUserStoreModified: false, realAudioUsed: false,
    limits: ['Short automated scroll only; frame timing includes instrumentation',
      'GPU engine sums for isolated app descendants are samples, not whole-system or long-term load',
      'No comparison to R2.1 and no GPU memory measurement', 'Transparency system policy fallback inherited from material tests'] };
} catch (error) {
  primaryError = error;
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2));
} finally {
  // Give heartbeat/snapshot transport a turn after the instrumented render task completes.
  if (cdp) await delay(800);
  if (cdp) cdp.socket.close();
  if (session) await writeFile(session.stop, 'finish isolated capsule check');
  const exit = await completed;
  await writeFile(path.join(output, 'native.log'), logs);
  if (!primaryError) assert.equal(exit, 0, logs);
}
if (primaryError) throw primaryError;
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, ...report }, null, 2));

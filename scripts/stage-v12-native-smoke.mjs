import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { openLocalStore } from '../src/local/store.ts';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';
import { parseLyrics } from '../src/core/lyrics.ts';
import { themePatch } from '../src/ui/lib/theme.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.cache', 'stage-v12-native-' + Date.now());
await mkdir(output);
const data = path.join(output, 'data'), music = path.join(output, 'music', 'V1.2 测试专辑');
await mkdir(music, { recursive: true });
// Generated quiet tones, never the user's recordings. Each track is ample for pointer checks.
function wav(frequency) {
  const rate = 48000, samples = rate * 45, b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 0.06 * 32767), 44 + i * 2);
  return b;
}
await writeFile(path.join(music, '01 低频.wav'), wav(1000));
await writeFile(path.join(music, '02 高频.wav'), wav(4000));
const store = await openLocalStore(data); let albumId;
try {
  const scan = await scanFolder(music, path.join(data, 'covers'), new AbortController().signal);
  await store.transact(d => {
    mergeScan(d, scan); albumId = d.library.albums[0].id;
    for (const t of d.library.tracks) d.lyricsByTrack[t.id] = parseLyrics('[00:00.00]真实信号测试\n[00:20.00]独立测试资料库', t.id);
    d.settings.motion = 'full'; d.settings.miniShowLyrics = false;
  });
} finally { await store.close(); }
const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const report = path.join(output, 'native.json');
const streaming = process.argv.includes('--streaming');
const child = spawn(path.join(root, 'src-tauri/target/debug/cd-player-desktop.exe'),
  ['--smoke-data', data, '--smoke-report', report, '--smoke-manual', ...(streaming ? ['--smoke-stream-only'] : [])],
  { cwd: root, windowsHide: true, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const done = new Promise((r, j) => { child.once('exit', r); child.once('error', j); });
const delay = ms => new Promise(r => setTimeout(r, ms)); const run = promisify(execFile);
function connect(url) { return new Promise((resolve, reject) => {
  const socket = new WebSocket(url), pending = new Map(); let id = 0;
  socket.addEventListener('error', reject, { once: true });
  socket.addEventListener('message', e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); });
  socket.addEventListener('open', () => resolve({ socket, send(method, params = {}) { return new Promise((r, j) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); j(Error(method + ' timeout')); }, 15000);
    pending.set(key, { resolve: r, reject: j, timer }); socket.send(JSON.stringify({ id: key, method, params })); }); } }));
}); }
async function evaluate(c, expression) { const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
async function until(c, expression) { for (let i = 0; i < 100; i++) { if (await evaluate(c, expression)) return; await delay(100); } throw Error('Timeout: ' + expression); }
const snapshot = c => evaluate(c, "window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot)");
async function act(c, action, surface = 'main') { const result = await evaluate(c, `(async()=>{const i=window.__TAURI_INTERNALS__.invoke,now=await i('clock_sample');return i('dispatch_action',{surface:${JSON.stringify(surface)},action:${JSON.stringify(action)},deadlineMs:now+4500});})()`);
  assert.equal(result.ok, true, JSON.stringify(result)); return result; }
async function point(c, selector) {
  await until(c, '!!document.querySelector(' + JSON.stringify(selector) + ')');
  await evaluate(c, 'document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"center"})');
  for (let i = 0; i < 60; i++) {
    const p = await evaluate(c, '(()=>{const e=document.querySelector(' + JSON.stringify(selector) + '),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,w:r.width,l:r.left,reachable:h===e||e.contains(h)}})()');
    if (p.reachable) return p; await delay(100);
  } throw Error('Pointer target blocked: ' + selector);
}
async function click(c, selector) { const p = await point(c, selector); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
  await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }); }
async function range(c, selector, fraction) { const p = await point(c, selector), x = p.l + 8 + (p.w - 16) * fraction;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.l + 8, y: p.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.l + 8, y: p.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.l + 8 + (x - p.l - 8) * i / 10, y: p.y, button: 'left', buttons: 1 }); await delay(30); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: p.y, button: 'left', clickCount: 1 }); await delay(300);
}
async function shot(c, name) { await evaluate(c, 'document.fonts.ready.then(()=>true)'); await delay(200);
  const r = await c.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name + '.png'), Buffer.from(r.data, 'base64')); }
const svg = 'svg[data-state]', bar = 'svg[data-state] line[class*="_bar_"]';
const inspect = c => evaluate(c, `(()=>{const e=document.querySelector('${svg}'),lines=e?[...e.querySelectorAll('line[class*="_bar_"]')]:[];return {state:e?.dataset.state,heights:lines.map(l=>+l.getAttribute('y1')- +l.getAttribute('y2')),reads:window.__stageReads||0,draws:window.__stageDraws||0,wavePeak:window.__stageWavePeak,frequencyMax:window.__stageFrequencyMax}})()`);
const ambient = c => evaluate(c, `(()=>{const e=document.querySelector('[data-ambient="stage"]');if(!e)return null;return {flow:e.dataset.flow,lights:+e.dataset.lights,heads:[...e.querySelectorAll('[data-meteor]')].map(p=>({offset:getComputedStyle(p).transform,opacity:getComputedStyle(p).opacity,animations:p.getAnimations().map(a=>({name:a.animationName,time:a.currentTime,state:a.playState}))}))}})()`);
async function heldLight(c, flow) {
  await until(c, `document.querySelector('[data-ambient="stage"]')?.dataset.flow===${JSON.stringify(flow)}`);
  await delay(100); // Let the compositor commit the new animation-play-state before reading its clock.
  const a = await ambient(c); await delay(450); const b = await ambient(c);
  assert.ok(a.heads.length > 0); assert.equal(b.heads.length, a.heads.length);
  for (let i = 0; i < b.heads.length; i++) {
    assert.equal(b.heads[i].offset, a.heads[i].offset); assert.equal(b.heads[i].opacity, a.heads[i].opacity);
    assert.equal(b.heads[i].animations.length, a.heads[i].animations.length);
    for (let j = 0; j < b.heads[i].animations.length; j++) {
      const before = a.heads[i].animations[j], after = b.heads[i].animations[j];
      assert.equal(after.state, 'paused'); assert.equal(after.name, before.name);
      // WebView2 may settle its reported animation clock by one compositor frame after hiding.
      assert.ok(Math.abs(after.time - before.time) <= 34, 'Light clock must stop in ' + flow);
    }
  }
}
const checks = [], signals = [], layouts = [], lightStates = [], pages = {}; let error;
try {
  for (let i = 0; i < 100 && !(pages.main && pages.mini); i++) { try {
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    for (const t of targets.filter(t => t.type === 'page')) { const c = await connect(t.webSocketDebuggerUrl), surface = await evaluate(c, "document.querySelector('.cdp')?.dataset.surface");
      if (['main', 'mini'].includes(surface) && !pages[surface]) pages[surface] = c; else c.socket.close(); }
  } catch {} if (!(pages.main && pages.mini)) await delay(150); }
  assert.ok(pages.main && pages.mini); const c = pages.main, m = pages.mini;
  await until(c, `document.querySelector('${bar}')!==null`);
  // A display-only fictional cover exercises the album-color material without altering a library file.
  const current = await snapshot(c);
  const cover = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#85bdfa"/><stop offset="1" stop-color="#345f89"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="300" cy="100" r="55" fill="#d8ecff"/><path d="M0 280Q90 200 200 300T400 290V400H0Z" fill="#648ead"/><text x="24" y="38" font-family="sans-serif" font-size="16" fill="white">SIGNAL TEST - FICTIONAL COVER</text></svg>').toString('base64');
  const library = { ...current.library, albums: current.library.albums.map(a => ({ ...a, cover: { thumbUrl: cover, fullUrl: cover } })) };
  for (const surface of ['main', 'mini']) await evaluate(c, 'window.__TAURI_INTERNALS__.invoke("push_snapshot",{surface:' + JSON.stringify(surface) + ',delta:' + JSON.stringify({ library }) + '})');
  await evaluate(c, `(()=>{window.__stageReads=0;window.__stageDraws=0;const original=AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData=function(a){window.__stageReads++;const result=original.call(this,a);window.__stageWavePeak=Math.max(...a.map(Math.abs));return result};
    const originalFreq=AnalyserNode.prototype.getFloatFrequencyData;AnalyserNode.prototype.getFloatFrequencyData=function(a){const result=originalFreq.call(this,a);window.__stageFrequencyMax=Math.max(...a);return result};
    const first=document.querySelector('${bar}');new MutationObserver(ms=>{window.__stageDraws+=ms.filter(m=>m.attributeName==='y2').length}).observe(first,{attributes:true});})()`);
  await act(c, { type: 'setVolume', volume: 0.5 }); await act(c, { type: 'setRepeat', repeat: 'all' });
  await act(c, { type: 'playAlbum', albumId });
  await until(c, `document.querySelector('${svg}')?.dataset.state==='live'`); await delay(800);
  const low = await inspect(c); signals.push({ name: '1kHz', ...low }); assert.equal(low.heights.length, 24); assert.ok(Math.max(...low.heights) > 0);
  const before = low.reads; await delay(1200); const sampled = await inspect(c);
  const rate = (sampled.reads - before) / 1.2; assert.ok(rate > 4 && rate <= 26, 'Actual analysis reads/sec: ' + rate);
  checks.push('real audio lights 24 spectrum tokens; analyzer sampling is bounded');
  await until(c, `+document.querySelector('[data-ambient="stage"]')?.dataset.lights>0`);
  const lightBefore = await ambient(c); await delay(500); const lightAfter = await ambient(c);
  assert.equal(lightAfter.flow, 'run'); assert.ok(lightAfter.heads.some((h, i) => h.animations.some((a, j) => a.state === 'running' && a.time > lightBefore.heads[i].animations[j].time + 200)));
  lightStates.push({ name: 'playing', before: lightBefore, after: lightAfter }); checks.push('native CSS starlight advances along the etched trails during audible playback');
  await act(c, { type: 'next' }); await delay(1100); const high = await inspect(c); signals.push({ name: '4kHz', ...high });
  const dominant = a => a.indexOf(Math.max(...a)); assert.notEqual(dominant(low.heights), dominant(high.heights));
  assert.equal(dominant(low.heights), 12); assert.equal(dominant(high.heights), 18); checks.push('1kHz and 4kHz move distinct correct bands after track changes');
  await act(c, { type: 'setMuted', muted: true }); await delay(2500); const muted = await inspect(c);
  assert.equal(muted.state, 'idle'); assert.ok(muted.heights.every(v => v === 0)); checks.push('mute returns all cells to smooth static grooves');
  await heldLight(c, 'hold');
  await act(c, { type: 'setMuted', muted: false }); await delay(600); assert.ok(Math.max(...(await inspect(c)).heights) > 0);
  await act(c, { type: 'togglePlayback' }); await delay(2500); assert.ok((await inspect(c)).heights.every(v => v === 0));
  const quietBefore = (await inspect(c)).draws; await delay(1000); const quietRate = (await inspect(c)).draws - quietBefore;
  assert.ok(quietRate >= 2 && quietRate <= 6, 'Quiet draw rate: ' + quietRate); checks.push('paused visualization rests and slows to roughly 4 reads/sec');
  await heldLight(c, 'hold');
  await act(c, { type: 'togglePlayback' }); await delay(500);
  await act(c, { type: 'setVolume', volume: 0 }); await heldLight(c, 'hold');
  await act(c, { type: 'setVolume', volume: 0.5 }); await until(c, `document.querySelector('[data-ambient="stage"]')?.dataset.flow==='run'`);
  checks.push('starlight clock holds during pause, mute and zero volume, then resumes');
  await click(c, 'button[aria-label="打开正在播放"]'); await delay(700); const routeBefore = (await inspect(c)).reads;
  await heldLight(c, 'off');
  await delay(1000); assert.equal((await inspect(c)).reads, routeBefore); checks.push('real IntersectionObserver stops analysis off the library page');
  await click(c, 'button[aria-label="返回"]'); await until(c, `document.querySelector('${svg}')?.dataset.state==='live'`);
  await click(c, 'button[aria-label="设置"]'); await click(c, '[role="switch"][aria-label="主舞台音乐图案"]');
  await until(c, `!document.querySelector('${svg}')`); await click(c, '[role="dialog"] button[aria-label="关闭"]');
  const offBefore = await evaluate(c, 'window.__stageReads'); await delay(700); assert.equal(await evaluate(c, 'window.__stageReads'), offBefore);
  assert.equal((await ambient(c)).flow, 'run'); checks.push('turning off the music diagram preserves independent starlight');
  await act(c, { type: 'updateSettings', patch: { ui: { main: { audioVisualization: true } } } });
  await until(c, `document.querySelector('${svg}')?.dataset.state==='live'`); checks.push('actual settings switch persists and stops sampling');
  await act(c, { type: 'updateSettings', patch: { motion: 'reduced' } }); await delay(700);
  const reducedBefore = await evaluate(c, 'window.__stageReads'); await delay(1200);
  const reducedRate = (await evaluate(c, 'window.__stageReads') - reducedBefore) / 1.2; assert.ok(reducedRate >= 2 && reducedRate <= 5.1);
  assert.equal(await evaluate(c, `getComputedStyle(document.querySelector('${svg} rect')).display`), 'none'); checks.push('reduced motion limits analysis to about 4 reads/sec and hides peaks');
  const still = await ambient(c); assert.equal(still.flow, 'still'); assert.ok(still.heads.length > 0 && still.heads.every(h => h.animations.length === 0));
  await delay(300); assert.deepEqual((await ambient(c)).heads, still.heads); lightStates.push({ name: 'reduced', still });
  await act(c, { type: 'updateSettings', patch: { motion: 'full' } });
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] }); await delay(600);
  const forcedBefore = await evaluate(c, 'window.__stageReads'); await delay(600); assert.equal(await evaluate(c, 'window.__stageReads'), forcedBefore);
  assert.equal(await evaluate(c, `getComputedStyle(document.querySelector('${svg}')).display`), 'none');
  assert.equal(await evaluate(c, 'getComputedStyle(document.querySelector("[data-etch=star-trails]")).display'), 'none');
  assert.equal(await ambient(c), null); checks.push('reduced motion makes starlight static; forced colors removes it');
  await c.send('Emulation.setEmulatedMedia', { features: [] }); checks.push('forced-colors hides decorations and stops audio analysis');
  // Inject an analyzer read failure in this isolated renderer only; audio must keep playing.
  await evaluate(c, 'window.__stageFrequency=AnalyserNode.prototype.getFloatFrequencyData;AnalyserNode.prototype.getFloatFrequencyData=function(){throw Error("isolated unavailable check")};');
  await until(c, `document.querySelector('${svg}')?.dataset.state==='unavailable'`); await delay(2500);
  assert.equal((await snapshot(c)).player.status, 'playing'); assert.ok((await inspect(c)).heights.every(v => v === 0));
  await evaluate(c, 'AnalyserNode.prototype.getFloatFrequencyData=window.__stageFrequency'); checks.push('unavailable analysis falls back to static grooves without stopping audio');
  if (!streaming) for (const theme of ['light', 'blue', 'charcoal']) for (const size of [[960, 600], [1280, 800], [1920, 1080]]) {
    await act(c, { type: 'updateSettings', patch: themePatch(theme) });
    const dpr = await evaluate(c, 'devicePixelRatio');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/stage-v12-resize-smoke-window.ps1'),
      '-TargetProcessId', String(child.pid), '-ClientWidth', String(Math.round(size[0] * dpr)), '-ClientHeight', String(Math.round(size[1] * dpr))], { windowsHide: true });
    await delay(450);
    const layout = await evaluate(c, `(()=>{const stage=document.querySelector('section[data-viz]'),field=stage.querySelector('${svg}'),r=stage.getBoundingClientRect(),f=field.getBoundingClientRect(),etch=stage.querySelector('[class*="_etch_"]'),e=etch?.getBoundingClientRect();return {theme:document.querySelector('.cdp').dataset.theme,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth-innerWidth,stage:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},field:{left:f.left,right:f.right,top:f.top,bottom:f.bottom},fieldDisplay:getComputedStyle(field).display,etch:e?{left:e.left,right:e.right,display:getComputedStyle(etch).display}:null,stars:getComputedStyle(stage.querySelector('[data-etch=star-trails]')).pointerEvents}})()`);
    assert.equal(layout.overflow, 0); assert.equal(layout.stars, 'none');
    if (layout.fieldDisplay !== 'none') { assert.ok(layout.field.left >= layout.stage.left); assert.ok(layout.field.right <= layout.stage.right + 1);
      assert.ok(layout.field.top >= layout.stage.top); assert.ok(layout.field.bottom <= layout.stage.bottom + 1);
      if (layout.etch?.display !== 'none') assert.ok(layout.field.right <= layout.etch.left, 'Field overlaps memorial'); }
    layouts.push(layout); await shot(c, 'stage-' + theme + '-' + size[0]);
  }
  if (!streaming) checks.push('three themes and compact/wide dimensions keep visuals inside the stage');
  await act(c, { type: 'setWindowMode', mode: 'mini' });
  await until(m, 'document.querySelector(".cdp")?.dataset.surface==="mini"'); await delay(600);
  const hiddenBefore = await evaluate(c, 'window.__stageReads'); await delay(700); assert.equal(await evaluate(c, 'window.__stageReads'), hiddenBefore);
  await heldLight(c, 'off'); checks.push('leaving the library and hiding the native main window stop the starlight clock');
  await evaluate(m, `(()=>{window.__stageInvokes=[];const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=function(command,args,...rest){if(command==='dispatch_action')window.__stageInvokes.push(args?.action?.type);return original.call(this,command,args,...rest)}})()`);
  await act(m, { type: 'setVolume', volume: 0.7 }, 'mini');
  await click(m, '[data-volume-entry]'); await until(m, 'document.activeElement?.getAttribute("aria-label")==="音量"');
  assert.equal(await evaluate(m, 'document.querySelector("[data-volume-entry]").getAttribute("aria-expanded")'), 'true');
  const windowBefore = await evaluate(m, '({x:screenX,y:screenY,w:innerWidth,h:innerHeight})');
  await range(m, '[data-volume-panel] input[aria-label="音量"]', 0.27);
  const volume = (await snapshot(m)).player.volume; assert.ok(Math.abs(volume - 0.27) < 0.05, 'Native slider volume: ' + volume);
  assert.equal((await snapshot(c)).player.volume, volume);
  assert.ok(Math.abs(await evaluate(c, '+document.querySelector("[aria-label=播放控制] input[aria-label=音量]").value') - volume) < 0.01);
  const windowAfter = await evaluate(m, '({x:screenX,y:screenY,w:innerWidth,h:innerHeight})'); assert.deepEqual(windowAfter, windowBefore);
  const p = await point(m, '[data-volume-panel] input');
  for (let n = 1; n <= 2; n++) for (const type of ['mousePressed', 'mouseReleased']) await m.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: n });
  assert.equal((await snapshot(m)).host.windowMode, 'mini');
  assert.ok(!(await evaluate(m, 'window.__stageInvokes')).includes('beginWindowDrag')); checks.push('native mini slider drag/double-click does not move or expand its window; main stays synchronized');
  await click(m, '[data-volume-panel] button[aria-label="静音"]'); await until(m, 'document.querySelector("[data-volume-panel] input").getAttribute("aria-valuetext").includes("已静音")');
  assert.equal((await snapshot(c)).player.muted, true); await click(m, '[data-volume-panel] button[aria-label="取消静音"]');
  await evaluate(m, 'document.querySelector("[data-volume-panel] input").focus()');
  for (const type of ['keyDown', 'keyUp']) await m.send('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await delay(250); const keyed = (await snapshot(m)).player.volume; assert.ok(keyed > 0.45);
  for (const type of ['keyDown', 'keyUp']) await m.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(m, '!document.querySelector("[data-volume-panel]")');
  assert.equal(await evaluate(m, 'document.activeElement?.hasAttribute("data-volume-entry")'), true);
  checks.push('mini mute, keyboard adjustment, Escape and focus restoration work through native actions');
  if (!streaming) for (const lyrics of [false, true]) for (const theme of ['light', 'blue', 'charcoal']) {
    await act(m, { type: 'updateSettings', patch: { ...themePatch(theme), miniShowLyrics: lyrics } }, 'mini');
    await delay(350); await click(m, '[data-volume-entry]');
    const layout = await evaluate(m, `(()=>{const panel=document.querySelector('[data-volume-panel]'),card=document.querySelector('[data-volume]'),p=panel.getBoundingClientRect(),r=card.getBoundingClientRect(),line=card.querySelector('[class*="_lyric_"]'),l=line?.getBoundingClientRect();return {theme:document.querySelector('.cdp').dataset.theme,frame:document.querySelector('[data-frame]').dataset.frame,card:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height},panel:{left:p.left,right:p.right,top:p.top,bottom:p.bottom},lyric:l?{top:l.top,bottom:l.bottom}:null,w:innerWidth,h:innerHeight}})()`);
    assert.ok(layout.panel.left >= layout.card.left && layout.panel.right <= layout.card.right);
    assert.ok(layout.panel.top >= layout.card.top && layout.panel.bottom <= layout.card.bottom);
    // Native client dimensions are rounded to physical pixels, then divided by the monitor DPI.
    assert.ok(Math.abs(layout.card.height - (lyrics ? 140 : 92)) <= 1.5, 'Card height outside DPI rounding tolerance');
    if (lyrics) assert.ok(layout.lyric && layout.panel.bottom <= layout.lyric.top);
    layouts.push(layout); await shot(m, 'mini-volume-' + theme + (lyrics ? '-lyrics' : ''));
    await click(m, '[data-volume-panel] button[aria-label="收起音量"]');
  }
  await click(m, '[data-volume-entry]'); await click(m, '[class*="_art_"]'); await until(m, '!document.querySelector("[data-volume-panel]")');
  await click(m, 'button[aria-label="展开"]'); await until(c, `document.querySelector('${svg}')?.dataset.state==='live'`);
  assert.ok((await inspect(c)).reads > hiddenBefore);
  checks.push(streaming ? 'hidden main stops and resumes sampling while using mini controls' : 'mini panel fits 92/140 cards in all themes; hidden main stops and resumes sampling');
  // Main to mini volume synchronization after the reverse direction.
  await range(c, '[aria-label="播放控制"] input[aria-label="音量"]', 0.43);
  const mainVolume = (await snapshot(c)).player.volume; await act(c, { type: 'setWindowMode', mode: 'mini' });
  await click(m, '[data-volume-entry]'); assert.ok(Math.abs(await evaluate(m, '+document.querySelector("[data-volume-panel] input").value') - mainVolume) < 0.01);
  await act(m, { type: 'setWindowMode', mode: 'full' }, 'mini'); checks.push('main to mini volume synchronization works as well');
} catch (e) { error = e; if (pages.main) { await shot(pages.main, 'failure-main').catch(() => {}); await writeFile(path.join(output, 'failure-dom.json'), JSON.stringify(await evaluate(pages.main, '({text:document.body.innerText,buttons:[...document.querySelectorAll("button")].map(e=>e.getAttribute("aria-label")),reads:window.__stageReads})').catch(() => null), null, 2)); } if (pages.mini) await shot(pages.mini, 'failure-mini').catch(() => {}); }
finally {
  for (const c of Object.values(pages)) c.socket.close(); await writeFile(report.replace(/\.json$/, '.stop'), 'finish isolated stage check');
  const timer = setTimeout(() => child.kill(), 10000), code = await done; clearTimeout(timer);
  if (!error && code !== 0) error = Error('Native child exit ' + code);
  await writeFile(path.join(output, 'native.log'), logs);
  await writeFile(path.join(output, 'RESULT.json'), JSON.stringify({ passed: !error, exitCode: code, streaming, realAudio: true, syntheticFixture: true, checks, signals, layouts, lightStates, error: error?.stack }, null, 2));
  console.log(JSON.stringify({ output, passed: !error, streaming, checks, error: error?.message }));
}
if (error) throw error;

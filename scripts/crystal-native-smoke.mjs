import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { openLocalStore } from '../src/local/store.ts';
import { createDemoData } from '../src/mock/fixtures.ts';

// Actual WebView2 and native main/mini windows, isolated collection. Complex frames
// are read-only PlayerUI fixtures; pointer presses never invoke playback or a save.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.cache', 'crystal-native-' + Date.now());
await mkdir(output);
const directory = path.join(output, 'data'), nativeReport = path.join(output, 'native.json');
const store = await openLocalStore(directory), demo = createDemoData();
try {
  assert.equal(store.read().settings.accentColor, '#DB7A3D');
  assert.equal(store.read().settings.ui.main.materialTheme, 'charcoal');
  await store.transact(data => { data.library = demo.library; data.lyricsByTrack = demo.lyricsByTrack; });
} finally { await store.close(); }
const digest = async () => createHash('sha256').update(await readFile(path.join(directory, 'library.json'))).digest('hex');
const before = await digest();
const listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const child = spawn(path.join(root, 'src-tauri/target/debug/cd-player-desktop.exe'),
  ['--smoke-data', directory, '--smoke-report', nativeReport, '--smoke-manual'],
  { cwd: root, windowsHide: true, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const completed = new Promise((r, j) => { child.once('exit', r); child.once('error', j); });
const delay = ms => new Promise(r => setTimeout(r, ms));
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url), pending = new Map(); let seq = 0;
    socket.addEventListener('error', reject, { once: true });
    socket.addEventListener('message', event => {
      const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
    socket.addEventListener('open', () => resolve({ socket, send(method, params = {}) {
      return new Promise((r, j) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); j(Error(method + ' timeout')); }, 15000);
        pending.set(id, { resolve: r, reject: j, timer }); socket.send(JSON.stringify({ id, method, params })); });
    } }));
  });
}
const evaluate = async (c, expression) => {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .catch(e => { throw Error(e.message + ': ' + expression.slice(0, 140)); });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
};
async function until(c, expression) {
  for (let n = 0; n < 70; n++) { const r = await evaluate(c, expression); if (r) return r; await delay(150); }
  throw Error(expression);
}
const act = (c, action, surface = 'main') => evaluate(c, `(async()=>{const i=window.__TAURI_INTERNALS__.invoke,n=await i('clock_sample');return i('dispatch_action',{surface:${JSON.stringify(surface)},deadlineMs:n+4500,action:${JSON.stringify(action)}});})()`);
const pages = {}, shots = [], interactions = [];
const edgeSamples = [];
const nativeWidthSamples = [];
async function shot(c, name) {
  await evaluate(c, 'document.fonts.ready.then(()=>true)'); await delay(250);
  const data = await c.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, name + '.png'), Buffer.from(data.data, 'base64')); shots.push(name);
}
const button = `[...document.querySelectorAll(window.qaButtonSelector??'.cdp-play:not(:disabled)')].find(e=>{const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e===h||e.contains(h);})`;
async function inspect(c) {
  return evaluate(c, `(()=>{const e=${button},r=document.querySelector('.cdp'),s=getComputedStyle(e),p=getComputedStyle(e,'::before'),g=getComputedStyle(e.querySelector('svg'));return {
    theme:r.dataset.theme,surface:r.dataset.surface,solid:r.dataset.solid==='true',accent:getComputedStyle(r).getPropertyValue('--accent'),
    fill:getComputedStyle(r).getPropertyValue('--crystal-tint'),alpha:getComputedStyle(r).getPropertyValue('--crystal-alpha'),
    color:s.color,background:s.backgroundImage,filter:s.backdropFilter,scale:s.scale,translate:s.translate,shadow:s.boxShadow,
    ring:p.backgroundImage,ringPadding:p.padding,glyphFilter:g.filter,forced:matchMedia('(forced-colors: active)').matches};})()`);
}
async function interaction(c, name) {
  await until(c, `!!(${button})`);
  await evaluate(c, `(${button}).scrollIntoView({block:'nearest'})`); await delay(100);
  const p = await evaluate(c, `(()=>{const e=${button},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,reachable:e===h||e.contains(h)};})()`);
  assert.ok(p.reachable, name + ' occluded');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); await delay(160);
  const rest = await inspect(c);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await delay(160);
  const hover = await inspect(c); await shot(c, name + '-hover');
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await delay(160);
  const press = await inspect(c); await shot(c, name + '-press');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await evaluate(c, `(()=>{const e=${button};e.focus();})()`);
  // Shift+Tab then Tab reaches the target through actual keyboard navigation.
  for (const modifiers of [8, 0]) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
  }
  const focus = await evaluate(c, `(()=>{const e=${button};return {target:document.activeElement===e,visible:e.matches(':focus-visible'),outline:getComputedStyle(e).outlineStyle};})()`);
  assert.ok(focus.target && focus.visible && focus.outline !== 'none', name + ' keyboard focus missing');
  await shot(c, name + '-focus'); assert.notEqual(press.translate, rest.translate, name + ' pressed appearance unchanged');
  interactions.push({ name, ...p, rest, hover, press, focus });
}
let report, error;
try {
  for (let n = 0; n < 80 && !(pages.main && pages.mini); n++) {
    try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const t of targets.filter(t => t.type === 'page')) {
        const c = await connect(t.webSocketDebuggerUrl), s = await evaluate(c, `document.querySelector('.cdp')?.dataset.surface`);
        if (['main', 'mini'].includes(s) && !pages[s]) pages[s] = c; else c.socket.close();
      }
    } catch {} if (!(pages.main && pages.mini)) await delay(150);
  }
  assert.ok(pages.main && pages.mini, 'Native surfaces unavailable');
  const first = await evaluate(pages.main, `window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot)`);
  assert.equal(first.settings.accentColor, '#DB7A3D'); assert.equal(first.settings.ui.main.materialTheme, 'charcoal');
  await until(pages.main, `document.querySelector('.cdp').dataset.theme==='charcoal'`); await shot(pages.main, 'production-new-collection');
  const hosts = {};
  hosts.main = first.host;
  assert.ok((await act(pages.main, { type: 'setWindowMode', mode: 'mini' })).ok);
  hosts.mini = await evaluate(pages.mini, `window.__TAURI_INTERNALS__.invoke('request_snapshot').then(r=>r.snapshot.host)`);
  const source = `import React from 'react';import {createRoot} from 'react-dom/client';import {PlayerUI} from './src/ui/PlayerUI.tsx';
    import {UIBootContext} from './src/ui/lib/env.ts';import {SCENARIOS,withTheme} from './preview/scenarios.ts';
    const h=document.createElement('div');document.body.replaceChildren(h);const root=createRoot(h);let seq=0;window.qaActions=[];
    window.qaRender=(id,theme,intensity,accent,host,motion='reduced')=>{const s=SCENARIOS.find(s=>s.id===id);if(!s)throw Error(id);
      const snapshot=withTheme(s.build(),theme);snapshot.host={...snapshot.host,...host,surfaceVisible:true,coreStatus:'ready'};
      snapshot.settings={...snapshot.settings,accentColor:accent,glassIntensity:intensity,motion};
      root.render(React.createElement(UIBootContext.Provider,{value:s.boot??{}},React.createElement(PlayerUI,{key:++seq,snapshot,surface:s.surface??'main',onAction:async a=>{window.qaActions.push(a.type);return {ok:true,status:'cancelled'};}})));return true;};`;
  const built = await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'readonly-native-crystal.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false, outdir: output, loader: { '.woff2': 'dataurl' }, minify: true });
  const js = built.outputFiles.find(f => f.path.endsWith('.js')).text;
  const css = 'html,body{margin:0;width:100%;height:100%;overflow:hidden;}body>div{height:100%;}' + built.outputFiles.find(f => f.path.endsWith('.css')).text;
  for (const s of ['mini', 'main']) {
    if (s === 'main') assert.ok((await act(pages.mini, { type: 'setWindowMode', mode: 'full' }, 'mini')).ok);
    const c = pages[s];
    await evaluate(c, `document.head.querySelectorAll('link[rel="stylesheet"],style').forEach(e=>e.remove());document.head.append(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(css)}}));`);
    await evaluate(c, js);
  }
  async function render(s, id, theme, intensity, accent = '#DB7A3D', motion = 'reduced') {
    await evaluate(pages[s], `window.qaButtonSelector=${JSON.stringify(id === 'memorial-capsule' ? '.glass--frost-see .cdp-play:not(:disabled)' : '.cdp-play:not(:disabled)')}`);
    await evaluate(pages[s], `window.qaRender(${JSON.stringify(id)},${JSON.stringify(theme)},${intensity},${JSON.stringify(accent)},${JSON.stringify(hosts[s])},${JSON.stringify(motion)})`);
    await until(pages[s], `document.querySelector('.cdp')?.dataset.theme===${JSON.stringify(theme)}&&!!(${button})`); await delay(120);
  }
  for (const id of ['memorial-library', 'memorial-np', 'memorial-capsule']) {
    await render('main', id, 'charcoal', .65); await interaction(pages.main, id);
  }
  if (process.argv.includes('--edges')) {
    // Read-only renderer diagnosis: put the same stage button on integer and fractional
    // coordinates, then exercise the pointer states at several emulated device scales.
    const c = pages.main;
    for (const scale of [1, 1.25, 1.5, 2]) for (const offset of [0, 0.25]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: scale, mobile: false });
      await render('main', 'memorial-library', 'charcoal', .65);
      await evaluate(c, `(${button}).parentElement.style.transform=${JSON.stringify(offset ? `translateX(${offset}px)` : '')}`);
      const p = await evaluate(c, `(()=>{const e=${button},r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const state of ['rest', 'hover', 'press']) {
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: state === 'rest' ? 2 : p.x, y: state === 'rest' ? 2 : p.y });
        if (state === 'press') await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await delay(200);
        const sample = await evaluate(c, `(()=>{const e=${button},r=e.getBoundingClientRect(),s=getComputedStyle(e);let parents=[];
          for(let p=e.parentElement;p&&parents.length<6;p=p.parentElement){const t=getComputedStyle(p);parents.push({tag:p.tagName,class:p.className,overflow:t.overflow,filter:t.filter,backdrop:t.backdropFilter,transform:t.transform});}
          return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},deviceScale:devicePixelRatio,filter:s.backdropFilter,
            before:{mask:getComputedStyle(e,'::before').mask,borderRadius:getComputedStyle(e,'::before').borderRadius,padding:getComputedStyle(e,'::before').padding},parents};})()`);
        const name = `edge-${scale}-${offset}-${state}`, r = sample.rect;
        const data = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x-6, y: r.y-6, width: 244, height: r.height+18, scale: 1 } });
        await writeFile(path.join(output, name+'.png'), Buffer.from(data.data, 'base64'));
        edgeSamples.push({ name, scale, offset, state, ...sample });
        if (state === 'press') await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      }
    }
    await c.send('Emulation.clearDeviceMetricsOverride');
  }
  if (process.argv.includes('--native-widths')) {
    // Resize only our owned debug child through Win32. These widths are actual
    // native client sizes, unlike the CDP device-scale sweep above.
    const c = pages.main, runFile = promisify(execFile);
    const actualScale = await evaluate(c, 'devicePixelRatio');
    async function resize(width) {
      // This process-local flag permits our checked-in helper on machines whose
      // default script policy is Restricted; it changes no system policy.
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(root, 'scripts/resize-smoke-window.ps1'), '-TargetProcessId', String(child.pid),
        '-ClientWidth', String(Math.round(width * actualScale)), '-ClientHeight', String(Math.round(800 * actualScale))],
        { windowsHide: true, timeout: 30000 });
      await until(c, `Math.abs(innerWidth-${width})<=2`);
    }
    for (const width of [960, 1100, 1280]) {
      await resize(width);
      for (const [label, accent] of [['memorial', '#DB7A3D'], ['example-beige', '#B8875A']]) {
        await render('main', 'memorial-library', 'charcoal', .65, accent, 'full');
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
        const center = await evaluate(c, `(()=>{const e=${button},r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        for (const state of ['rest', 'hover', 'press', 'hover-out']) {
          if (state === 'hover') await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...center });
          if (state === 'press') await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...center, button: 'left', clickCount: 1 });
          if (state === 'hover-out') {
            await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...center, button: 'left', clickCount: 1 });
            await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
          }
          const started = performance.now();
          await delay(state === 'hover-out' ? 75 : 240);
          const sample = await evaluate(c, `(()=>{const e=${button},r=e.getBoundingClientRect(),s=getComputedStyle(e);
            const rimPoints=[[r.x+3,r.y+r.height/2],[r.right-3,r.y+r.height/2],[r.x+r.width/2,r.y+3],[r.x+r.width/2,r.bottom-3]];
            return {viewport:{width:innerWidth,height:innerHeight},devicePixelRatio,
              rect:{x:r.x,y:r.y,width:r.width,height:r.height},transition:s.transition,
              hover:e.matches(':hover'),active:e.matches(':active'),backdrop:s.backdropFilter,
              wall:getComputedStyle(e,'::before').backgroundImage,
              rimReachable:rimPoints.map(([x,y])=>{const hit=document.elementFromPoint(x,y);return hit===e||e.contains(hit);})};})()`);
          assert.ok(sample.rimReachable.every(Boolean), `${width}/${label}/${state}: edge covered by another element`);
          assert.equal(sample.devicePixelRatio, actualScale);
          const name = `native-width-${width}-${label}-${state}`, r = sample.rect;
          const data = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x-6, y: r.y-6, width: 244, height: r.height+18, scale: 2 } });
          await writeFile(path.join(output, name+'.png'), Buffer.from(data.data, 'base64'));
          nativeWidthSamples.push({ name, requestedWidth: width, accent, state, elapsedAfterInputMs: performance.now()-started, ...sample });
        }
      }
    }
    await resize(1280);
  }
  const variants = [];
  for (const theme of ['charcoal', 'light', 'blue']) for (const intensity of [.65, 1, 0]) {
    await render('main', 'memorial-np', theme, intensity); const state = await inspect(pages.main);
    assert.equal(state.solid, intensity === 0); if (intensity === 0) assert.equal(state.filter, 'none');
    else assert.match(state.filter, /contrast/);
    const name = 'np-' + theme + '-' + intensity; await shot(pages.main, name); variants.push({ name, ...state });
  }
  await render('main', 'memorial-np', 'light', .65, '#9170CF'); const custom = await inspect(pages.main);
  assert.equal(custom.accent.trim(), '#9170CF');
  assert.notEqual(custom.background, variants.find(v => v.name === 'np-light-0.65').background); await interaction(pages.main, 'custom-purple-light');
  await pages.main.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  const forced = await inspect(pages.main); assert.ok(forced.forced); assert.equal(forced.filter, 'none');
  await shot(pages.main, 'forced-colors-emulation'); await pages.main.send('Emulation.setEmulatedMedia', { features: [] });
  assert.ok((await act(pages.main, { type: 'setWindowMode', mode: 'mini' })).ok);
  await render('mini', 'memorial-mini', 'charcoal', .65); await interaction(pages.mini, 'mini-memorial');
  for (const intensity of [1, 0]) { await render('mini', 'memorial-mini-paused', 'charcoal', intensity); const state = await inspect(pages.mini);
    assert.equal(state.solid, intensity === 0); if (intensity === 0) assert.equal(state.filter, 'none');
    await shot(pages.mini, 'mini-' + intensity); variants.push({ name: 'mini-' + intensity, ...state }); }
  for (const c of Object.values(pages)) {
    const actions = await evaluate(c, 'window.qaActions'); assert.ok(actions.every(a => ['togglePlayback', 'reportUnsavedChanges'].includes(a)), actions.join(','));
  }
  assert.equal(await digest(), before);
  report = { passed: true, version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
    actualWebView2: true, productionNewDefaults: { theme: first.settings.ui.main.materialTheme, accent: first.settings.accentColor },
    hosts, shots, interactions, edgeSamples, nativeWidthSamples, variants, custom, forcedColorsEmulation: forced, noCollectionWrite: true,
    noDefaultUserData: true, noAudio: true, noNetwork: true,
    limits: ['Complex button frames use read-only synthetic snapshots rendered in actual native main/mini WebView2',
      'Forced colors are CDP emulation; Windows system high-contrast theme still requires human review',
      'Computed styles/screenshots verify rendering and interaction, not exhaustive per-pixel contrast or long-term GPU load'] };
} catch (e) { error = e; await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(e), stack: e.stack }, null, 2)); }
finally {
  Object.values(pages).forEach(c => c.socket.close()); await writeFile(nativeReport.replace(/\.json$/, '.stop'), 'finish isolated crystal check');
  const exit = await completed; await writeFile(path.join(output, 'native.log'), logs);
  if (!error) { assert.equal(exit, 0); assert.ok(JSON.parse(await readFile(nativeReport, 'utf8')).passed); }
}
if (error) throw error;
assert.equal(await digest(), before); const reopened = await openLocalStore(directory); await reopened.close(); report.storeReopened = true;
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, passed: true, shots: shots.length, pointerAndKeyboardChecks: interactions.length }));

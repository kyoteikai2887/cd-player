/**
 * V1.2 (Claude): the stage's music field and star trails, and the mini card's volume.
 *
 * The field reads only the real signal port (contract 0.6.0) in its own visible-only loop: at most
 * ~24 reads a second while sounding, 4 while quiet, none without a source, while hidden, off
 * screen, with the page hidden or after unmount; nothing else renders while it runs. Its
 * arithmetic (lib/stageViz.ts) clears a song's remains on a change of track and rests on silence.
 * Round 2: the cold light is tests/ui/stage-light.test.tsx; the real layout (the field's size and
 * place at every window size) is tests/ui/stage-layout.browser.mjs.
 */
import React, { Profiler, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ActionResult, AudioVisualizationFrame, AudioVisualizationSource, PlayerBridge, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import {
  audioVisualizationPatch, createVizState, edgeWeight, EDGES, FIELD, FIELD_MAX_W, FIELD_MIN_W, fieldWidth, litCells, resetViz,
  showAudioVisualization, stepViz, TOKENS,
} from '../../src/ui/lib/stageViz.ts';
import { makeTrails } from '../../src/ui/components/StarTrails.tsx';

/* ── A controllable animation clock ─────────────────────────────── */
let callbacks = new Map<number, FrameRequestCallback>();
let nextId = 1, clock = 0, requested = 0;
beforeEach(() => {
  callbacks = new Map(); nextId = 1; clock = 1000; requested = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; callbacks.set(id, cb); requested++; return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
/** Runs the animation clock at 60 frames a second for `ms` (and the timers with it, where a test fakes them). */
function advance(ms: number) {
  const end = clock + ms;
  act(() => {
    while (clock < end) {
      const before = Math.floor(clock);
      clock += 1000 / 60;
      if (vi.isFakeTimers()) vi.advanceTimersByTime(Math.floor(clock) - before);
      const due = [...callbacks.values()]; callbacks.clear();
      for (const cb of due) cb(clock);
    }
  });
}

/* ── Signal fixtures (test-only; production reads the real analyser) ── */
const bands = (fn: (i: number) => number) => Array.from({ length: TOKENS }, (_, i) => fn(i));
const live = (trackId: string, level = 0.8, shape: (i: number) => number = () => 0.9): AudioVisualizationFrame =>
  ({ status: 'live', source: 'audio', trackId, rms: 0.3, peak: 0.5, level, bands: bands(shape) });
const idle = (trackId: string | null): AudioVisualizationFrame =>
  ({ status: 'idle', source: 'audio', trackId, rms: 0, peak: 0, level: 0, bands: bands(() => 0) });
function counting(frame: () => AudioVisualizationFrame) {
  const source = { reads: 0, read() { source.reads++; return frame(); } };
  return source as AudioVisualizationSource & { reads: number };
}

describe('field arithmetic', () => {
  test('silence rests; a live frame rises; release is gradual; a held peak falls after its hold', () => {
    const s = createVizState();
    expect(stepViz(s, idle('a'), 42)).toBe(false);
    expect([...s.value].every(v => v === 0)).toBe(true);
    stepViz(s, live('a'), 42);
    const risen = s.value[5];
    expect(risen).toBeGreaterThan(0.4);
    stepViz(s, idle('a'), 42);
    expect(s.value[5]).toBeLessThan(risen);
    expect(s.value[5]).toBeGreaterThan(0);        // falls, does not snap off
    expect(s.peak[5]).toBeCloseTo(risen, 5);      // the peak holds for a moment
    for (let i = 0; i < 40; i++) stepViz(s, idle('a'), 42);
    expect(s.value[5]).toBe(0);
    expect(s.peak[5]).toBe(0);
    expect(stepViz(s, idle('a'), 42)).toBe(false);
  });

  test('a new track clears the previous song before anything is shown', () => {
    const s = createVizState();
    for (let i = 0; i < 4; i++) stepViz(s, live('a'), 42);
    expect(s.value[3]).toBeGreaterThan(0.5);
    stepViz(s, idle('b'), 42);
    expect(s.trackId).toBe('b');
    expect([...s.value, ...s.peak].every(v => v === 0)).toBe(true);
  });

  test('unavailable and missing frames are silence; reduced motion is smaller', () => {
    const s = createVizState();
    stepViz(s, { ...live('a'), status: 'unavailable' }, 42);
    expect(s.value[0]).toBe(0);
    stepViz(s, null, 42);
    expect(s.value[0]).toBe(0);
    const full = createVizState(), reduced = createVizState();
    for (let i = 0; i < 6; i++) { stepViz(full, live('a'), 250); stepViz(reduced, live('a'), 250, true); }
    expect(reduced.value[4]).toBeLessThanOrEqual(0.6 + 1e-6);
    expect(reduced.value[4]).toBeLessThan(full.value[4]);
  });

  test('an arc lights only when both of its tokens sound, and never at full strength', () => {
    const s = createVizState();
    for (let i = 0; i < 6; i++) stepViz(s, live('a', 1, i => (i < 12 ? 0.95 : 0)), 42);
    const inside = EDGES.find(([a, b]) => b < 12)!, across = EDGES.find(([a, b]) => a < 12 && b >= 12)!;
    expect(edgeWeight(s, inside[0], inside[1])).toBeGreaterThan(0.3);
    expect(edgeWeight(s, inside[0], inside[1])).toBeLessThanOrEqual(0.8);
    expect(edgeWeight(s, across[0], across[1])).toBe(0);
    resetViz(s);
    expect(edgeWeight(s, inside[0], inside[1])).toBe(0);
  });

  test('cells, width and the one setting', () => {
    expect(litCells(0)).toBe(0);
    expect(litCells(0.05)).toBe(1);
    expect(litCells(1)).toBe(FIELD.cells);
    expect(fieldWidth(0, 0)).toBe(FIELD.w);
    expect(fieldWidth(2000, 168)).toBe(FIELD_MAX_W);
    expect(fieldWidth(100, 168)).toBe(FIELD_MIN_W);
    // Round 2: in between, the drawing takes its box's proportions (in steps of 8), so it fills the
    // box's height: a box a little narrower than the full drawing narrows the drawing, not its scale.
    for (const [w, h] of [[288, 184], [300, 200], [264, 170], [320, 188]]) {
      const vw = fieldWidth(w, h);
      expect(vw % 8).toBe(0);
      expect(Math.abs(vw / FIELD.h - w / h)).toBeLessThanOrEqual(8 / FIELD.h);
    }
    for (let w = 100; w < 2000; w += 7) expect(fieldWidth(w + 7, 184)).toBeGreaterThanOrEqual(fieldWidth(w, 184));
    expect(showAudioVisualization({ ui: { main: {}, mini: {} } })).toBe(true);
    expect(showAudioVisualization({ ui: { main: { audioVisualization: false }, mini: {} } })).toBe(false);
    expect(audioVisualizationPatch(false)).toEqual({ ui: { main: { audioVisualization: false } } });
  });
});

/* ── The stage ─────────────────────────────────────────────────── */
async function playingSnapshot(patch: (s: UISnapshot) => UISnapshot = s => s): Promise<UISnapshot> {
  const session = createMockSession({ autoTick: false });
  const bridge = session.connect('main');
  await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
  const snapshot = bridge.getSnapshot();
  session.destroy();
  return patch(snapshot);
}
const onAction = async (_a: UIAction): Promise<ActionResult> => ({ ok: true, status: 'applied' });
function stage(snapshot: UISnapshot, visualization?: AudioVisualizationSource, onRender?: () => void) {
  const ui = <PlayerUI snapshot={snapshot} surface="main" onAction={onAction} visualization={visualization} />;
  return render(<UIBootContext.Provider value={{}}>{onRender ? <Profiler id="ui" onRender={onRender}>{ui}</Profiler> : ui}</UIBootContext.Provider>);
}
const fieldOff = (s: UISnapshot): UISnapshot => ({ ...s, settings: { ...s.settings, ui: { ...s.settings.ui, main: { ...s.settings.ui.main, audioVisualization: false } } } });
const field = () => document.querySelector<SVGSVGElement>('[data-stage-viz] svg');
const columns = () => [...document.querySelectorAll<SVGLineElement>('[data-stage-viz] svg line[stroke-dasharray]')];
const lit = () => columns().filter(l => Number(l.getAttribute('y2')) < FIELD.baseline).length;

describe('music field on the stage', () => {
  test('etched in full, lit by the signal, read at most ~24 times a second', async () => {
    const snapshot = await playingSnapshot();
    const source = counting(() => live(snapshot.player.currentTrackId!));
    stage(snapshot, source);
    expect(field()).not.toBeNull();
    expect(field()!.getAttribute('aria-hidden')).toBe('true');
    expect(columns()).toHaveLength(TOKENS);
    advance(1000);
    expect(source.reads).toBeGreaterThanOrEqual(18);
    expect(source.reads).toBeLessThanOrEqual(25);
    expect(field()!.dataset.state).toBe('live');
    expect(lit()).toBe(TOKENS);
  });

  test('nothing else renders while the field runs', async () => {
    const snapshot = await playingSnapshot();
    let commits = 0;
    stage(snapshot, counting(() => live(snapshot.player.currentTrackId!)), () => { commits++; });
    advance(100);
    const before = commits;
    advance(1000);
    expect(commits).toBe(before);
  });

  test('quiet music is read 4 times a second, asking for a frame only to read; it shows only the etching', async () => {
    const snapshot = await playingSnapshot();
    const off = await playingSnapshot(fieldOff);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The frames the rest of the page asks for on its own (the progress line), for comparison.
    const without = stage(off, undefined);
    advance(200);
    let from = requested;
    advance(1000);
    const others = requested - from;
    without.unmount();
    const source = counting(() => idle(snapshot.player.currentTrackId));
    stage(snapshot, source);
    advance(200);
    const reads = source.reads;
    from = requested;
    advance(1000);
    expect(source.reads - reads).toBeGreaterThanOrEqual(3);
    expect(source.reads - reads).toBeLessThanOrEqual(5);
    // Round 2: between reads it waits on a timer, so a paused stage asks for a frame or two per read, not sixty a second.
    expect(requested - from - others).toBeLessThanOrEqual(10);
    expect(lit()).toBe(0);
    expect(field()!.dataset.state).toBe('idle');
  });

  test('without a source there is no loop at all; the etching stays', async () => {
    // Other parts of the page (the progress line) have their own frames: compare with no field at all.
    const off = await playingSnapshot(fieldOff);
    const without = stage(off, undefined);
    const baseline = callbacks.size;
    without.unmount(); callbacks.clear();
    stage(await playingSnapshot(), undefined);
    expect(callbacks.size).toBe(baseline);
    advance(500);
    expect(field()!.dataset.state).toBe('unavailable');
    expect(document.querySelectorAll('[data-stage-viz] svg path').length).toBeGreaterThan(EDGES.length);
  });

  test('a hidden window never reads', async () => {
    const snapshot = await playingSnapshot(s => ({ ...s, host: { ...s.host, surfaceVisible: false } }));
    const source = counting(() => live(snapshot.player.currentTrackId!));
    stage(snapshot, source);
    advance(1000);
    expect(source.reads).toBe(0);
  });

  test('off screen it stops; back on screen it starts clean', async () => {
    // Every observer and what it watches (the stage's light has one of its own).
    const observers: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      rec = { cb: (() => {}) as IntersectionObserverCallback, targets: [] as Element[] };
      constructor(cb: IntersectionObserverCallback) { this.rec.cb = cb; observers.push(this.rec); }
      observe(el: Element) { this.rec.targets.push(el); }
      disconnect() { this.rec.targets = []; }
    });
    const intersect = (el: Element, isIntersecting: boolean) => act(() => {
      for (const o of observers) if (o.targets.includes(el)) o.cb([{ isIntersecting, target: el } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    const snapshot = await playingSnapshot();
    const source = counting(() => live(snapshot.player.currentTrackId!));
    stage(snapshot, source);
    advance(300);
    expect(lit()).toBe(TOKENS);
    intersect(field()!, false);
    expect(lit()).toBe(0);
    const reads = source.reads;
    advance(1000);
    expect(source.reads).toBe(reads);
    intersect(field()!, true);
    advance(200);
    expect(source.reads).toBeGreaterThan(reads);
  });

  test('a hidden page stops reading; unmounting stops for good', async () => {
    const snapshot = await playingSnapshot();
    const source = counting(() => live(snapshot.player.currentTrackId!));
    const view = stage(snapshot, source);
    advance(200);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    let reads = source.reads;
    advance(1000);
    expect(source.reads).toBe(reads);
    expect(lit()).toBe(0);
    hidden.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    advance(200);
    expect(source.reads).toBeGreaterThan(reads);
    view.unmount();
    reads = source.reads;
    advance(1000);
    expect(source.reads).toBe(reads);
    expect(callbacks.size).toBe(0);
    hidden.mockRestore();
  });

  test('a change of track clears the previous song at once', async () => {
    const snapshot = await playingSnapshot();
    let frame = live('track-a');
    stage(snapshot, counting(() => frame));
    advance(300);
    expect(lit()).toBe(TOKENS);
    frame = idle('track-b');
    advance(60);
    expect(lit()).toBe(0);
  });

  test('switched off in settings: no field, no loop; trails and light stay', async () => {
    const snapshot = await playingSnapshot(s => ({ ...s, settings: { ...s.settings, ui: { ...s.settings.ui, main: { ...s.settings.ui.main, audioVisualization: false } } } }));
    const source = counting(() => live(snapshot.player.currentTrackId!));
    stage(snapshot, source);
    advance(500);
    expect(field()).toBeNull();
    expect(source.reads).toBe(0);
    expect(document.querySelector('[data-etch="star-trails"]')).not.toBeNull();
    expect(document.querySelector('[data-ambient="stage"]')).not.toBeNull();
  });

});

describe('star trails', () => {
  test('the same sky every time, cut once as four still paths', async () => {
    expect(makeTrails()).toEqual(makeTrails());
    expect(makeTrails().length).toBeGreaterThan(80);
    stage(await playingSnapshot());
    const sky = document.querySelector('[data-etch="star-trails"]')!;
    expect(sky.getAttribute('aria-hidden')).toBe('true');
    expect(sky.querySelectorAll('path')).toHaveLength(4);
    expect(sky.querySelector('animate, animateTransform')).toBeNull();
  });
});

/* ── Settings ──────────────────────────────────────────────────── */
describe('settings', () => {
  test('one switch for the music field, stored in ui.main', async () => {
    const snapshot = await playingSnapshot();
    const sent: UIAction[] = [];
    render(<UIBootContext.Provider value={{ overlay: 'settings' }}>
      <PlayerUI snapshot={snapshot} surface="main" onAction={async a => { sent.push(a); return { ok: true, status: 'applied' }; }} />
    </UIBootContext.Provider>);
    const sw = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="主舞台音乐图案"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => { sw.click(); });
    expect(sent).toContainEqual({ type: 'updateSettings', patch: { ui: { main: { audioVisualization: false } } } });
  });
});

/* ── CSS rules ─────────────────────────────────────────────────── */
const read = (p: string) => readFileSync(p, 'utf8');
describe('stage decoration rules', () => {
  const css = read('src/ui/views/Spotlight.module.css');
  test('high contrast hides trails, field and light; the compact stage drops the etching and its cut', () => {
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('.sky, .viz, .flow { display: none; }');
    const compact = css.slice(css.indexOf('@container (width < 1100px) or (height < 720px)'));
    expect(compact).toContain('.etch { display: none; }');
    expect(compact).toContain('mask-size: 100% 100%, 0 0;');
    expect(read('src/ui/components/AttentionField.module.css')).toContain('@media (forced-colors: active) { .field { display: none; } }');
    expect(read('src/ui/components/StarTrails.module.css')).toContain('@media (forced-colors: active) { .sky { display: none; } }');
  });
});

/* ── Mini volume ───────────────────────────────────────────────── */
function Mini({ bridge, log }: { bridge: PlayerBridge; log: UIAction[] }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  return <PlayerUI snapshot={snapshot} surface="mini" onAction={a => { log.push(a); return bridge.dispatch(a); }} />;
}
async function mini({ lyrics = false } = {}) {
  vi.unstubAllGlobals();   // the mini card uses no animation clock here
  const session = createMockSession({ autoTick: false });
  const main = session.connect('main'), bridge = session.connect('mini');
  await act(async () => {
    await main.dispatch({ type: 'playAlbum', albumId: 'album-blue' });
    await main.dispatch({ type: 'setWindowMode', mode: 'mini' });
    if (lyrics) await main.dispatch({ type: 'updateSettings', patch: { miniShowLyrics: true } });
  });
  const log: UIAction[] = [];
  render(<UIBootContext.Provider value={{}}><Mini bridge={bridge} log={log} /></UIBootContext.Provider>);
  const entry = () => document.querySelector<HTMLButtonElement>('[data-volume-entry]')!;
  const panel = () => document.querySelector<HTMLElement>('[data-volume-panel]');
  const slider = () => panel()!.querySelector<HTMLInputElement>('input[type="range"]')!;
  return { session, main, bridge, log, entry, panel, slider };
}

describe('mini volume', () => {
  test('folded by default; opens in the card with the slider focused; Escape folds it and returns focus', async () => {
    const { session, entry, panel, slider } = await mini();
    try {
      expect(entry().getAttribute('aria-expanded')).toBe('false');
      expect(panel()).toBeNull();
      await act(async () => { entry().click(); });
      expect(entry().getAttribute('aria-expanded')).toBe('true');
      expect(entry().getAttribute('aria-controls')).toBe(panel()!.id);
      expect(document.activeElement).toBe(slider());
      expect(slider().getAttribute('aria-label')).toBe('音量');
      expect(slider().getAttribute('aria-valuetext')).toMatch(/^\d+%$/);
      // The title and transport step aside (not focusable) while the panel is open.
      expect(document.querySelector('[data-volume="open"]')).not.toBeNull();
      await act(async () => { slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(panel()).toBeNull();
      expect(entry().getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(entry());
    } finally { session.destroy(); }
  });

  test('the slider sets the one engine’s volume (throttled while dragging, final on release); mute is explicit; main follows', async () => {
    const { session, main, log, entry, slider } = await mini();
    try {
      await act(async () => { entry().click(); });
      const { fireEvent } = await import('@testing-library/react');
      await act(async () => {
        for (const v of [0.6, 0.55, 0.5, 0.45, 0.4]) fireEvent.change(slider(), { target: { value: String(v) } });
        fireEvent.pointerUp(slider(), { target: { value: '0.4' } });
      });
      const volumes = log.filter(a => a.type === 'setVolume');
      expect(volumes.length).toBeLessThanOrEqual(2);       // first change and the release
      expect(volumes.at(-1)).toEqual({ type: 'setVolume', volume: 0.4 });
      expect(main.getSnapshot().player.volume).toBeCloseTo(0.4, 5);
      const mute = document.querySelector<HTMLButtonElement>('[data-volume-panel] button[aria-label="静音"]')!;
      await act(async () => { mute.click(); });
      expect(log).toContainEqual({ type: 'setMuted', muted: true });
      expect(main.getSnapshot().player.muted).toBe(true);
      expect(entry().getAttribute('aria-label')).toBe('收起音量');
    } finally { session.destroy(); }
  });

  test('pressing, dragging or double-clicking in the panel never moves the window or opens the main one', async () => {
    const { session, log, entry, panel, slider } = await mini();
    try {
      const { fireEvent } = await import('@testing-library/react');
      await act(async () => { entry().click(); });
      fireEvent.pointerDown(panel()!, { button: 0, buttons: 1, clientX: 200, clientY: 50 });
      fireEvent.pointerMove(panel()!, { buttons: 1, clientX: 240, clientY: 60 });
      fireEvent.pointerDown(slider(), { button: 0, buttons: 1, clientX: 200, clientY: 50 });
      fireEvent.pointerMove(slider(), { buttons: 1, clientX: 260, clientY: 50 });
      fireEvent.doubleClick(slider());
      fireEvent.doubleClick(panel()!);
      expect(log.some(a => a.type === 'beginWindowDrag')).toBe(false);
      expect(log.some(a => a.type === 'setWindowMode')).toBe(false);
      expect(panel()).not.toBeNull();
    } finally { session.destroy(); }
  });

  test('a press elsewhere on the card folds it; the window buttons stay usable while it is open', async () => {
    const { session, log, entry, panel } = await mini({ lyrics: true });
    try {
      const { fireEvent } = await import('@testing-library/react');
      await act(async () => { entry().click(); });
      const pin = document.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-label="置顶"], [role="toolbar"] button[aria-label="取消置顶"]')!;
      await act(async () => { pin.click(); });
      expect(log.some(a => a.type === 'updateSettings')).toBe(true);
      const art = document.querySelector<HTMLElement>('[data-volume="open"]')!;
      fireEvent.pointerDown(art, { button: 0, buttons: 1, clientX: 30, clientY: 40 });
      expect(panel()).toBeNull();
    } finally { session.destroy(); }
  });
});

/**
 * V1.2 round 2 (Claude): the stage's cold light, starlight flowing in a few of the etched star
 * trails (lib/trailLight.ts, components/TrailLight.tsx).
 *
 * The arithmetic keeps every light on its own trail, in free glass and clear of everything the
 * stage marks to keep clear. The light is a CSS animation: it runs only while the music is heard,
 * holds when paused, buffering, muted or silent, is still with reduced motion, is paused while the
 * window, the page or the stage is hidden, and is not drawn at all in high contrast. Nothing
 * re-renders and no frame loop runs while it flows, and the etched sky under it is never redrawn.
 * The real layout (sizes, bounds, gaps, the light's paths) is checked in a browser by
 * tests/ui/stage-layout.browser.mjs.
 *
 * Star-trail fix: a light now belongs to a ring and shows in every free stretch of it (its
 * windows), so the clearances below are checked along every window, not only its longest stretch.
 * That every free stretch is crossed once a cycle is tests/ui/trail-coverage.test.tsx.
 *
 * Star-trail completion (round 4): the rings are chosen as before, but each light now shows
 * wherever its ring's trails are seen: out to the stage's own edge and through the soft cut round
 * the memorial etching, clear only of what stands in front of the trails (the text, the controls,
 * the cover, the music field: CLEAR; the memorial's figures and caption and the middle of its cut).
 * It turns one whole turn a cycle with a small glow on its head, and wears the sky's own mask.
 */
import React, { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ActionResult, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import { chooseLightArcs, CLEAR, GLOW, LIGHT_OPTIONS, lightClipPath, lightFlows, lightGlass, lightMeteor, lightOptionsForStage, lightPath, lightPhase,
  lightSchedule, METEOR_WIDTH, TRANSIT_MS } from '../../src/ui/lib/trailLight.ts';
import type { Box, Ellipse, KeepItem, LightArc, LightWindow, Point } from '../../src/ui/lib/trailLight.ts';
import { TRAILS, TRAILS_BOX } from '../../src/ui/components/StarTrails.tsx';

/* ── Geometry helpers ──────────────────────────────────────────── */
const inside = (p: Point, b: Box | Ellipse) => ('rx' in b
  ? ((p.x - b.cx) / b.rx) ** 2 + ((p.y - b.cy) / b.ry) ** 2 <= 1
  : p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
const grow = <B extends Box | Ellipse>(b: B, by: number): B => ('rx' in b
  ? { ...b, rx: b.rx + by, ry: b.ry + by }
  : { ...b, x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 });
/** Points along every stretch the light shows in, a degree apart, with both ends of each. */
function along(pole: Point, arc: { r: number; windows: readonly LightWindow[] }): Point[] {
  return arc.windows.flatMap(w => {
    const n = Math.max(2, Math.ceil((w.from - w.to) / (Math.PI / 180)));
    return Array.from({ length: n + 1 }, (_, k) => {
      const a = w.to + ((w.from - w.to) * k) / n;
      return { x: pole.x + arc.r * Math.cos(a), y: pole.y + arc.r * Math.sin(a) };
    });
  });
}
/** A light on one stretch alone (r large enough that any length fits well inside a turn). */
const single = (length: number, r = 1000): LightArc =>
  ({ index: 0, r, from: length / r, to: 0, length, start: length / r, end: 0, windows: [{ index: 0, from: length / r, to: 0, length }] });
/** The middle of the soft cut round the memorial etching (its box `m`), where none of the trails is seen. */
const cutMiddle = (m: Box): Ellipse => ({ cx: m.x + m.w / 2, cy: m.y + m.h / 2, rx: (m.w / 2 + 28) * 0.62, ry: (m.h / 2 + 22) * 0.62 });
/**
 * Round 4: every point the light shows in is on the stage (whose own rounded edge clips light and
 * trails alike), CLEAR from the text, the controls, the cover and the music field, and out of the
 * middle of the cut round the etching. (The figures themselves: tests/ui/trail-coverage.test.tsx.)
 */
function expectClear(arcs: readonly { r: number; windows: readonly LightWindow[] }[], pole: Point, stage: Box, items: readonly KeepItem[]) {
  const { content, memorial } = lightGlass(items, stage);
  for (const arc of arcs) {
    for (const p of along(pole, arc)) {
      expect(inside(p, grow(stage, 0.5))).toBe(true);
      for (const b of content) expect(inside(p, grow(b, CLEAR - 0.5))).toBe(false);
      if (memorial) expect(inside(p, grow(cutMiddle(memorial), -0.5))).toBe(false);
    }
  }
}

/*
 * A stage like the 1360×800 window's (1252×356): the music field ("before": for choosing the
 * rings, everything up to its right edge) and the memorial etching (for choosing, the oval cut round
 * it). The sky's pole is where the stylesheet puts it, over the etching.
 */
const STAGE: Box = { x: 0, y: 0, w: 1252, h: 356 };
const POLE: Point = { x: 1145, y: 85 };
const ETCH: Box = { x: 1075, y: 220, w: 141, h: 112 };
const CUT: Ellipse = { cx: ETCH.x + ETCH.w / 2, cy: ETCH.y + ETCH.h / 2, rx: ETCH.w / 2 + 28, ry: ETCH.h / 2 + 22 };
const FIELD: KeepItem = { kind: 'before', box: { x: 330, y: 170, w: 680, h: 160 } };
const KEEP: KeepItem[] = [FIELD, { kind: 'etch', box: ETCH }];

describe('cold light arithmetic', () => {
  test('every light runs on its own trail, inside the stage and clear of everything kept clear', () => {
    const arcs = chooseLightArcs(TRAILS, POLE, STAGE, KEEP);
    expect(arcs.length).toBeGreaterThanOrEqual(3);
    expect(arcs.length).toBeLessThanOrEqual(LIGHT_OPTIONS.count);
    for (const arc of arcs) {
      const trail = TRAILS[arc.index];
      expect(arc.r).toBe(trail.r);
      // Its main stretch is on that trail (the run may place it whole turns round: the same stretch).
      const main = trail.a0 + ((arc.from - trail.a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      expect(main).toBeLessThanOrEqual(trail.a1 + 1e-9);
      expect(main - (arc.from - arc.to)).toBeGreaterThanOrEqual(trail.a0 - 1e-9);
      expect(arc.from).toBeGreaterThan(arc.to);
      expect(arc.length).toBeCloseTo((arc.from - arc.to) * arc.r, 6);
      expect(arc.length).toBeGreaterThanOrEqual(LIGHT_OPTIONS.minLength);
      expect(arc.r).toBeGreaterThanOrEqual(LIGHT_OPTIONS.minRadius);
      // Every stretch it shows in is on a trail of its own ring.
      for (const w of arc.windows) {
        const t = TRAILS[w.index], from = t.a0 + ((w.from - t.a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        expect(t.r).toBe(arc.r);
        expect(w.from).toBeGreaterThan(w.to);
        expect(from).toBeLessThanOrEqual(t.a1 + 1e-9);
        expect(from - (w.from - w.to)).toBeGreaterThanOrEqual(t.a0 - 1e-9);
      }
    }
    expectClear(arcs, POLE, STAGE, KEEP);
  });

  test('separate rings, the first ones near the pole; the same choice every time', () => {
    const arcs = chooseLightArcs(TRAILS, POLE, STAGE, KEEP);
    expect(new Set(arcs.map(a => a.index)).size).toBe(arcs.length);
    for (const a of arcs) for (const b of arcs) {
      if (a === b) continue;
      expect(Math.abs(a.r - b.r)).toBeGreaterThanOrEqual(Math.max(LIGHT_OPTIONS.minGap, LIGHT_OPTIONS.gapRatio * Math.max(a.r, b.r)));
    }
    expect(arcs.some(a => a.r <= 120)).toBe(true);
    expect(arcs.map(a => a.r)).toEqual([...arcs.map(a => a.r)].sort((x, y) => x - y));
    expect(chooseLightArcs(TRAILS, POLE, STAGE, KEEP)).toEqual(arcs);
  });

  test('more free sky, more lights; text over the pole moves them; no free sky, none', () => {
    const medium = chooseLightArcs(TRAILS, POLE, STAGE, KEEP);
    // The 2560×1440 window's stage: the same pole corner, much more free sky to its left.
    const wideStage = { x: 0, y: 0, w: 1772, h: 356 }, widePole = { x: 1665, y: 85 };
    const wideKeep: KeepItem[] = [FIELD, { kind: 'etch', box: { ...ETCH, x: ETCH.x + 520 } }];
    const wide = chooseLightArcs(TRAILS, widePole, wideStage, wideKeep);
    expect(wide.length).toBe(lightOptionsForStage(wideStage).count);
    expect(wide.length).toBe(LIGHT_OPTIONS.count + 2);
    expect(wide.length).toBeGreaterThan(medium.length);
    expect(Math.max(...wide.map(a => a.r))).toBeGreaterThan(300);   // far trails light up too
    expectClear(wide, widePole, wideStage, wideKeep);
    // A long title reaching over the pole: the lights go round it, or there are fewer of them.
    const title: KeepItem = { kind: 'box', box: { x: 1000, y: 0, w: 180, h: 120 } };
    const covered = chooseLightArcs(TRAILS, POLE, STAGE, [...KEEP, title]);
    expect(covered).not.toEqual(medium);
    expectClear(covered, POLE, STAGE, [...KEEP, title]);
    expect(chooseLightArcs(TRAILS, POLE, STAGE, [{ kind: 'box', box: STAGE }])).toEqual([]);
    expect(chooseLightArcs(TRAILS, POLE, { x: 0, y: 0, w: 20, h: 20 }, [])).toEqual([]);
  });

  test('wide stages can use the existing outer rings without relaxing their clearances', () => {
    const outer = TRAILS.filter(t => t.r > LIGHT_OPTIONS.maxRadius);
    const stage = { x: 0, y: 0, w: 2800, h: 700 }, pole = { x: 1400, y: 350 };
    const arcs = chooseLightArcs(outer, pole, stage, []);
    expect(arcs.length).toBeGreaterThan(0);
    expect(arcs.every(a => a.r > 1000 && a.r <= 1240)).toBe(true);
    expectClear(arcs, pole, stage, []);
    expect(chooseLightArcs(outer, pole, stage, [], LIGHT_OPTIONS)).toEqual([]);
  });

  test('round the etching only the oval cut stays dark, not the corners of its box', () => {
    const box = { x: CUT.cx - CUT.rx, y: CUT.cy - CUT.ry, w: CUT.rx * 2, h: CUT.ry * 2 };
    // A shorter stage (nothing playing: no track chip) brings the etching up under the pole.
    const short = { ...STAGE, h: 266 }, pole = { x: 1145, y: 64 };
    const up: KeepItem[] = [FIELD, { kind: 'etch', box: { ...ETCH, y: ETCH.y - 90 } }];
    const oval = chooseLightArcs(TRAILS, pole, short, up);
    const boxed = chooseLightArcs(TRAILS, pole, short, [FIELD, { kind: 'box', box: { ...box, y: box.y - 90 } }]);
    expectClear(oval, pole, short, up);
    expect(oval.length).toBeGreaterThan(0);
    const total = (arcs: LightArc[]) => arcs.reduce((n, a) => n + a.windows.reduce((m, w) => m + w.length, 0), 0);
    expect(total(oval)).toBeGreaterThan(total(boxed));
  });

  test('round 4: the light goes on into the soft rim of the cut, where the trails are still seen, and round the figures', () => {
    const short = { ...STAGE, h: 266 }, pole = { x: 1145, y: 64 }, etch = { ...ETCH, y: ETCH.y - 90 };
    const arcs = chooseLightArcs(TRAILS, pole, short, [FIELD, { kind: 'etch', box: etch }]);
    const cut: Ellipse = { cx: etch.x + etch.w / 2, cy: etch.y + etch.h / 2, rx: etch.w / 2 + 28, ry: etch.h / 2 + 22 };
    const points = arcs.flatMap(a => along(pole, a));
    // Inside the oval round 3 kept dark (and its 14px clearance), outside the middle where the mask hides everything.
    const rim = points.filter(p => inside(p, grow(cut, LIGHT_OPTIONS.pad)) && !inside(p, cutMiddle(etch)));
    expect(rim.length).toBeGreaterThanOrEqual(10);   // points a degree apart: some 20px of trail round 3 left dark
    expect(points.some(p => inside(p, cut) && !inside(p, cutMiddle(etch)))).toBe(true);
    // ...and out to the stage's own edge, which round 3 kept 14px from.
    const { edge } = LIGHT_OPTIONS;
    expect(points.some(p => p.x < edge || p.y < edge || p.x > short.w - edge || p.y > short.h - edge)).toBe(true);
  });

  test('the path runs anticlockwise from where the light enters to where it leaves', () => {
    for (const arc of chooseLightArcs(TRAILS, POLE, STAGE, KEEP)) {
      // One subpath for each stretch it shows in, in the order the light reaches them.
      const subpaths = lightPath(POLE, arc).split('M').slice(1);
      expect(subpaths).toHaveLength(arc.windows.length);
      subpaths.forEach((d, i) => {
        const w = arc.windows[i], n = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
        const [x0, y0, rx, ry, , large, sweep, x1, y1] = n;
        expect(rx).toBe(arc.r); expect(ry).toBe(arc.r);
        expect(x0).toBeCloseTo(POLE.x + arc.r * Math.cos(w.from), 0);
        expect(y0).toBeCloseTo(POLE.y + arc.r * Math.sin(w.from), 0);
        expect(x1).toBeCloseTo(POLE.x + arc.r * Math.cos(w.to), 0);
        expect(y1).toBeCloseTo(POLE.y + arc.r * Math.sin(w.to), 0);
        expect(sweep).toBe(0);
        expect(large).toBe(w.from - w.to > Math.PI ? 1 : 0);
        if (i) expect(w.from).toBeLessThanOrEqual(arc.windows[i - 1].from);
      });
    }
  });

  test('the long tail tapers continuously to the head, its gradient monotone round the curve; a small glow rides on the head', () => {
    for (const arc of [...chooseLightArcs(TRAILS, POLE, STAGE, KEEP), single(900, 900)]) {
      const m = lightMeteor(arc), rad = Math.PI / 180;
      // With reduced motion the head rests along its main stretch.
      expect(m.rest * rad).toBeGreaterThan(arc.to); expect(m.rest * rad).toBeLessThan(arc.from);
      expect(m.length).toBeGreaterThan(Math.min(230, arc.length * 0.4));
      expect(m.length).toBeLessThanOrEqual(320); expect(m.angle).toBeLessThanOrEqual(1.5);
      const dx = m.head.x - m.tail.x, dy = m.head.y - m.tail.y;
      let previous = -1;
      for (let i = 0; i <= 100; i++) {
        const a = m.angle * (1 - i / 100), x = arc.r * Math.cos(a), y = arc.r * Math.sin(a);
        const position = ((x - m.tail.x) * dx + (y - m.tail.y) * dy) / (dx * dx + dy * dy);
        expect(position).toBeGreaterThanOrEqual(-1e-9); expect(position).toBeLessThanOrEqual(1 + 1e-9);
        expect(position).toBeGreaterThanOrEqual(previous); previous = position;
      }
      // The ribbon widens steadily from a point at the tail to METEOR_WIDTH at the head: no step in it.
      const xy = m.path.slice(1).split(/[LAZ]/)[0].split(' ').map(Number);
      expect(Math.hypot(xy[0], xy[1])).toBeCloseTo(arc.r, 2);
      const outer = m.path.slice(1).split('A')[0].split('L').map(q => q.split(' ').map(Number)).map(([x, y]) => Math.hypot(x, y) - arc.r);
      for (let k = 1; k < outer.length; k++) expect(outer[k] - outer[k - 1]).toBeCloseTo(METEOR_WIDTH / 2 / (outer.length - 1), 2);   // to the path's 0.001px
      // The glow: a small oval on the head, a little behind its tip, much shorter than the tail.
      expect(m.glow).toEqual({ cx: arc.r, cy: GLOW.back, rx: GLOW.across, ry: GLOW.along });
      expect(GLOW.across).toBeLessThanOrEqual(5); expect(GLOW.along * 2).toBeLessThan(m.length / 3);
      // The clip band round each window is just wide enough for it.
      const radii = [...lightClipPath(POLE, arc).matchAll(/A([\d.]+) /g)].map(q => Number(q[1]));
      expect(Math.max(...radii)).toBeCloseTo(arc.r + GLOW.across + 0.5, 6);
      expect(Math.min(...radii)).toBeCloseTo(arc.r - GLOW.across - 0.5, 6);
    }
  });

  test('one whole turn a cycle, at full strength all the way round: the loop has no seam and no fade', () => {
    for (const arc of chooseLightArcs(TRAILS, POLE, STAGE, KEEP)) {
      const s = lightSchedule(arc);
      expect(s.to).toBeCloseTo(s.from - 360, 9);
      expect(s.easing === 'linear' || /^linear\(0 0%, .*, 1 100%\)$/.test(s.easing)).toBe(true);
      const points = s.easing === 'linear' ? [] : s.easing.slice(7, -1).split(', ').map(q => q.split(' ').map(parseFloat));
      for (let k = 1; k < points.length; k++) { expect(points[k][0]).toBeGreaterThanOrEqual(points[k - 1][0]); expect(points[k][1]).toBeGreaterThanOrEqual(points[k - 1][1]); }
      for (const t of s.transits) expect(t).toBeLessThanOrEqual(TRANSIT_MS + 1e-6);
    }
    const keyframes = read('src/ui/components/TrailLight.module.css').match(/@keyframes trailFlow \{([\s\S]*?)\n\}/)![1];
    expect(keyframes).toMatch(/from \{ transform: rotate\(var\(--from\)\); \}/);
    expect(keyframes).toMatch(/to \{ transform: rotate\(var\(--to\)\); \}/);
    expect(keyframes).not.toMatch(/opacity|%/);
  });

  test('each light keeps its own pace on the shared motion scale, and its own place in its cycle', () => {
    const lengths = [40, 60, 81, 109, 160, 240, 400, 900];
    const schedules = lengths.map(length => ({ arc: single(length), s: lightSchedule(single(length)) }));
    for (const { arc, s } of schedules) {
      // Its own run (its main stretch and its tail) takes 9 to 24 s at its pace, as before...
      const own = arc.length + lightMeteor(arc).length + METEOR_WIDTH * 2;
      expect(own / s.pace).toBeGreaterThanOrEqual(9000 - 1e-6); expect(own / s.pace).toBeLessThanOrEqual(24000 + 1e-6);
      // ...and the rest of the turn, where none of it is seen, at most TRANSIT_MS.
      expect(s.hidden).toBeLessThanOrEqual(TRANSIT_MS + 1e-6);
      expect(s.ms).toBeLessThanOrEqual(own / s.pace + TRANSIT_MS + 1);
      expect(s.cycle).toBeCloseTo(s.ms / 420, 2);
    }
    // A longer light takes no less time over its own run.
    const runs = schedules.map(({ arc, s }) => (arc.length + lightMeteor(arc).length + METEOR_WIDTH * 2) / s.pace);
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toBeGreaterThanOrEqual(runs[i - 1] - 1e-6);
    const phases = Array.from({ length: 60 }, (_, i) => lightPhase(i));
    for (const p of phases) { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThan(1); }
    expect(new Set(phases.map(p => p.toFixed(4))).size).toBe(phases.length);
  });

  test('it flows only while the music is heard', () => {
    expect(lightFlows({ status: 'playing', muted: false, volume: 0.7 })).toBe(true);
    for (const status of ['paused', 'buffering', 'stopped', 'loading', 'error'] as const) {
      expect(lightFlows({ status, muted: false, volume: 0.7 } as Parameters<typeof lightFlows>[0])).toBe(false);
    }
    expect(lightFlows({ status: 'playing', muted: true, volume: 0.7 })).toBe(false);
    expect(lightFlows({ status: 'playing', muted: false, volume: 0 })).toBe(false);
  });
});

/* ── The light on the stage ───────────────────────────────────── */
let callbacks = new Map<number, FrameRequestCallback>();
let nextId = 1, clock = 0;
beforeEach(() => {
  callbacks = new Map(); nextId = 1; clock = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; callbacks.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function advance(ms: number) {
  const end = clock + ms;
  act(() => {
    while (clock < end) {
      clock += 1000 / 60;
      const due = [...callbacks.values()]; callbacks.clear();
      for (const cb of due) cb(clock);
    }
  });
}
const read = (p: string) => readFileSync(p, 'utf8');

async function playingSnapshot(): Promise<UISnapshot> {
  const session = createMockSession({ autoTick: false });
  const bridge = session.connect('main');
  await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
  const snapshot = bridge.getSnapshot();
  session.destroy();
  return snapshot;
}
/** The music field off, so the only thing on the stage that could run is the light. */
const patternOff = (s: UISnapshot): UISnapshot =>
  ({ ...s, settings: { ...s.settings, ui: { ...s.settings.ui, main: { ...s.settings.ui.main, audioVisualization: false } } } });
const withPlayer = (s: UISnapshot, player: Partial<UISnapshot['player']>): UISnapshot => ({ ...s, player: { ...s.player, ...player } });
const onAction = async (_a: UIAction): Promise<ActionResult> => ({ ok: true, status: 'applied' });
const ui = (snapshot: UISnapshot) => <UIBootContext.Provider value={{}}><PlayerUI snapshot={snapshot} surface="main" onAction={onAction} /></UIBootContext.Provider>;
const light = () => document.querySelector<SVGSVGElement>('[data-ambient="stage"]');
const flow = () => light()!.dataset.flow;

/** Observer stand-ins that record what they watch, so a test can move an element off screen or resize it. */
function stubObservers() {
  const io: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];
  const ro: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    rec = { cb: (() => {}) as IntersectionObserverCallback, targets: [] as Element[] };
    constructor(cb: IntersectionObserverCallback) { this.rec.cb = cb; io.push(this.rec); }
    observe(el: Element) { this.rec.targets.push(el); }
    unobserve() {}
    disconnect() { this.rec.targets = []; }
  });
  vi.stubGlobal('ResizeObserver', class {
    rec = { cb: (() => {}) as ResizeObserverCallback, targets: [] as Element[] };
    constructor(cb: ResizeObserverCallback) { this.rec.cb = cb; ro.push(this.rec); }
    observe(el: Element) { this.rec.targets.push(el); }
    unobserve() {}
    disconnect() { this.rec.targets = []; }
  });
  const watching = <O extends { targets: Element[] }>(list: O[], el: Element) => list.filter(o => o.targets.includes(el));
  return {
    intersect(el: Element, isIntersecting: boolean) {
      act(() => { for (const o of watching(io, el)) o.cb([{ isIntersecting, target: el } as unknown as IntersectionObserverEntry], {} as IntersectionObserver); });
    },
    resize(el: Element) {
      act(() => { for (const o of watching(ro, el)) o.cb([{ target: el, contentRect: el.getBoundingClientRect() } as unknown as ResizeObserverEntry], {} as ResizeObserver); });
    },
    live: () => io.filter(o => o.targets.length).length + ro.filter(o => o.targets.length).length,
    watching: (el: Element) => watching(io, el).length + watching(ro, el).length,
  };
}

/*
 * A laid-out stage for jsdom, which lays out nothing: the stage, the sky (placed so its pole is at
 * POLE) and every element marked to keep clear get the boxes of the 1360×800 window. Text has no
 * line boxes here, so it keeps its whole box clear.
 */
function layOut(extra: (el: Element) => Box | null = () => null) {
  const rect = (b: Box) => ({ x: b.x, y: b.y, left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h, toJSON() { return this; } }) as DOMRect;
  const boxes: Record<string, Box> = {
    start: { x: 330, y: 24, w: 270, h: 300 },
    text: { x: 330, y: 52, w: 640, h: 96 },
    before: { x: 330, y: 170, w: 680, h: 160 },
    etch: { x: 1075, y: 220, w: 141, h: 112 },
  };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const own = extra(this);
    if (own) return rect(own);
    if (this.matches('section[data-viz]')) return rect(STAGE);
    if (this.matches('[data-etch="star-trails"] svg')) {
      return rect({ x: POLE.x - TRAILS_BOX.cx, y: POLE.y - TRAILS_BOX.cy, w: TRAILS_BOX.w, h: TRAILS_BOX.h });
    }
    const kind = (this as HTMLElement).dataset?.keepClear;
    if (kind !== undefined) return rect(boxes[kind] ?? { x: 40, y: 40, w: 260, h: 260 });
    return rect({ x: 0, y: 0, w: 0, h: 0 });
  });
}
/** The light's path ends (of every stretch it shows in) and its strokes, as drawn. */
function drawn() {
  return [...light()!.querySelectorAll<SVGGElement>('g[data-trail]')].map(g => {
    const subpaths = g.querySelector('path')!.getAttribute('d')!.split('M').slice(1).map(d => d.match(/-?\d+(\.\d+)?/g)!.map(Number));
    const n = subpaths[0];
    return { g, start: { x: n[0], y: n[1] }, end: { x: n[7], y: n[8] }, r: n[2], radii: subpaths.map(s => s[2]),
      ends: subpaths.flatMap(s => [{ x: s[0], y: s[1] }, { x: s[7], y: s[8] }]), paths: [...g.querySelectorAll<SVGPathElement>('path')] };
  });
}

describe('cold light on the stage', () => {
  test('it runs while the music is heard and holds, dimmed, when paused, buffering, muted or silent', async () => {
    const playing = patternOff(await playingSnapshot());
    const view = render(ui(withPlayer(playing, { status: 'playing' })));
    expect(light()!.getAttribute('aria-hidden')).toBe('true');
    expect(flow()).toBe('run');
    expect(light()!.dataset.on).toBe('true');
    for (const player of [{ status: 'paused' }, { status: 'buffering' }, { muted: true }, { volume: 0 }] as Partial<UISnapshot['player']>[]) {
      view.rerender(ui(withPlayer(playing, { status: 'playing', ...player })));
      expect(flow()).toBe('hold');
      expect(light()!.dataset.on).toBe('false');
    }
    view.rerender(ui(withPlayer(playing, { status: 'playing' })));
    expect(flow()).toBe('run');
  });

  test('still with reduced motion; paused while the window, the page or the stage is out of sight', async () => {
    const obs = stubObservers();
    const playing = patternOff(await playingSnapshot());
    const view = render(ui({ ...playing, settings: { ...playing.settings, motion: 'reduced' } }));
    expect(flow()).toBe('still');
    view.rerender(ui({ ...playing, host: { ...playing.host, surfaceVisible: false } }));
    expect(flow()).toBe('off');
    view.rerender(ui(playing));
    expect(flow()).toBe('run');
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(flow()).toBe('off');
    hidden.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(flow()).toBe('run');
    obs.intersect(light()!, false);
    expect(flow()).toBe('off');
    obs.intersect(light()!, true);
    expect(flow()).toBe('run');
  });

  test('not drawn in high contrast; the etched sky stays in the page', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(forced-colors: active)', media: query, addEventListener() {}, removeEventListener() {} }));
    render(ui(patternOff(await playingSnapshot())));
    expect(light()).toBeNull();
    expect(document.querySelector('[data-etch="star-trails"]')).not.toBeNull();
  });

  test('drawn from the measured stage: on its trails, on the glass, clear of the text, the controls, the field and the etching', async () => {
    layOut();   // no ResizeObserver here: the light measures once, on mount
    render(ui(await playingSnapshot()));
    const lights = drawn();
    expect(lights.length).toBeGreaterThanOrEqual(3);
    expect(light()!.dataset.lights).toBe(String(lights.length));
    // One glow for every head: a soft oval gradient in the accent's light tint, gone at its edge. No filter anywhere.
    const glows = light()!.querySelectorAll('radialGradient');
    expect(glows).toHaveLength(1);
    expect([...glows[0].querySelectorAll('stop')].map(s => [s.getAttribute('offset'), s.getAttribute('stop-color'), s.getAttribute('stop-opacity')]))
      .toEqual([['0', 'var(--flow-glow)', '0.7'], ['0.45', 'var(--flow-glow)', '0.28'], ['1', 'var(--flow-glow)', '0']]);
    expect(light()!.querySelector('filter, feGaussianBlur, [filter]')).toBeNull();
    const kept: KeepItem[] = [
      { kind: 'start', box: { x: 330, y: 24, w: 270, h: 300 } }, { kind: 'text', box: { x: 330, y: 52, w: 640, h: 96 } },
      { kind: 'before', box: { x: 330, y: 170, w: 680, h: 160 } }, { kind: 'etch', box: ETCH },
    ];
    for (const l of lights) {
      const trail = TRAILS[Number(l.g.dataset.trail)];
      expect(l.r).toBe(trail.r);
      expect(Number(l.g.dataset.ring)).toBe(trail.r);
      for (const r of l.radii) expect(r).toBe(trail.r);
      // Along every stretch it shows in (data-windows), not only at their ends.
      const windows = l.g.dataset.windows!.split(' ').map(w => { const [index, to, from] = w.split(':').map(Number); return { index, to, from, length: (from - to) * trail.r }; });
      expect(windows).toHaveLength(l.radii.length);
      for (const w of windows) expect(TRAILS[w.index].r).toBe(trail.r);
      expectClear([{ r: trail.r, windows }], POLE, STAGE, kept);
      for (const p of l.ends) expect(p.x).toBeGreaterThan(330 + CLEAR - 0.5);     // never over the cover or its disc
      // A single ribbon: the bar colour thinning to nothing behind a head in the peak colour, under a glow, clipped to its windows.
      const motion = l.g.querySelector<SVGGElement>('[data-meteor]')!;
      const ribbon = motion.querySelector('path')!;
      expect(ribbon.getAttribute('fill')).toMatch(/^url\(#.+\)$/);
      expect(motion.querySelectorAll('path')).toHaveLength(1);
      expect([...l.g.querySelectorAll('linearGradient stop')].map(s => [s.getAttribute('offset'), s.getAttribute('stop-color'), s.getAttribute('stop-opacity')]))
        .toEqual([['0', 'var(--flow-body)', '0'], ['0.8', 'var(--flow-body)', '0.8'], ['1', 'var(--flow-head)', '1']]);
      const glow = motion.querySelector('ellipse[data-glow]')!;
      expect(motion.firstElementChild).toBe(glow);   // under the ribbon, so the head stays crisp
      expect(glow.getAttribute('fill')).toBe(`url(#${glows[0].id})`);
      expect(Number(glow.getAttribute('rx'))).toBe(GLOW.across); expect(Number(glow.getAttribute('ry'))).toBe(GLOW.along);
      expect(Number(glow.getAttribute('cx'))).toBe(trail.r);
      expect(l.g.querySelector('[clip-path]')!.getAttribute('clip-path')).toMatch(/^url\(#.+\)$/);
      for (const v of ['--from', '--to', '--rest']) expect(motion.style.getPropertyValue(v)).toMatch(/deg$/);
      // One whole turn a cycle; its pace round the turn is the inline easing.
      expect(parseFloat(motion.style.getPropertyValue('--to'))).toBeCloseTo(parseFloat(motion.style.getPropertyValue('--from')) - 360, 3);
      expect(motion.style.animationTimingFunction === '' || /^linear/.test(motion.style.animationTimingFunction)).toBe(true);
      expect(Number(l.g.style.getPropertyValue('--cycle'))).toBeGreaterThan(0);
      expect(Number(l.g.style.getPropertyValue('--phase'))).toBeLessThanOrEqual(0);
    }
    // At most a handful of nodes for each light, whatever it shows in.
    expect(light()!.querySelectorAll('*').length).toBeLessThanOrEqual(7 + 14 * lights.length);
  });

  test('measures again when the stage resizes, once per frame, and the sky under it is never redrawn', async () => {
    const obs = stubObservers();
    let width = STAGE.w;
    layOut(el => (el.matches('section[data-viz]') ? { ...STAGE, w: width } : null));
    const snapshot = await playingSnapshot();
    const view = render(ui(snapshot));
    const sky = [...document.querySelectorAll('[data-etch="star-trails"] path')];
    const cut = sky.map(p => p.getAttribute('d'));
    const stage = document.querySelector('section[data-viz]')!;
    expect(obs.watching(stage)).toBeGreaterThan(0);
    for (const el of document.querySelectorAll('[data-keep-clear]')) expect(obs.watching(el)).toBeGreaterThan(0);
    // The first observation (a browser delivers one on observe): one frame, then the light is drawn.
    obs.resize(stage);
    advance(20);
    const before = drawn().map(l => l.g.dataset.trail);
    expect(before.length).toBeGreaterThanOrEqual(3);
    // A burst of resizes asks for a single frame and measures once in it.
    width = 900;
    const frames = callbacks.size;
    obs.resize(stage); obs.resize(stage); obs.resize(stage);
    expect(callbacks.size).toBe(frames + 1);
    advance(20);
    const after = drawn().map(l => l.g.dataset.trail);
    expect(after).not.toEqual(before);   // the sky's pole stayed where it was, the free glass went: no light there now
    for (const status of ['paused', 'playing'] as const) view.rerender(ui(withPlayer(snapshot, { status })));
    const now = [...document.querySelectorAll('[data-etch="star-trails"] path')];
    expect(now).toHaveLength(4);
    now.forEach((p, i) => { expect(p).toBe(sky[i]); expect(p.getAttribute('d')).toBe(cut[i]); });
  });

  test('while it flows nothing re-renders and it asks for no frames; unmounting leaves nothing behind', async () => {
    const obs = stubObservers();
    const added = new Set<EventListenerOrEventListenerObject>();
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      if (type === 'visibilitychange') added.add(fn);
      add(type, fn, opts);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
      if (type === 'visibilitychange') added.delete(fn);
      remove(type, fn, opts);
    });
    layOut();
    const snapshot = patternOff(await playingSnapshot());
    let commits = 0;
    const view = render(<Profiler id="ui" onRender={() => { commits++; }}>{ui(snapshot)}</Profiler>);
    obs.resize(document.querySelector('section[data-viz]')!);
    advance(100);
    expect(flow()).toBe('run');
    expect(drawn().length).toBeGreaterThan(0);
    const frames = callbacks.size, settled = commits;
    advance(2000);
    expect(commits).toBe(settled);
    expect(callbacks.size).toBe(frames);
    expect(added.size).toBeGreaterThan(0);
    view.unmount();
    expect(added.size).toBe(0);
    expect(obs.live()).toBe(0);
  });
});

/* ── Stylesheet rules (what jsdom cannot run) ───────────────────── */
describe('cold light rules', () => {
  const css = read('src/ui/components/TrailLight.module.css');
  const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.[\]"=]/g, m => `\\${m}`)} \\{([^}]*)\\}`))?.[1] ?? '';
  test('no filter, blur, blend or shadow; only the meteor turns', () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/filter|blur|mix-blend|box-shadow|backdrop|will-change/);
    expect(read('src/ui/components/TrailLight.tsx')).not.toMatch(/<filter|feGaussianBlur|filter=|drop-shadow/);
    const keyframes = css.match(/@keyframes trailFlow \{([\s\S]*?)\n\}/)![1];
    expect([...new Set([...keyframes.matchAll(/([a-z-]+):/g)].map(m => m[1]))].sort()).toEqual(['transform']);
    expect(rule('.beam')).toMatch(/animation: trailFlow var\(--period\) linear /);   // even all the way round where linear() is not known
  });
  test('the light wears the sky\'s own mask, so it is seen as much as the trail it runs in', () => {
    const spot = read('src/ui/views/Spotlight.module.css');
    expect(spot).toMatch(/\n\.sky, \.flow \{\n\s+-webkit-mask-image: linear-gradient\(90deg,/);
    expect(spot).toContain('.stage[data-etch="true"] .sky, .stage[data-etch="true"] .flow {');
    expect(spot).toContain('.stage[data-etch="true"] .sky, .stage[data-etch="true"] .flow { -webkit-mask-size: 100% 100%, 0 0; mask-size: 100% 100%, 0 0; }');
    expect(spot.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\.sky \{|\.sky\s*\{/);   // no rule for the sky alone
    expect(read('src/ui/views/Spotlight.tsx')).toContain('<TrailLight className={styles.flow}');
  });
  test('its pace is on the shared motion scale; paused unless it runs; no animation with reduced motion; hidden in high contrast', () => {
    const beam = rule('.beam');
    expect(beam).toContain('--period: calc(var(--d-slow) * var(--cycle');
    expect(beam).toContain('animation-play-state: paused');
    expect(beam).not.toMatch(/\d(ms|s)\b/);
    expect(rule('.light[data-flow="run"] .beam')).toContain('animation-play-state: running');
    expect(rule('.light[data-flow="still"] .beam')).toContain('animation: none');
    // A light that appears fades in once, on the same scale (so not at all with reduced motion); it never loops.
    expect(rule('.trail')).toMatch(/^ animation: trailIn calc\(var\(--d-slow\) \* \d\) var\(--ease-out\) both; $/);
    expect(css).toContain('@media (forced-colors: active) { .light { display: none; } }');
    expect(read('src/ui/views/Spotlight.module.css').slice(read('src/ui/views/Spotlight.module.css').indexOf('@media (forced-colors: active)')))
      .toContain('.sky, .viz, .flow { display: none; }');
  });
  test('the player bar keeps its strip: a fade on the shared motion scale, never an animation of its own', () => {
    const strip = read('src/ui/views/PlayerCapsule.module.css').match(/\.ambient \{[^}]*\}/)![0];
    expect(strip).toContain('transition: opacity calc(var(--d-slow) * 4)');
    expect(strip).not.toMatch(/animation/);
  });
});

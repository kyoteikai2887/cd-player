/**
 * V1.2 star-trail completion (Claude, round 4): in a browser, over a whole cycle of every light,
 * every stroke of every lit ring that can be seen on the glass gets the light's bright head; the
 * light shows nowhere else; it moves evenly wherever it is seen; and its colours are the music
 * field's.
 *
 *   pnpm dev            (or any server for the preview, e.g. vite --host 127.0.0.1 --port 5179)
 *   node tests/ui/stage-coverage.browser.mjs [baseUrl] [--json out.json] [--shots dir] [--only text] [--jobs n]
 *
 * Needs Playwright with a Chromium (not a project dependency): `playwright` from node_modules, or
 * the module named by PLAYWRIGHT (path to its index.mjs). Not part of `vitest run`.
 *
 * It does not use lib/trailLight.ts. What can be seen is measured from the page itself, in every
 * preview still (fictional data, a fixed demo signal frame):
 *   - the trails: every etched trail of every lit ring (TRAILS, placed where the browser laid the
 *     sky out), a pixel apart;
 *   - how much of a trail the glass shows there: a still of the stage with only a white sheet in
 *     the sky's layer, in place of its trails, on black, so the stage's rounded edge, the dimming
 *     behind the text and the soft cut round the memorial etching are the browser's own; a trail
 *     point shows if that is over 8/255. The light's layer must wear the same mask on the same box;
 *   - what stands in front of the trails: the lines of text actually set, every box marked to keep
 *     clear (the eyebrow, the cover, the track chip, the facts, the buttons, the music field), every
 *     button, the cover's disc, and the memorial's ink (a still of the etching alone, its walls and
 *     its floor, in white on black: over 8/255);
 *   - the target: every trail point that shows and nothing stands in front of. Within 8px of the
 *     text, a button, the cover or the field, or 6px of any trace of the memorial's ink (drawn at a
 *     third of its pixels, a line of it can fall under 8/255), it is "clearance" (the
 *     head's glow keeps clear of them; listed, not required); before the text column (the cover's
 *     column) it is "start column" (listed). Target points the round-3 rule left dark (14px from
 *     the stage's edge, its corners' 42px squares, 14px round the old keep-clear shapes, the oval
 *     round the etching) are "new in round 4";
 *   - the light: each light's own animation, paused and stepped through its whole cycle, at least
 *     240 steps and as many as keep the head's step under 1.5px where it is seen (measured on a
 *     first pass). At each step the browser's isPointInFill on the light's clip and on its meteor
 *     (in its transform at that moment) says which points are lit, the meteor's gradient how
 *     brightly, times the computed opacity: the peak each point gets in one cycle;
 *   - each target point is "lit" when the head passes it (peak ≥ 0.95), "tail only" when only the
 *     fading tail does, "never lit" otherwise; fails unless every target point (not clearance, not
 *     start column) is lit. One that is not is put down to a cause: "clipped" (outside the light's
 *     clip), "never reached" (in it, but the meteor never got there), "tail only" (only its tail
 *     did), or "faded head" (the head passed, faded out by the light's own opacity);
 *   - the motion: one whole turn a cycle; wherever the head is in a window its speed is the same
 *     (within 3%), with steps under 2px, so it never jumps on the glass; the longest time none of
 *     the light is seen (none of its tail past 8% strength nor its glow over any point of its
 *     windows, a quarter pixel apart; each end of each such moment found to 1 ms) is at most
 *     1260 ms, give or take the time the head takes over two pixels at its even pace (which starts
 *     a little before any of it shows, so it never enters a window moving fast);
 *   - where it can show: every point of its clip on the ring is on an etched trail of that ring
 *     (0.5px), so no line is drawn across the glass between stretches; nothing of the clip's band
 *     (±5px, the glow's width) is over the text, a button, the cover, the field or the memorial's
 *     ink; past the stage's edge is allowed (the stage clips it, like the trails);
 *   - colour: the tail's stops compute to the accent (--accent-fill); the head's to the music
 *     field's peak colour (--viz-arc, as an actual peak mark computes it): itself on charcoal, three
 *     parts to one of white on the papers; the glow's to --accent-hi. With every head paused where
 *     the glass shows the trail fully, the pixel the light changes most round the head keeps the
 *     accent's hue (within 15°) and some of its saturation (not white);
 *   - a glow on every head (an ellipse filled with the one radial gradient), no filter on anything;
 *     the most SVG nodes; and the states: holding when paused, buffering, muted or silent (dimmed,
 *     not moving), still with reduced motion (resting in a window), absent in forced colours.
 * Exits 1 if anything fails; prints one line per still and a summary. The JSON has, for every lit
 * ring, its cycle, pace and longest unseen moment, and every run of its trails by what it is
 * (target or why not) with its peak and whether the head passed; for the 2100×900 still, the five
 * places marked on the user's screenshot (A–E). With --shots, writes each still with the heads in
 * view (true colour) and a coverage map in false colour.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : null; };
const jsonOut = option('--json'), shots = option('--shots'), only = option('--only'), jobs = Number(option('--jobs') ?? 3);
const base = (args[0] ?? 'http://127.0.0.1:5179').replace(/\/$/, '');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const T = 314;            // the demo signal's frame (ms), the same in every still
const ACCENT = 'DB7A3D';  // the default accent, terracotta
const SIZES = [[960, 600], [1100, 720], [1280, 800], [1360, 800], [1440, 900], [1600, 900], [1760, 1000], [1920, 1080], [2100, 900], [2560, 1440]];
const STILLS = [
  // Every theme, both titles, every size of the review matrix.
  ...['charcoal', 'light', 'blue'].flatMap(theme => ['stage-short', 'stage-ja-long'].flatMap(shot => SIZES.map(([w, h]) => ({ theme, shot, w, h })))),
  // The 1200–1450 sweep, and windows whose stage itself is about 1400px wide.
  ...Array.from({ length: 11 }, (_, i) => ({ theme: 'charcoal', shot: 'stage-ja-long', w: 1200 + i * 25, h: 800 })),
  { theme: 'charcoal', shot: 'stage-short', w: 1814, h: 1000 }, { theme: 'light', shot: 'stage-ja-long', w: 1814, h: 1000 },
  // The tallest field, the font at 85% and 130%, the etching off, the pattern off.
  ...[[960, 600], [1100, 720], [1280, 800], [1920, 1080]].map(([w, h]) => ({ theme: 'charcoal', shot: 'stage-ja-long', w, h, viz: 'full' })),
  ...[[1100, 720], [1440, 900]].map(([w, h]) => ({ theme: 'charcoal', shot: 'stage-ja-long', w, h, extra: 'fs=0.85' })),
  ...[[1100, 720], [1360, 800], [1920, 1080], [2560, 1440]].map(([w, h]) => ({ theme: 'charcoal', shot: 'stage-ja-long', w, h, extra: 'fs=1.3' })),
  ...[[1280, 800], [1920, 1080], [2560, 1440]].map(([w, h]) => ({ theme: 'charcoal', shot: 'stage-ja-long', w, h, extra: 'etch=0' })),
  ...[[1280, 800], [1920, 1080]].map(([w, h]) => ({ theme: 'charcoal', shot: 'stage-short', w, h, extra: 'pattern=0' })),
  // A longer title, and a colour of the user's own.
  ...[[1280, 800], [1920, 1080]].map(([w, h]) => ({ theme: 'blue', shot: 'stage-long', w, h })),
  ...[['light', 1360, 800], ['charcoal', 1920, 1080], ['blue', 1280, 800], ['charcoal', 2100, 900]].map(([theme, w, h]) => ({ theme, shot: 'stage-short', w, h, accent: 'E0628F' })),
].map(f => ({ ...f, accent: f.accent ?? ACCENT, viz: f.viz ?? 'pulse' }));
/*
 * The five places marked on the user's screenshot (round-4 pack, references/01-user-marked-gaps.png),
 * in the layout it shows (2100×900, charcoal, short title: a 1654×312 stage, the pole 106.6px from its
 * right edge): a ring, and the place on it relative to the pole.
 */
const MARKED = { still: 'charcoal 2100x900 stage-short', spots: [
  { name: 'A', where: 'top edge, ring 394.1', r: 394.1, dx: -387.4, dy: -72.4 },
  { name: 'B', where: 'top edge, ring 195.1', r: 195.1, dx: -180.2, dy: -74.9 },
  { name: 'C', where: 'small arc at the right, ring 93.6', r: 93.6, dx: 93.6, dy: 0 },
  { name: 'D', where: 'bottom edge, ring 468.3', r: 468.3, dx: -403.8, dy: 237.2 },
  { name: 'E', where: 'long arc under the memorial, ring 229.5', r: 229.5, dx: 0, dy: 229.5 },
] };
const STATES = [
  { name: 'paused', q: 'status=paused', flow: 'hold' },
  { name: 'buffering', q: 'status=buffering', flow: 'hold' },
  { name: 'muted', q: 'muted=1', flow: 'hold' },
  { name: 'silent', q: 'volume=0', flow: 'hold' },
  { name: 'playing', q: '', flow: 'run' },
  { name: 'reduced motion', q: '', media: { reducedMotion: 'reduce' }, flow: 'still' },
  { name: 'forced colours', q: '', media: { forcedColors: 'active' }, flow: null },
];
const url = f => `${base}/preview/?shot=${f.shot}&theme=${f.theme}&accent=${f.accent}&viz=${f.viz}&t=${T}&w=${f.w}&h=${f.h}${f.extra ? '&' + f.extra : ''}`;
const label = f => `${f.theme} ${f.w}x${f.h} ${f.shot}${f.viz !== 'pulse' ? ' viz=' + f.viz : ''}${f.extra ? ' ' + f.extra : ''}${f.accent !== ACCENT ? ' accent=' + f.accent : ''}`;

/* ── In the page (each function runs there on its own: what they share is on window.__cover) ── */

/** The stage, what stands in front of its trails, the light's parts, and the trail points of every lit ring. */
async function setUp() {
  const { TRAILS, TRAILS_BOX } = await import('/src/ui/components/StarTrails.tsx');
  const stage = document.querySelector('section[data-viz]'), root = stage?.querySelector('[data-ambient="stage"]');
  if (!stage) return { error: 'no stage' };
  if (!root) return { error: 'no light', nodes: 0 };
  const S = stage.getBoundingClientRect(), W = S.width, H = S.height;
  const skyEl = stage.querySelector('[data-etch="star-trails"]'), sky = skyEl.querySelector('svg').getBoundingClientRect();
  const pole = { x: sky.left - S.left + (TRAILS_BOX.cx * sky.width) / TRAILS_BOX.w, y: sky.top - S.top + (TRAILS_BOX.cy * sky.height) / TRAILS_BOX.h };
  const box = r => ({ x: r.left - S.left, y: r.top - S.top, w: r.width, h: r.height });
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' ? r : null; };
  // What stands in front of the trails (no clearance), and round 3's keep-clear shapes (for "new in round 4").
  const front = [], old = [];
  let startX = 0, etch = null;
  for (const el of stage.querySelectorAll('[data-keep-clear]')) {
    const r = shown(el);
    if (!r) continue;
    const kind = el.dataset.keepClear;
    if (kind === 'text') {
      const range = document.createRange(); range.selectNodeContents(el);
      const lines = [...range.getClientRects()].filter(l => l.width > 0 && Math.min(l.bottom, r.bottom) > Math.max(l.top, r.top));
      for (const l of lines.length ? lines : [r]) {
        const top = Math.max(l.top, r.top), bottom = Math.min(l.bottom, r.bottom);
        front.push({ ...box({ left: l.left, top, width: l.width, height: bottom - top }), why: 'text' });
        old.push({ x: l.left - S.left, y: 0, w: l.width, h: bottom - S.top });
      }
    } else if (kind === 'before') { front.push({ ...box(r), why: el.matches('[data-stage-viz]') ? 'music field' : 'controls' }); old.push({ x: 0, y: 0, w: r.right - S.left, h: H }); }
    else if (kind === 'start') { startX = r.left - S.left; old.push({ x: 0, y: 0, w: r.left - S.left, h: H }); }
    else if (kind === 'etch') { etch = box(r); old.push({ cx: etch.x + etch.w / 2, cy: etch.y + etch.h / 2, rx: etch.w / 2 + 28, ry: etch.h / 2 + 22 }); }
    else { front.push({ ...box(r), why: el.matches('[class*="_art_"]') ? 'cover' : 'eyebrow' }); old.push(box(r)); }
  }
  for (const el of stage.querySelectorAll('button, [class*="_art_"], [class*="_disc_"], [data-stage-viz]')) {
    const r = shown(el);
    if (r) front.push({ ...box(r), why: el.matches('button') ? 'button' : el.matches('[data-stage-viz]') ? 'music field' : 'cover' });
  }
  const inShape = (p, b, pad) => ('rx' in b
    ? ((p.x - b.cx) / (b.rx + pad)) ** 2 + ((p.y - b.cy) / (b.ry + pad)) ** 2 <= 1
    : p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad);
  const oldFree = p => {
    if (p.x < 14 || p.x > W - 14 || p.y < 14 || p.y > H - 14) return false;
    if ((p.x < 42 || p.x > W - 42) && (p.y < 42 || p.y > H - 42)) return false;
    return !old.some(b => inShape(p, b, 14));
  };
  // The middle of the cut round the etching, where the sky's mask is nothing (to tell it from the stage's edge).
  const cutMiddle = etch && { cx: etch.x + etch.w / 2, cy: etch.y + etch.h / 2, rx: (etch.w / 2 + 28) * 0.62 + 1, ry: (etch.h / 2 + 22) * 0.62 + 1 };

  // The light wears the sky's mask: the same rules on the same box.
  const masks = ['maskImage', 'maskSize', 'maskPosition', 'maskRepeat', 'maskComposite', 'webkitMaskImage', 'webkitMaskSize', 'webkitMaskPosition'];
  const skyStyle = getComputedStyle(skyEl), lightStyle = getComputedStyle(root), lb = root.getBoundingClientRect(), kb = skyEl.getBoundingClientRect();
  const maskMismatch = masks.filter(k => skyStyle[k] !== lightStyle[k]);
  if (Math.abs(lb.left - kb.left) > 0.5 || Math.abs(lb.top - kb.top) > 0.5 || Math.abs(lb.width - kb.width) > 0.5 || Math.abs(lb.height - kb.height) > 0.5) maskMismatch.push('box');

  const TURN = Math.PI * 2;
  const at = (r, a) => ({ x: pole.x + r * Math.cos(a), y: pole.y + r * Math.sin(a) });
  const animations = root.getAnimations({ subtree: true });
  /** A light's animation paused at u of its own cycle. */
  const seekLight = (l, u) => {
    const t = l.flow.effect.getTiming();
    l.flow.pause();
    l.flow.currentTime = t.delay + Number(t.duration) * u;
  };
  /** Everything paused, the entry fades finished. */
  const settle = () => {
    for (const a of animations) {
      a.pause();
      if (!a.animationName.includes('trailFlow')) { const t = a.effect.getTiming(); a.currentTime = Number(t.duration) + Math.max(0, t.delay); }
    }
  };
  const lights = [...root.querySelectorAll('g[data-trail]')].map(g => {
    const route = g.querySelector('[data-light-path]'), r = +route.getAttribute('d').match(/A([\d.]+)/)[1];
    const beam = g.querySelector('[data-meteor]'), ribbon = beam.querySelector('path'), glow = beam.querySelector('ellipse[data-glow]');
    const gradient = g.querySelector('linearGradient'), clip = g.querySelector('clipPath path');
    const x1 = +gradient.getAttribute('x1'), y1 = +gradient.getAttribute('y1'), x2 = +gradient.getAttribute('x2'), y2 = +gradient.getAttribute('y2');
    const fades = []; for (let e = ribbon; e && e !== root; e = e.parentElement) fades.push(e);
    const flow = animations.find(a => a.animationName.includes('trailFlow') && a.effect.target === beam);
    const samples = [];
    TRAILS.forEach((t, trail) => {
      if (t.r !== r) return;
      const n = Math.max(2, Math.ceil((t.a1 - t.a0) * r));
      for (let k = 0; k <= n; k++) {
        const angle = t.a0 + ((t.a1 - t.a0) * k) / n, p = at(r, angle);
        samples.push({ trail, k, angle, ...p, inClip: clip.isPointInFill(new DOMPoint(p.x, p.y)), peak: 0 });
      }
    });
    // For telling whether any of the light is seen: the ring a quarter pixel apart, wherever the clip lets it show.
    const dense = [];
    for (let k = 0, n = Math.ceil(TURN * r * 4); k < n; k++) { const p = at(r, (k / n) * TURN); if (clip.isPointInFill(new DOMPoint(p.x, p.y))) dense.push(p); }
    return { g, r, beam, ribbon, glow, gradient, clip, flow, x1, y1, dx: x2 - x1, dy: y2 - y1, fades, samples, dense,
      trails: [...new Set(samples.map(s => s.trail))].map(i => ({ a0: TRAILS[i].a0, a1: TRAILS[i].a1 })),
      windows: g.dataset.windows ? g.dataset.windows.split(' ').length : null };
  });
  // Colours, as the browser computes them in the stage.
  const probe = document.createElement('i');
  stage.append(probe);
  const tint = v => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
  const colours = { accentFill: tint('--accent-fill'), accentHi: tint('--accent-hi'), vizArc: tint('--viz-arc') };
  probe.remove();
  const peakMark = stage.querySelector('[class*="_peak_"]');
  colours.peakMark = peakMark ? getComputedStyle(peakMark).fill : null;
  const filters = [root, ...root.querySelectorAll('*')].filter(e => getComputedStyle(e).filter !== 'none').length;
  window.__cover = { stage, root, S, W, H, pole, front, startX, etch, cutMiddle, inShape, oldFree, lights, animations, at, TURN, seekLight, settle };
  return {
    stage: { w: W, h: H, left: S.left, top: S.top }, pole, nodes: root.querySelectorAll('*').length + 1, flow: root.dataset.flow,
    maskMismatch, filters, colours, startX, etch: !!etch,
    easing: lights.map(l => getComputedStyle(l.beam).animationTimingFunction),
    lights: lights.map(l => ({
      r: l.r, windows: l.windows, samples: l.samples.length, glow: !!l.glow && /^url\(#/.test(l.glow.getAttribute('fill') ?? ''),
      glowGradient: !!l.glow && !!root.querySelector(`radialGradient[id="${(l.glow.getAttribute('fill') ?? '').slice(5, -1)}"]`),
      stops: [...l.gradient.querySelectorAll('stop')].map(s => ({ offset: s.getAttribute('offset'), opacity: s.getAttribute('stop-opacity'), color: getComputedStyle(s).stopColor })),
      duration: l.flow ? Number(l.flow.effect.getTiming().duration) : null,
    })),
    glowStops: [...root.querySelectorAll('radialGradient stop')].map(s => ({ offset: s.getAttribute('offset'), opacity: s.getAttribute('stop-opacity'), color: getComputedStyle(s).stopColor })),
  };
}

/** Before a probe still: only a white sheet in the sky's layer, in place of its trails (mask), or only the memorial etching in white (ink). */
function probeOn(kind) {
  const style = document.createElement('style');
  style.id = '__probe';
  if (kind === 'mask') {
    const sheet = document.createElement('i');
    sheet.className = '__probe';
    sheet.style.cssText = 'position:absolute;inset:0;background:#fff';
    window.__cover.stage.querySelector('[data-etch="star-trails"]').append(sheet);
    style.textContent = `html, body { background: #000 !important; } * { visibility: hidden !important; transition: none !important; }
      [data-etch="star-trails"], [data-etch="star-trails"] > i.__probe { visibility: visible !important; } [data-etch="star-trails"] > svg { display: none !important; }`;
  } else {
    style.textContent = `html, body { background: #000 !important; } * { visibility: hidden !important; transition: none !important; }
      [data-memorial="etch"], [data-memorial="etch"] * { visibility: visible !important; }
      [data-memorial="etch"] { filter: brightness(0) invert(1) !important; opacity: 1 !important; } [data-memorial="etch"] > i { background: #fff !important; }`;
  }
  document.head.append(style);
}
function probeOff() {
  document.getElementById('__probe')?.remove();
  window.__cover.stage.querySelector('i.__probe')?.remove();
}

/** With both probe stills: what each trail point is (target or why not), and where each light's clip can show. */
async function classify([maskPng, inkPng, origin]) {
  const c = window.__cover;
  const decode = async b64 => {
    if (!b64) return null;
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(img.width, img.height), x = canvas.getContext('2d');
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, img.width, img.height);
  };
  const mask = await decode(maskPng), ink = await decode(inkPng);
  const ox = c.S.left - origin.x, oy = c.S.top - origin.y;
  const px = (img, x, y) => (x < 0 || y < 0 || x >= img.width || y >= img.height ? 0 : img.data[(y * img.width + x) * 4] / 255);
  /** Bilinear, at a point of the stage. */
  const sample = (img, p) => {
    const x = p.x + ox - 0.5, y = p.y + oy - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    return px(img, x0, y0) * (1 - fx) * (1 - fy) + px(img, x0 + 1, y0) * fx * (1 - fy) + px(img, x0, y0 + 1) * (1 - fx) * fy + px(img, x0 + 1, y0 + 1) * fx * fy;
  };
  const SHOW = 8 / 255;
  /** Whether the memorial's ink (over `level`) is within `by` px of a point. */
  const inkAt = (p, by = 0, level = SHOW) => {
    if (!ink || !c.etch || !c.inShape(p, c.etch, by + 1)) return false;
    const x0 = Math.round(p.x + ox), y0 = Math.round(p.y + oy), b = Math.ceil(by + 1);
    for (let y = y0 - b; y <= y0 + b; y++) for (let x = x0 - b; x <= x0 + b; x++) {
      if ((x + 0.5 - p.x - ox) ** 2 + (y + 0.5 - p.y - oy) ** 2 > (by + 0.71) ** 2) continue;
      if (px(ink, x, y) > level) return true;
    }
    return false;
  };
  c.inkAt = inkAt;
  c.showAt = p => sample(mask, p);
  for (const l of c.lights) for (const s of l.samples) {
    s.show = sample(mask, s);
    const inFront = c.front.find(b => c.inShape(s, b, 0));
    if (s.x < 0 || s.y < 0 || s.x > c.W || s.y > c.H) s.what = 'off the glass';
    else if (s.show <= SHOW) s.what = c.cutMiddle && c.inShape(s, c.cutMiddle, 0) ? 'cut middle (mask 0)' : 'off the glass';
    else if (inFront) s.what = inFront.why;
    else if (inkAt(s)) s.what = 'memorial ink';
    else {
      s.what = 'target';
      // Round the etching, any trace of ink counts: drawn at a third of its pixels, a line of it one pixel wide can fall under 8/255.
      s.clearance = c.front.some(b => c.inShape(s, b, 8)) || inkAt(s, 6, 1 / 255);
      s.start = s.x < c.startX;
      s.fresh = !c.oldFree(s);
    }
  }
  // Where each clip can show: on the ring (1px apart) and across its band.
  const outside = [];
  let pastEdge = 0;
  const norm = a => ((a % c.TURN) + c.TURN) % c.TURN;
  for (const l of c.lights) {
    const n = Math.ceil(c.TURN * l.r);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * c.TURN;
      for (const dr of [0, -2.5, 2.5, -4, 4, -5, 5]) {
        const p = c.at(l.r + dr, a);
        if (!l.clip.isPointInFill(new DOMPoint(p.x, p.y))) continue;
        if (dr === 0 && !l.trails.some(t => norm(a - t.a0 + 0.5 / l.r) <= t.a1 - t.a0 + 1 / l.r)) outside.push({ r: l.r, why: 'clip where no trail is etched', x: p.x, y: p.y });
        if (p.x < 0 || p.y < 0 || p.x > c.W || p.y > c.H) { pastEdge++; continue; }
        const inFront = c.front.find(b => c.inShape(p, b, 0));
        if (inFront) outside.push({ r: l.r, why: `clip band over ${inFront.why}`, x: p.x, y: p.y });
        else if (inkAt(p)) outside.push({ r: l.r, why: 'clip band over memorial ink', x: p.x, y: p.y });
      }
    }
  }
  return { outside: outside.slice(0, 20), outsideCount: outside.length, pastEdge };
}

/** One light's whole cycle: first its pace where it is seen, then every step, the peak each point gets and whether any of it is seen. */
function sweep(index) {
  const c = window.__cover, l = c.lights[index], TRANSIT_MS = 1260;
  c.settle();
  if (!l.flow) return { r: l.r, error: 'no animation' };
  const D = Number(l.flow.effect.getTiming().duration);
  const headAt = () => {
    const m = l.ribbon.getCTM();
    return { m, angle: Math.atan2(m.b, m.a), head: new DOMPoint(l.r, 0).matrixTransform(m) };
  };
  const turnOf = (a, b) => { let d = b - a; while (d > Math.PI) d -= c.TURN; while (d < -Math.PI) d += c.TURN; return d; };
  // First pass: the slowest the head goes (where it is seen) sets the steps.
  const coarse = [];
  for (let f = 0; f <= 240; f++) { c.seekLight(l, f / 240); coarse.push(headAt().angle); }
  let slowest = Infinity;
  for (let f = 1; f < coarse.length; f++) { const v = (Math.abs(turnOf(coarse[f - 1], coarse[f])) * l.r) / (D / 240); if (v > 1e-6) slowest = Math.min(slowest, v); }
  const n = Math.min(6000, Math.max(240, Math.ceil((D * slowest) / 1.5)));
  for (const s of l.samples) { s.peak = 0; s.reach = 0; s.glowed = false; }
  /** The light at u of its cycle: the head's angle, whether the head is in a window, whether any of the light is seen; the peaks, if `mark`. */
  const look = (u, mark) => {
    c.seekLight(l, u);
    let opacity = 1;
    for (const e of l.fades) opacity *= Number(getComputedStyle(e).opacity);
    const { m, angle, head } = headAt(), inverse = m.inverse();
    const bb = l.ribbon.getBBox(), gb = l.glow ? l.glow.getBBox() : bb;
    const x0 = Math.min(bb.x, gb.x), y0 = Math.min(bb.y, gb.y), x1 = Math.max(bb.x + bb.width, gb.x + gb.width), y1 = Math.max(bb.y + bb.height, gb.y + gb.height);
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
    const lo = { x: Math.min(...corners.map(q => q.x)) - 2, y: Math.min(...corners.map(q => q.y)) - 2 }, hi = { x: Math.max(...corners.map(q => q.x)) + 2, y: Math.max(...corners.map(q => q.y)) + 2 };
    const position = q => Math.max(0, Math.min(1, ((q.x - l.x1) * l.dx + (q.y - l.y1) * l.dy) / (l.dx * l.dx + l.dy * l.dy)));
    const near = p => p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y;
    if (mark && opacity > 0) for (const s of l.samples) {
      if (!s.inClip || !near(s)) continue;
      const q = new DOMPoint(s.x, s.y).matrixTransform(inverse);
      if (l.ribbon.isPointInFill(q)) { const at = position(q); s.peak = Math.max(s.peak, at * opacity); s.reach = Math.max(s.reach, at); }
      else if (l.glow && l.glow.isPointInFill(q)) s.glowed = true;
    }
    const seen = opacity > 0 && l.dense.some(p => {
      if (!near(p)) return false;
      const q = new DOMPoint(p.x, p.y).matrixTransform(inverse);
      return (l.ribbon.isPointInFill(q) && position(q) >= 0.08) || (!!l.glow && l.glow.isPointInFill(q));
    });
    return { angle, headIn: l.clip.isPointInFill(head), seen };
  };
  const frames = [];
  for (let f = 0; f <= n; f++) frames.push(look(f / n, true));
  const dt = D / n;
  // Where the head is in a window, its speed and its step.
  const speeds = [];
  for (let f = 1; f < frames.length; f++) if (frames[f - 1].headIn && frames[f].headIn) speeds.push((Math.abs(turnOf(frames[f - 1].angle, frames[f].angle)) * l.r) / dt);
  speeds.sort((a, b) => a - b);
  const median = speeds.length ? speeds[speeds.length >> 1] : null;
  // Every moment none of the light is seen, round the loop (the first and last step are the same moment), its ends found to 1 ms.
  const loop = frames.slice(0, -1), seenAny = loop.some(f => f.seen), transits = [];
  const edge = (yes, no) => {   // u where it turns from seen (yes) to unseen (no), either way round
    while (Math.abs(no - yes) * D > 1) { const mid = (yes + no) / 2; if (look(((mid % 1) + 1) % 1, false).seen) yes = mid; else no = mid; }
    return (yes + no) / 2;
  };
  if (seenAny) {
    const first = loop.findIndex(f => f.seen);
    for (let k = 1; k <= loop.length; k++) {
      const i = (first + k) % loop.length;
      if (loop[i].seen || !loop[(i - 1 + loop.length) % loop.length].seen) continue;
      let j = i; while (!loop[(j + 1) % loop.length].seen) j++;   // unseen from step i to step j
      const u0 = edge((i - 1) / loop.length, i / loop.length), u1 = edge((j + 1) / loop.length, j / loop.length);
      transits.push(Math.round((u1 - u0) * D));
    }
  }
  const turn = frames.slice(1).reduce((sum, f, k) => sum + turnOf(frames[k].angle, f.angle), 0);
  return {
    r: l.r, cycle: Math.round(D), steps: n, step: +(slowest * dt).toFixed(3), pace: median && +(median * 1000).toFixed(2),
    paceSpread: median ? +((speeds[speeds.length - 1] - speeds[0]) / median).toFixed(4) : null,
    maxStepSeen: speeds.length ? +(speeds[speeds.length - 1] * dt).toFixed(3) : null,
    longestUnseen: seenAny ? Math.max(0, ...transits) : null, transits, tolerance: Math.round(TRANSIT_MS + (median ? 2 / median : 0)),
    turnDeg: +((turn * 180) / Math.PI).toFixed(2), unseenSteps: loop.filter(f => !f.seen).length,
  };
}

/** After every sweep: each ring's trail points in runs by what they are, and the marked places. */
function report(marked) {
  const c = window.__cover;
  const kind = s => (s.what !== 'target' ? s.what : s.start ? 'target (start column)' : s.clearance ? 'target (clearance)' : 'target');
  const state = s => (s.peak >= 0.95 ? 'lit' : s.peak > 0.001 ? 'tail only' : 'never lit');
  /** Why a target point is not lit by the head: not in the light's clip; in it but never reached; reached only by the tail; or the head passed it faded out. */
  const cause = s => (!s.inClip ? 'clipped' : s.reach <= 0.001 ? 'never reached' : s.reach < 0.95 ? 'tail only' : 'faded head');
  const rings = c.lights.map(l => {
    const runs = [];
    let cur = null;
    for (const s of l.samples) {
      const k = kind(s);
      if (!cur || cur.trail !== s.trail || cur.what !== k) {
        cur = { r: l.r, trail: s.trail, what: k, from: s.angle, to: s.angle, a: [s.x, s.y], b: [s.x, s.y], points: 0, lit: 0, tail: 0, never: 0, fresh: 0, minPeak: 1, maxPeak: 0, minShow: 1 };
        runs.push(cur);
      }
      cur.to = s.angle; cur.b = [s.x, s.y]; cur.points++;
      if (s.what === 'target') {
        const st = state(s);
        if (st === 'lit') cur.lit++; else if (st === 'tail only') cur.tail++; else cur.never++;
        if (s.fresh) cur.fresh++;
        cur.minShow = Math.min(cur.minShow, s.show);
      }
      cur.minPeak = Math.min(cur.minPeak, s.peak); cur.maxPeak = Math.max(cur.maxPeak, s.peak);
    }
    for (const run of runs) {
      run.length = +(Math.abs(run.to - run.from) * l.r).toFixed(1);
      run.from = +run.from.toFixed(4); run.to = +run.to.toFixed(4);
      run.a = run.a.map(v => +v.toFixed(1)); run.b = run.b.map(v => +v.toFixed(1));
      run.minPeak = +run.minPeak.toFixed(3); run.maxPeak = +run.maxPeak.toFixed(3); run.minShow = run.what.startsWith('target') ? +run.minShow.toFixed(3) : null;
      run.headPassed = run.what.startsWith('target') ? run.lit === run.points : null;
    }
    const target = l.samples.filter(s => s.what === 'target'), required = target.filter(s => !s.clearance && !s.start);
    const causes = required.filter(s => s.peak < 0.95).reduce((n, s) => ({ ...n, [cause(s)]: (n[cause(s)] ?? 0) + 1 }), {});
    const fresh = required.filter(s => s.fresh);
    const shows = fresh.map(s => s.show).sort((a, b) => a - b);
    return {
      r: l.r, samples: l.samples.length, target: target.length, required: required.length,
      lit: required.filter(s => state(s) === 'lit').length, tail: required.filter(s => state(s) === 'tail only').length, never: required.filter(s => state(s) === 'never lit').length,
      clearance: target.filter(s => s.clearance).length, clearanceLit: target.filter(s => s.clearance && state(s) === 'lit').length, start: target.filter(s => s.start).length,
      fresh: fresh.length, freshLit: fresh.filter(s => state(s) === 'lit').length,
      freshMinPeak: fresh.length ? +Math.min(...fresh.map(s => s.peak)).toFixed(3) : null,
      freshShow: shows.length ? { min: +shows[0].toFixed(3), median: +shows[shows.length >> 1].toFixed(3) } : null,
      minPeak: required.length ? +Math.min(...required.map(s => s.peak)).toFixed(3) : null,
      causes,
      dark: required.filter(s => state(s) !== 'lit').slice(0, 20).map(s => ({ trail: s.trail, angle: +s.angle.toFixed(4), x: +s.x.toFixed(1), y: +s.y.toFixed(1), show: +s.show.toFixed(3), peak: +s.peak.toFixed(3), cause: cause(s), fresh: !!s.fresh })),
      runs,
      points: l.samples.filter(s => s.inClip || s.what === 'target').map(s => [+s.x.toFixed(1), +s.y.toFixed(1), s.what === 'target' ? (s.start ? 's' : s.clearance ? 'c' : 't') : 'x', +s.peak.toFixed(3), s.fresh ? 1 : 0]),
    };
  });
  const spots = marked ? marked.map(spot => {
    const l = c.lights.find(q => Math.abs(q.r - spot.r) < 0.05);
    const anchor = { x: c.pole.x + spot.dx, y: c.pole.y + spot.dy };
    const ss = l ? l.samples.filter(s => Math.hypot(s.x - anchor.x, s.y - anchor.y) <= 40) : [];
    const count = f => ss.filter(f).length;
    const why = {};
    for (const s of ss) if (s.what !== 'target') why[s.what] = (why[s.what] ?? 0) + 1;
    const req = s => s.what === 'target' && !s.clearance && !s.start;
    return { ...spot, lit: !!l, anchor: [+anchor.x.toFixed(1), +anchor.y.toFixed(1)], points: ss.length,
      notTarget: why, target: count(s => s.what === 'target'), clearance: count(s => s.what === 'target' && s.clearance),
      required: count(req), headPassed: count(s => req(s) && s.peak >= 0.95),
      tailOnly: count(s => req(s) && s.peak > 0.001 && s.peak < 0.95), never: count(s => req(s) && s.peak <= 0.001),
      fresh: count(s => req(s) && s.fresh),
      causes: ss.filter(s => req(s) && s.peak < 0.95).reduce((n, s) => ({ ...n, [cause(s)]: (n[cause(s)] ?? 0) + 1 }), {}) };
  }) : null;
  return { rings, spots };
}

/** Pause every head where the glass shows its trail fully, away from everything, as near the middle of its cycle as it can be. */
function heads() {
  const c = window.__cover, out = [];
  c.settle();
  for (const l of c.lights) {
    let best = null;
    if (l.flow) for (let i = 0; i <= 400; i++) {
      const u = i / 400;
      c.seekLight(l, u);
      const m = l.ribbon.getCTM(), p = k => new DOMPoint(l.r * Math.cos(k / l.r), l.r * Math.sin(k / l.r)).matrixTransform(m);
      const head = p(0), pts = [p(-3), head, p(6)];
      if (!pts.every(q => l.clip.isPointInFill(q))) continue;
      const show = c.showAt(head), clear = !c.front.some(b => c.inShape(head, b, 12)) && !c.inkAt(head, 10);
      const score = (clear ? 2 : 0) + Math.min(show, 1) - Math.abs(u - 0.5) * 0.1;
      if (!best || score > best.score) best = { u, score, show };
    }
    if (l.flow) c.seekLight(l, best?.u ?? 0.5);
    const head = new DOMPoint(l.r, 0).matrixTransform(l.ribbon.getScreenCTM());
    out.push({ r: l.r, u: best?.u ?? null, show: best ? +best.show.toFixed(3) : null, x: head.x, y: head.y });
  }
  return out;
}

/** Decode two PNG screenshots and find, round each head, the pixel the light changes most. */
async function headPixels([withLight, without, points, origin]) {
  const decode = async b64 => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, img.width, img.height);
  };
  const [a, b] = [await decode(withLight), await decode(without)];
  return points.map(p => {
    let best = null;
    const cx = Math.round(p.x - origin.x), cy = Math.round(p.y - origin.y);
    for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) {
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
      const i = (y * a.width + x) * 4, d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (!best || d > best.d) best = { d, rgb: [a.data[i], a.data[i + 1], a.data[i + 2]], under: [b.data[i], b.data[i + 1], b.data[i + 2]] };
    }
    return { r: p.r, show: p.show, ...best };
  });
}

/** The coverage map, in false colour, over the stage (the light hidden). */
function drawMap(rings) {
  const c = window.__cover, ns = 'http://www.w3.org/2000/svg', map = document.createElementNS(ns, 'svg');
  map.setAttribute('viewBox', `0 0 ${c.W} ${c.H}`);
  map.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:20';
  for (const ring of rings) for (const [x, y, what, peak, fresh] of ring.points) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    const lit = peak >= 0.95, tail = peak > 0.001 && !lit;
    let fill = '#7a7f87', r = 0.9;
    if (what === 't') { fill = lit ? (fresh ? '#22d3ee' : '#2bd96b') : tail ? '#ffd60a' : '#ff28a0'; r = lit ? 1.3 : 2.2; }
    else if (what === 'c' || what === 's') { fill = lit ? '#8fa8ff' : '#4a5a9a'; r = 1.1; }
    dot.setAttribute('r', String(r)); dot.setAttribute('fill', fill);
    map.append(dot);
  }
  c.root.style.visibility = 'hidden';
  c.stage.append(map);
}

/* ── In node ─────────────────────────────────────────────────────── */

/** rgb(…) or color(srgb …) as 0–255 channels. */
function rgbOf(css) {
  if (!css) return null;
  let m = css.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  m = css.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/);
  if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255];
  return null;
}
const near = (a, b, tol = 1.5) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));
const show = c => (c ? `rgb(${c.map(v => Math.round(v)).join(',')})` : 'none');
const hex = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
/** Hue (degrees) and HSV saturation and value: white mixed in lowers the saturation, whatever the background. */
function hsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), s = max ? (max - min) / max : 0;
  if (max === min) return { h: null, s, v: max / 255 };
  const h = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  return { h: h * 60, s, v: max / 255 };
}
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

async function still(browser, f) {
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const fail = [];
  const check = (ok, what) => { if (!ok) fail.push(what); };
  let row = { still: label(f), url: url(f), signal: 'demo', fail };
  try {
    await page.goto(url(f), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const set = await page.evaluate(setUp);
    if (set.error) { check(set.error === 'no light' && f.w < 1000, set.error); return { ...row, lights: 0 }; }
    // The two probe stills, then what every trail point is.
    const clip = { x: Math.floor(set.stage.left), y: Math.floor(set.stage.top), width: Math.ceil(set.stage.w) + 2, height: Math.ceil(set.stage.h) + 2 };
    await page.evaluate(probeOn, 'mask');
    const maskPng = await page.screenshot({ clip });
    await page.evaluate(probeOff);
    let inkPng = null;
    if (set.etch) { await page.evaluate(probeOn, 'ink'); inkPng = await page.screenshot({ clip }); await page.evaluate(probeOff); }
    const where = await page.evaluate(classify, [maskPng.toString('base64'), inkPng?.toString('base64') ?? null, { x: clip.x, y: clip.y }]);
    const motion = [];
    for (let i = 0; i < set.lights.length; i++) motion.push(await page.evaluate(sweep, i));
    const marked = label(f) === MARKED.still ? MARKED.spots : null;
    const { rings, spots } = await page.evaluate(report, marked);
    // The heads where the glass shows them: one still with the light, one without it, compared round every head.
    const at = await page.evaluate(heads);
    await page.waitForTimeout(60);
    const withLight = await page.screenshot({ clip });
    await page.evaluate(() => { window.__cover.root.style.visibility = 'hidden'; });
    const without = await page.screenshot({ clip });
    await page.evaluate(() => { window.__cover.root.style.visibility = ''; });
    const pixels = await page.evaluate(headPixels, [withLight.toString('base64'), without.toString('base64'), at, { x: clip.x, y: clip.y }]);
    const accent = hex(f.accent), own = hsv(accent);
    const colour = pixels.map(p => { const c = hsv(p.rgb); return { ...p, ...c, gap: c.h === null ? 180 : hueGap(c.h, own.h), kept: c.s / own.s }; });
    if (shots) {
      const name = label(f).replace(/[ =]/g, '-');
      writeFileSync(join(shots, `${name}-truecolour-heads.png`), withLight);
      writeFileSync(join(shots, `${name}-probe-mask.png`), maskPng);
      if (inkPng) writeFileSync(join(shots, `${name}-probe-ink.png`), inkPng);
      await page.evaluate(drawMap, rings);
      await page.screenshot({ clip, path: join(shots, `${name}-falsecolour-coverage.png`) });
    }

    for (const e of errors) check(false, `page error: ${e}`);
    check(set.flow === 'run', `light ${set.flow}`);
    check(set.lights.length > 0 || f.w < 1000, 'no light');
    check(set.maskMismatch.length === 0, `the light's mask differs from the sky's: ${set.maskMismatch.join(', ')}`);
    check(set.filters === 0, `${set.filters} elements of the light have a filter`);
    check(where.outsideCount === 0, `light can show where it should not at ${where.outsideCount} points: ${where.outside.slice(0, 3).map(o => `${o.why} r=${o.r} ${o.x.toFixed(0)},${o.y.toFixed(0)}`).join('; ')}`);
    for (const ring of rings) {
      const dark = ring.runs.filter(run => run.what === 'target' && !run.headPassed);
      check(ring.never === 0 && ring.tail === 0, `ring ${ring.r}: ${ring.never} target points never lit, ${ring.tail} only by the tail (${dark.slice(0, 3).map(d => `trail ${d.trail} ${d.a.join(',')}→${d.b.join(',')} ${d.length}px peak ${d.minPeak}`).join('; ')})`);
    }
    for (const m of motion) {
      if (m.error) { check(false, `ring ${m.r}: ${m.error}`); continue; }
      check(Math.abs(Math.abs(m.turnDeg) - 360) < 1, `ring ${m.r}: turns ${m.turnDeg}° a cycle, not a whole turn`);
      check(m.paceSpread !== null && m.paceSpread <= 0.03, `ring ${m.r}: the head's speed in its windows varies by ${(m.paceSpread * 100).toFixed(1)}%`);
      check(m.maxStepSeen !== null && m.maxStepSeen <= 2, `ring ${m.r}: the head steps ${m.maxStepSeen}px in a window`);
      check(m.longestUnseen !== null && m.longestUnseen <= m.tolerance, `ring ${m.r}: none of it seen for ${m.longestUnseen} ms (at most ${m.tolerance})`);
    }
    // Colours: the tail the accent; the head the field's peak (with a quarter white on the papers); the glow the accent's light tint.
    const cs = set.colours, fill = rgbOf(cs.accentFill), arc = rgbOf(cs.vizArc), hi = rgbOf(cs.accentHi);
    const head = f.theme === 'charcoal' ? arc : mix(arc, [255, 255, 255], 0.75);
    if (cs.peakMark) check(near(rgbOf(cs.peakMark), arc), `the field's peak mark is ${cs.peakMark}, not --viz-arc ${cs.vizArc}`);
    for (const l of set.lights) {
      const [s0, s1, s2] = l.stops;
      check(l.stops.length === 3 && near(rgbOf(s0.color), fill) && near(rgbOf(s1?.color), fill), `ring ${l.r}: tail ${l.stops.map(s => s.color).join(' → ')}, not the accent ${cs.accentFill}`);
      check(near(rgbOf(s2?.color), head), `ring ${l.r}: head ${s2?.color}, not the peak's colour ${show(head)}`);
      check(l.glow && l.glowGradient, `ring ${l.r}: no glow on the head`);
    }
    check(set.glowStops.length === 3 && set.glowStops.every(s => near(rgbOf(s.color), hi)) && Number(set.glowStops[2]?.opacity) === 0, `glow ${set.glowStops.map(s => s.color).join(' → ') || 'none'}, not the accent's light tint ${cs.accentHi} fading to nothing`);
    // A head where the glass dims its trail (behind the text, near the memorial) is dimmed with it: its pixel is judged only where the trail shows fully.
    for (const c of colour) {
      check(c.d > 30, `ring ${c.r}: no head to be seen at its paused point`);
      if (!(c.show >= 0.9)) continue;
      check(c.gap <= 15, `ring ${c.r}: head rgb(${c.rgb.join(',')}) is ${c.gap.toFixed(0)}° from the accent's hue`);
      check(c.kept >= 0.15, `ring ${c.r}: head rgb(${c.rgb.join(',')}) keeps ${(c.kept * 100).toFixed(0)}% of the accent's saturation (reads white)`);
    }
    check(set.nodes <= 8 + 14 * set.lights.length, `${set.nodes} SVG nodes for ${set.lights.length} lights`);
    const sum = k => rings.reduce((n, r) => n + (r[k] ?? 0), 0);
    row = {
      ...row, stage: `${Math.round(set.stage.w)}x${Math.round(set.stage.h)}`, pole: set.pole, nodes: set.nodes, flow: set.flow,
      easing: [...new Set(set.easing.map(e => (e.startsWith('linear(') ? 'linear()' : e)))],
      lights: set.lights.length, windows: set.lights.reduce((n, l) => n + (l.windows ?? 1), 0),
      target: sum('target'), required: sum('required'), lit: sum('lit'), tail: sum('tail'), never: sum('never'),
      clearance: sum('clearance'), clearanceLit: sum('clearanceLit'), start: sum('start'), fresh: sum('fresh'), freshLit: sum('freshLit'),
      freshMinPeak: Math.min(1, ...rings.map(r => r.freshMinPeak ?? 1)), minPeak: Math.min(1, ...rings.map(r => r.minPeak ?? 1)),
      outside: where.outsideCount, pastEdge: where.pastEdge, colours: cs,
      heads: colour.map(c => ({ r: c.r, show: c.show, judged: c.show >= 0.9, rgb: c.rgb, under: c.under, hue: c.h === null ? null : +c.h.toFixed(1), hueGap: +c.gap.toFixed(1), saturation: +c.s.toFixed(3), kept: +c.kept.toFixed(3) })),
      motion, rings: rings.map(({ points, ...r }) => r), spots, fail,
    };
  } catch (e) {
    fail.push(`error: ${e.message} (${(e.stack ?? '').split('\n').slice(1, 3).map(l => l.trim()).join(' ← ')})`);
  } finally {
    await page.close();
  }
  return row;
}

async function state(browser, s) {
  const f = { theme: 'charcoal', shot: 'stage-ja-long', w: 1360, h: 800, accent: ACCENT, viz: 'pulse', extra: s.q };
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h } });
  if (s.media) await page.emulateMedia(s.media);
  const fail = [];
  const check = (ok, what) => { if (!ok) fail.push(what); };
  try {
    await page.goto(url(f), { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const read = () => page.evaluate(() => {
      const root = document.querySelector('[data-ambient="stage"]');
      if (!root) return null;
      const beams = root.querySelector('g[class*="beams"]');
      return {
        flow: root.dataset.flow, opacity: beams ? Number(getComputedStyle(beams).opacity) : null,
        turns: [...root.querySelectorAll('[data-meteor]')].map(m => getComputedStyle(m).transform),
        glows: root.querySelectorAll('[data-meteor] ellipse[data-glow]').length,
        running: root.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && a.animationName.includes('trailFlow')).length,
        // Each head where it rests or holds: in a window, so the light is seen.
        heads: [...root.querySelectorAll('g[data-trail]')].map(g => {
          const ribbon = g.querySelector('[data-meteor] path'), r = +g.querySelector('[data-light-path]').getAttribute('d').match(/A([\d.]+)/)[1];
          return g.querySelector('clipPath path').isPointInFill(new DOMPoint(r, 0).matrixTransform(ribbon.getCTM()));
        }),
      };
    });
    const first = await read();
    await page.waitForTimeout(s.flow === 'hold' ? 2600 : 700);
    const later = await read();
    if (s.flow === null) check(first === null && later === null, 'light drawn in forced colours');
    else {
      check(later?.flow === s.flow, `flow ${later?.flow}, not ${s.flow}`);
      check(later.glows === later.heads.length, `${later.glows} glows for ${later.heads.length} heads`);
      if (s.flow === 'run') check(later.running > 0 && later.turns.some((t, i) => t !== first.turns[i]), 'not moving while playing');
      if (s.flow === 'hold') {
        check(later.running === 0 && later.turns.every((t, i) => t === first.turns[i]), 'moving while held');
        check(Math.abs(later.opacity - 0.3) < 0.02, `held light at ${later.opacity}, not dimmed to 0.3`);
      }
      if (s.flow === 'still') {
        check(later.running === 0 && later.turns.every((t, i) => t === first.turns[i]), 'moving with reduced motion');
        check(later.heads.length > 0 && later.heads.every(Boolean), 'a resting head outside its windows');
      }
    }
    return { state: s.name, url: url(f), flow: later?.flow ?? null, opacity: later?.opacity ?? null, lights: later?.heads.length ?? 0, fail };
  } catch (e) {
    return { state: s.name, url: url(f), fail: [`error: ${e.message}`] };
  } finally {
    await page.close();
  }
}

if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
const todo = STILLS.filter(f => !only || label(f).includes(only));
const results = new Array(todo.length);
let next = 0;
const worst = (r, k) => (r.motion?.length ? Math.max(...r.motion.map(m => m[k] ?? 0)) : '—');
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  while (next < todo.length) {
    const i = next++;
    results[i] = await still(browser, todo[i]);
    // A still that broke off (not one that failed a check) is taken once more, and says so.
    if (results[i].fail.some(f => f.startsWith('error:'))) results[i] = { ...(await still(browser, todo[i])), retried: results[i].fail.join('; ') };
    const r = results[i];
    console.log(`${r.fail.length ? 'FAIL' : 'ok  '} ${r.still.padEnd(48)} stage ${r.stage ?? '—'} lights ${r.lights ?? '—'} target ${r.required ?? '—'} lit ${r.lit ?? '—'} tail ${r.tail ?? '—'} never ${r.never ?? '—'} clearance ${r.clearance ?? '—'} new ${r.fresh ?? '—'}/${r.freshLit ?? '—'} cycle≤${worst(r, 'cycle')} unseen≤${worst(r, 'longestUnseen')}ms pace±${r.motion?.length ? (Math.max(...r.motion.map(m => m.paceSpread ?? 0)) * 100).toFixed(1) : '—'}% nodes ${r.nodes ?? '—'} heads ${r.heads?.some(h => h.judged) ? Math.max(...r.heads.filter(h => h.judged).map(h => h.hueGap)).toFixed(0) + '° ' + (Math.min(...r.heads.filter(h => h.judged).map(h => h.kept)) * 100).toFixed(0) + '–' + (Math.max(...r.heads.filter(h => h.judged).map(h => h.kept)) * 100).toFixed(0) + '%' : '—'}${r.fail.length ? '  ← ' + r.fail.join('; ') : ''}`);
  }
}));
const states = [];
if (!only) for (const s of STATES) {
  const r = await state(browser, s);
  states.push(r);
  console.log(`${r.fail.length ? 'FAIL' : 'ok  '} state ${r.state.padEnd(15)} flow ${r.flow ?? 'none'}${r.opacity !== null && r.opacity !== undefined ? ` opacity ${r.opacity}` : ''}${r.fail.length ? '  ← ' + r.fail.join('; ') : ''}`);
}
await browser.close();

const failing = results.filter(r => r.fail.length).length + states.filter(r => r.fail.length).length;
const all = results.flatMap(r => r.motion ?? []).filter(m => !m.error);
const total = k => results.reduce((n, r) => n + (r[k] ?? 0), 0);
const summary = {
  stills: results.length, states: states.length, failing, retried: results.filter(r => r.retried).length,
  target: total('required'), lit: total('lit'), tailOnly: total('tail'), neverLit: total('never'),
  causes: results.flatMap(r => r.rings ?? []).reduce((n, ring) => { for (const [k, v] of Object.entries(ring.causes ?? {})) n[k] = (n[k] ?? 0) + v; return n; }, {}),
  clearance: total('clearance'), clearanceLit: total('clearanceLit'), startColumn: total('start'), newInRound4: total('fresh'), newLit: total('freshLit'),
  newMinPeak: Math.min(1, ...results.map(r => r.freshMinPeak ?? 1)),
  cycles: all.length ? { min: Math.min(...all.map(m => m.cycle)), max: Math.max(...all.map(m => m.cycle)) } : null,
  longestUnseen: all.length ? Math.max(...all.map(m => m.longestUnseen ?? 0)) : null, maxPaceSpread: all.length ? Math.max(...all.map(m => m.paceSpread ?? 0)) : null,
  maxStepSeen: all.length ? Math.max(...all.map(m => m.maxStepSeen ?? 0)) : null,
  maxLights: Math.max(0, ...results.map(r => r.lights ?? 0)), maxWindows: Math.max(0, ...results.map(r => r.windows ?? 0)), maxNodes: Math.max(0, ...results.map(r => r.nodes ?? 0)),
  headsJudged: results.flatMap(r => (r.heads ?? []).filter(h => h.judged)).length, headsDimmed: results.flatMap(r => (r.heads ?? []).filter(h => !h.judged)).length,
  maxHeadHueGap: Math.max(0, ...results.flatMap(r => (r.heads ?? []).filter(h => h.judged).map(h => h.hueGap))),
  headSaturationKept: { min: Math.min(1, ...results.flatMap(r => (r.heads ?? []).filter(h => h.judged).map(h => h.kept))), max: Math.max(0, ...results.flatMap(r => (r.heads ?? []).filter(h => h.judged).map(h => h.kept))) },
  easing: [...new Set(results.flatMap(r => r.easing ?? []))],
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ base, signal: 'demo', summary, stills: results, states }, null, 2));
console.log(`\n${results.length} stills, ${states.length} states, ${failing} failing${summary.retried ? ` (${summary.retried} taken twice after breaking off)` : ''}; ${summary.target} target points: ${summary.lit} lit by the head, ${summary.tailOnly} only by the tail, ${summary.neverLit} never; ${summary.clearance} in clearance (${summary.clearanceLit} lit), ${summary.startColumn} in the start column; ${summary.newInRound4} new in round 4 (${summary.newLit} lit, dimmest peak ${summary.newMinPeak}); cycles ${summary.cycles?.min}–${summary.cycles?.max} ms, longest unseen ${summary.longestUnseen} ms, pace spread ${((summary.maxPaceSpread ?? 0) * 100).toFixed(1)}%, largest step seen ${summary.maxStepSeen}px; at most ${summary.maxLights} lights, ${summary.maxWindows} windows, ${summary.maxNodes} nodes; ${summary.headsJudged} heads where the trail shows fully within ${summary.maxHeadHueGap.toFixed(1)}° of the accent's hue, keeping ${(summary.headSaturationKept.min * 100).toFixed(0)}–${(summary.headSaturationKept.max * 100).toFixed(0)}% of its saturation`);
process.exit(failing ? 1 : 0);

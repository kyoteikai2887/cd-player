import type { PlayerSnapshot } from '../../contracts/player.ts';

/**
 * The stage's cold light (Claude, V1.2 round 2): a little starlight flowing along a few of the
 * etched star trails (components/StarTrails.tsx), the way the sky turns round the pole in a long
 * exposure. The trails themselves never move and are never redrawn; the light runs in their
 * grooves, so which trails carry it follows the stage's actual size and contents.
 *
 * Star-trail fix (V1.2): a light belongs to a ring, every etched trail of one radius, not to one
 * stretch of one trail, so no stretch of a lit ring stays dark.
 *
 * Star-trail completion (V1.2, round 4): a light shows wherever its ring's etched trails are seen.
 * The rings are chosen as before (round 2's clearances, keepShapes), so the composition stays; each
 * light then covers every stretch of its ring that is visible on the glass: out to the stage's own
 * edge (its rounded corners clip the light and the trails alike), and through the soft cut round
 * the memorial etching (the light wears the sky's own mask, Spotlight.module.css). It keeps clear
 * only of what stands in front of the trails: the text, the controls, the cover, the music field,
 * and the memorial's figures and caption (lightGlass). No sliver is left out. Each cycle the light
 * turns a whole turn, at an even pace wherever any of it can be seen and in a short moment across
 * the glass where none of it can (lightSchedule), so every stretch gets the bright head, however
 * far apart they are.
 *
 * Decoration, not a meter: the light never reads the signal. It flows while the music is heard
 * and holds, dimmed, when it is paused, buffering, muted or at zero volume.
 *
 * Plain arithmetic, tested without a DOM; components/TrailLight.tsx measures the stage and draws.
 */

export interface TrailArc { r: number; a0: number; a1: number }
export interface Box { x: number; y: number; w: number; h: number }
/** An oval to keep clear of, such as the soft cut round the memorial etching. */
export interface Ellipse { cx: number; cy: number; rx: number; ry: number }
export interface Point { x: number; y: number }

/** A stretch of trail `index` the light shows in, from angle `from` down to `to` (radians, `to` < `from`; `length` in px). */
export interface LightWindow { index: number; from: number; to: number; length: number }

/**
 * One light, on the ring of radius `r`. `index`, `from`, `to` and `length` are its main stretch,
 * the one that chose the ring (its tail's length, its pace and its resting place follow it). It
 * shows only in `windows`: every stretch of every trail of radius `r` that is seen on the glass, in
 * the order it meets them going round from `start` down to `end` (all angles on that one run:
 * `start` >= every `from`, `end` <= every `to`; the ring's widest stretch with nothing seen is
 * outside it).
 */
export interface LightArc extends LightWindow { r: number; start: number; end: number; windows: LightWindow[] }

/**
 * What the stage marks with `data-keep-clear`, as components/TrailLight.tsx measures it, in the
 * stage's own pixels: a box by default; "text" with the `lines` actually set (each within its box);
 * "before", the track, the facts, the buttons and the music field; "start", the text column (the
 * cover and its disc are before it); "etch", the memorial etching's box.
 */
export type KeepKind = 'box' | 'text' | 'before' | 'start' | 'etch';
export interface KeepItem { kind: KeepKind; box: Box; lines?: Box[] }

export interface LightOptions {
  /** At most this many lights. */
  count: number;
  /** A ring whose longest free stretch is shorter than this (px) is left dark: too short to read as flowing. */
  minLength: number;
  /** Rings nearer the pole than this are left dark (a light circling there would look like a spinner). */
  minRadius: number;
  maxRadius: number;
  /** Round 2's clearances, now only for choosing the rings: round every shape of keepShapes, and from the stage's edges and rounded corners (px). */
  pad: number;
  edge: number;
  /** Two lights never run on rings closer than this (px), or than `gapRatio` of the radius further
      out (long arcs side by side read as one double line), so they read as separate. */
  minGap: number;
  gapRatio: number;
}

export const LIGHT_OPTIONS: LightOptions = { count: 6, minLength: 40, minRadius: 34, maxRadius: 1000, pad: 14, edge: 14, minGap: 12, gapRatio: 0.12 };

/** Wide stages have room for two more trails, including the outermost etched rings. */
export function lightOptionsForStage(stage: Box): LightOptions {
  return stage.w >= 1400 ? { ...LIGHT_OPTIONS, count: 8, maxRadius: 1240 } : LIGHT_OPTIONS;
}

/** Up to NEAR_LIGHTS lights go first to rings within NEAR_POLE of the pole, where the turning reads best. */
const NEAR_POLE = 120, NEAR_LIGHTS = 3;
/** The ends of a stretch are found to this (px); its clipping window reaches this much further at each end, so no point of it is missed. */
const EDGE_PRECISION = 0.01, WINDOW_OVERLAP = 0.1;
/**
 * Round 4: how far the light keeps from what stands in front of the trails (px). From the text,
 * the controls, the cover and the music field: the head's glow (GLOW.across) and a little more, so
 * the glow never touches a letter or a button. From the memorial's figures and caption: the glow
 * and a pixel (the sky's mask has already thinned the trails there).
 */
export const CLEAR = 8, ETCH_CLEAR = 6;

/**
 * The memorial etching's figures and caption, as its images ink them (assets/memorial/memorial-etch
 * and -etch-cut .webp, the walls and the floor, 422×336, alpha over 8/255; -etch-light inks less),
 * in the etching's own pixels: for every column 2px wide, the rows it is inked over, as runs
 * 'top-bottom' (gaps of up to 14 rows bridged, far less than the clearance round them), ',' between
 * runs, '-' for none. At the etching's size (112px tall, a third of its pixels) the 6px round these
 * runs is the 6px round the ink to within 0.6px. The empty corners of the etching's box, the gap
 * between the two figures, the hollows in their outline and the gap above the caption are
 * glass the trails show through.
 */
const MEMORIAL = {
  w: 422, h: 336, column: 2,
  ink: '295-304 294-306 204-232,294-306 197-235,294-306 194-238,295-306 191-239 188-242,294-306 186-245,294-306 '
    + '184-248,294-306 86-124,182-250,294-306 82-127,180-252,295-306 79-130,178-254,296-305 76-132,177-255,299-303 '
    + '73-110,130-133,162-256 71-134,161-256 68-132,162-256 66-135,163-256 64-137,164-251,294-306 '
    + '62-140,164-252,294-306 60-141,164-264,294-306 58-142,163-265,295-302 56-265,296-301 55-136,152-265,295-305 '
    + '53-264,294-306 52-263,294-306 50-261,294-306 49-261,302-306 48-258,302-306 47-256 32-256,301-306 29-257,296-306 '
    + '27-259,294-306 26-260,294-306 24-261,298-306 22-261,303-306 21-261,294-306 19-260,294-299 18-259,294-306 '
    + '17-258,296-306 17-257,294-306 16-257,294-300 16-256,295-297 16-256,295-305 16-255,294-306 17-255,294-306 '
    + '18-262,294-306 20-264,294-306 24-264,295-306 34-264 32-263,294-306 30-266,294-306 10-267,294-306 10-267,294-306 '
    + '11-267,295-306 12-266,304-306 14-266 17-265 24-264 30-263,295-295 39-263,294-298 40-262,294-303 '
    + '10-10,41-261,294-306 9-13,41-259,295-306 9-18,34-256,294-304 10-263,294-299 11-263,296-296 12-262,296-305 '
    + '14-261,295-306 16-259,294-306 19-257,296-306 22-255,305-306 27-253,304-305 34-253,303-306 52-253,303-306 54-252 '
    + '56-252,295-304 59-251,294-306 62-251,294-306 65-250,295-306 71-249,299-304 75-256 92-257 94-257 95-257 '
    + '97-256,299-301 99-126,142-255,298-302 100-126,149-254,299-302 102-125,150-256 104-124,150-257 107-123,150-256 '
    + '110-121,150-255 114-117,149-253,297-303 148-157,172-229,244-249,295-304 146-156,174-227,294-306 '
    + '143-154,177-224,294-306 140-152,181-200,215-216,294-306 140-149,186-197,294-306 304-305 296-303 295-306 294-306 '
    + '294-306 294-306 295-306 300-303 295-305 294-306 294-306 294-306 294-306 295-306 301-304 295-305 187-194,294-306 '
    + '181-200,236-241,294-306 152-203,232-241,294-306 147-205,227-241,294-306 143-207,223-241,295-306 140-240,305-305 '
    + '118-120,136-240,294-306 113-240,294-306 110-240,294-306 90-242,294-306 88-243,294-306 64-68,86-244,295-306 '
    + '63-246 61-247 60-248 59-249 58-250 56-251,296-304 53-250,297-304 45-262,297-304 35-263,296-304 34-263 34-263 '
    + '34-263 34-263 34-263,300-300 34-263,296-304 35-263,295-306 34-263,294-306 32-263,294-306 31-263,294-306 '
    + '29-262,297-306 28-261,295-305 26-259,294-306 25-257,294-306 24-256,294-306 23-255,302-306 22-253,302-306 '
    + '21-253,305-305 20-253,301-306 19-253,296-306 19-253,294-306 18-253,294-306 17-254,298-306 17-254,303-306 '
    + '17-254,305-306 16-254,294-304 16-254,294-306 16-254,294-306 16-254,295-306 16-254,294-306 16-254,294-305 '
    + '17-254,296-296 17-254,294-306 17-254,294-306 18-253,294-306 18-253,294-306 18-252,295-306 17-252,296-305 '
    + '17-252,300-303 17-255,295-306 17-257,294-306 17-258,294-306 17-260,294-306 17-260,294-306 18-261,296-306 18-262 '
    + '18-262 19-262 20-262 20-262,299-300 23-262,298-302 31-262,299-302 31-262 32-261 34-128,144-261 36-126,146-260 '
    + '38-124,147-259,304-304 40-122,150-151,170-258,294-306 43-118,172-258,294-306 45-118,174-258,294-306 '
    + '48-117,176-258,295-306 51-117,177-257 54-120,179-256,296-304 57-121,181-256,294-306 61-121,183-255,294-306 '
    + '66-119,185-253,295-306 71-117,188-252,297-305 75-112,190-250,296-305 192-248,294-306 195-245,294-306 '
    + '199-243,294-306 205-222,237-243,295-306 211-242 214-241,296-304 217-240,294-306 221-238,294-306 225-234,294-306',
} as const;
const INK = MEMORIAL.ink.split(' ').map(c => (c === '-' ? [] : c.split(',').map(run => run.split('-').map(Number) as [number, number])));
/**
 * The soft cut round the etching (Spotlight.module.css .sky): an oval 28px wider and 22px taller
 * than the etching on each side, the trails fading in from 62% of the way out. Within that, nothing
 * of the trails is seen.
 */
const CUT = { x: 28, y: 22, gone: 0.62 } as const;

function inside(p: Point, b: Box | Ellipse): boolean {
  if ('rx' in b) return ((p.x - b.cx) / b.rx) ** 2 + ((p.y - b.cy) / b.ry) ** 2 <= 1;
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
function grow(b: Box | Ellipse, by: number): Box | Ellipse {
  if ('rx' in b) return { cx: b.cx, cy: b.cy, rx: b.rx + by, ry: b.ry + by };
  return { x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 };
}
const empty = (b: Box | Ellipse) => ('rx' in b ? !(b.rx > 0 && b.ry > 0) : !(b.w > 0 && b.h > 0));
const TURN = Math.PI * 2;

/**
 * Round 2's shapes, now only for choosing the rings (so the composition stays): text keeps the
 * glass above its lines dark too, up to the stage's top; "before" all of the stage's height up to
 * the element's right edge; "start" all of it before the element; the etching the oval cut round it.
 */
export function keepShapes(items: readonly KeepItem[], stage: Box): (Box | Ellipse)[] {
  return items.flatMap(({ kind, box, lines }): (Box | Ellipse)[] => {
    if (kind === 'text') return (lines?.length ? lines : [box]).map(l => ({ x: l.x, y: stage.y, w: l.w, h: l.y + l.h - stage.y }));
    if (kind === 'before') return [{ x: stage.x, y: stage.y, w: box.x + box.w - stage.x, h: stage.h }];
    if (kind === 'start') return [{ x: stage.x, y: stage.y, w: box.x - stage.x, h: stage.h }];
    if (kind === 'etch') return [{ cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2 + CUT.x, ry: box.h / 2 + CUT.y }];
    return [box];
  });
}

/**
 * Round 4: what stands in front of the trails, where the light keeps clear (by CLEAR): the lines
 * of text actually set, the eyebrow, the track, the facts, the buttons, the music field, and all
 * of the stage before the text column (the cover and its disc); and the memorial etching
 * (`memorial`, its box: its figures and caption, by ETCH_CLEAR, and the middle of the cut round it).
 */
export interface LightGlass { content: Box[]; memorial: Box | null }
export function lightGlass(items: readonly KeepItem[], stage: Box): LightGlass {
  const content: Box[] = [];
  let memorial: Box | null = null;
  for (const { kind, box, lines } of items) {
    if (kind === 'text') content.push(...(lines?.length ? lines : [box]));
    else if (kind === 'start') content.push({ x: stage.x, y: stage.y, w: box.x - stage.x, h: stage.h });
    else if (kind === 'etch') memorial = box;
    else content.push(box);
  }
  return { content, memorial };
}

/** Whether a point is within `by` px of the memorial's figures or caption, or in the middle of the cut round it; `m` is the etching's box. */
function onMemorial(m: Box, by: number): (p: Point) => boolean {
  const scale = m.h / MEMORIAL.h, reach = by / scale;
  const cut: Ellipse = { cx: m.x + m.w / 2, cy: m.y + m.h / 2, rx: (m.w / 2 + CUT.x) * CUT.gone, ry: (m.h / 2 + CUT.y) * CUT.gone };
  return p => {
    if (inside(p, cut)) return true;
    const x = (p.x - m.x) / scale, y = (p.y - m.y) / scale;   // in the etching's own pixels
    if (x < -reach || x > MEMORIAL.w + reach || y < -reach || y > MEMORIAL.h + reach) return false;
    const c0 = Math.max(0, Math.floor((x - reach) / MEMORIAL.column)), c1 = Math.min(INK.length - 1, Math.floor((x + reach) / MEMORIAL.column));
    for (let c = c0; c <= c1; c++) {
      const dx = Math.max(c * MEMORIAL.column - x, 0, x - (c + 1) * MEMORIAL.column);
      for (const [top, bottom] of INK[c]) {
        const dy = Math.max(top - y, 0, y - (bottom + 1));
        if (dx * dx + dy * dy <= reach * reach) return true;
      }
    }
    return false;
  };
}

/**
 * Every stretch of a trail's own arc for which `free` holds, as [low, high] angles: sampled at a
 * third of round 2's spacing (a degree, or 3px further out), then each end found to EDGE_PRECISION
 * on its free side. `best` is the longest stretch as round 2 measured it, on its own samples (every
 * third of these, ends not refined), so the same rings are chosen as before.
 */
function scanTrail(t: TrailArc, free: (a: number) => boolean): { stretches: [number, number][]; best: [number, number] | null } {
  const coarse = Math.max(1, Math.ceil((t.a1 - t.a0) / Math.min(Math.PI / 180, 3 / t.r))), n = coarse * 3;
  const at = (k: number) => (k % 3 === 0 ? t.a0 + ((t.a1 - t.a0) * (k / 3)) / coarse : t.a0 + ((t.a1 - t.a0) * k) / n);
  const edge = (yes: number, no: number) => {
    while (Math.abs(no - yes) * t.r > EDGE_PRECISION) { const m = (yes + no) / 2; if (free(m)) yes = m; else no = m; }
    return yes;
  };
  const stretches: [number, number][] = [];
  let best: [number, number] | null = null, start: number | null = null, from: number | null = null, prev = t.a0;
  for (let k = 0; k <= n; k++) {
    const a = at(k), is = free(a);
    if (is && start === null) start = k === 0 ? t.a0 : edge(a, at(k - 1));
    else if (!is && start !== null) { stretches.push([start, edge(at(k - 1), a)]); start = null; }
    if (k % 3) continue;
    if (is) { if (from === null) from = a; prev = a; }
    else if (from !== null) { if (!best || prev - from > best[1] - best[0]) best = [from, prev]; from = null; }
  }
  if (start !== null) stretches.push([start, t.a1]);
  if (from !== null && (!best || t.a1 - from > best[1] - best[0])) best = [from, t.a1];
  return { stretches, best };
}

/**
 * The lights. A few well-separated rings carry one, the first ones near the pole, chosen by their
 * longest stretch clear of keepShapes in the stage less round 2's clearances (so the same rings as
 * before); each light then shows in every stretch of its ring that is seen (see LightArc and
 * lightGlass). Deterministic.
 */
export function chooseLightArcs(trails: readonly TrailArc[], pole: Point, stage: Box, items: readonly KeepItem[],
  options: LightOptions = lightOptionsForStage(stage)): LightArc[] {
  const { edge, pad } = options;
  const bounds: Box = { x: stage.x + edge, y: stage.y + edge, w: stage.w - edge * 2, h: stage.h - edge * 2 };
  if (!(bounds.w > 0 && bounds.h > 0)) return [];
  const keep = keepShapes(items, stage).filter(b => !empty(b)).map(b => grow(b, pad));
  // The rounded corners: a square of the edge clearance again in each corner stays dark.
  const c = edge * 2;
  keep.push({ x: bounds.x, y: bounds.y, w: c, h: c }, { x: bounds.x + bounds.w - c, y: bounds.y, w: c, h: c },
    { x: bounds.x, y: bounds.y + bounds.h - c, w: c, h: c }, { x: bounds.x + bounds.w - c, y: bounds.y + bounds.h - c, w: c, h: c });
  // Which shapes a ring of radius r can meet at all: those whose nearest and farthest points from the pole lie either side of it.
  const span = (b: Box | Ellipse) => {
    const box = 'rx' in b ? { x: b.cx - b.rx, y: b.cy - b.ry, w: b.rx * 2, h: b.ry * 2 } : b;
    const dx = Math.max(box.x - pole.x, 0, pole.x - box.x - box.w), dy = Math.max(box.y - pole.y, 0, pole.y - box.y - box.h);
    return { b, near: Math.hypot(dx, dy), far: Math.hypot(Math.max(pole.x - box.x, box.x + box.w - pole.x), Math.max(pole.y - box.y, box.y + box.h - pole.y)) };
  };
  const spans = keep.map(span), reach = span(bounds).far;
  type Candidate = { index: number; r: number; rank: number; best: [number, number] };
  const candidates: Candidate[] = [];
  trails.forEach((t, index) => {
    // No ring wider than the pole's distance to the stage's farthest corner can show.
    if (t.r < options.minRadius || t.r > options.maxRadius || t.r > reach) return;
    const near = spans.filter(s => s.near <= t.r && t.r <= s.far).map(s => s.b);
    const free = (a: number) => {
      const p = { x: pole.x + t.r * Math.cos(a), y: pole.y + t.r * Math.sin(a) };
      return inside(p, bounds) && !near.some(b => inside(p, b));
    };
    const { best } = scanTrail(t, free);
    const rank = best ? (best[1] - best[0]) * t.r : 0;
    if (best && rank >= options.minLength) candidates.push({ index, r: t.r, rank, best });
  });
  const picked: Candidate[] = [];
  const take = (pool: Candidate[], limit: number) => {
    for (const arc of [...pool].sort((a, b) => b.rank - a.rank || a.r - b.r)) {
      if (picked.length >= limit) break;
      if (picked.some(p => p.index === arc.index
        || Math.abs(p.r - arc.r) < Math.max(options.minGap, options.gapRatio * Math.max(p.r, arc.r)))) continue;
      picked.push(arc);
    }
  };
  take(candidates.filter(a => a.r <= NEAR_POLE), Math.min(NEAR_LIGHTS, options.count));
  take(candidates, options.count);

  // Where each chosen ring is seen: in the stage, clear of what stands in front of its trails.
  const glass = lightGlass(items, stage);
  const content = glass.content.filter(b => !empty(b)).map(b => span(grow(b, CLEAR)));
  const memorial = glass.memorial && !empty(glass.memorial)
    ? { ...span(grow(glass.memorial, ETCH_CLEAR)), on: onMemorial(glass.memorial, ETCH_CLEAR) } : null;
  return picked.sort((a, b) => a.r - b.r).map(chosen => {
    const r = chosen.r, near = content.filter(s => s.near <= r && r <= s.far).map(s => s.b);
    const etch = memorial && memorial.near <= r && r <= memorial.far ? memorial.on : null;
    const seen = (a: number) => {
      const p = { x: pole.x + r * Math.cos(a), y: pole.y + r * Math.sin(a) };
      return inside(p, stage) && !near.some(b => inside(p, b)) && !(etch && etch(p));
    };
    const windows: LightWindow[] = [];
    trails.forEach((t, index) => {
      if (t.r !== r) return;
      for (const [to, from] of scanTrail(t, seen).stretches) windows.push({ index, from, to, length: (from - to) * r });
    });
    // The main stretch: the one round the stretch that chose the ring (all that was clear for the choice is seen).
    const mid = (chosen.best[0] + chosen.best[1]) / 2;
    let main = windows.find(w => w.index === chosen.index && w.to <= mid && w.from >= mid);
    if (!main) windows.push(main = { index: chosen.index, from: chosen.best[1], to: chosen.best[0], length: (chosen.best[1] - chosen.best[0]) * r });
    return lightRun({ ...main, r }, windows);
  });
}

/** The stretches of a ring that carry light, merged where windows (twin trails) overlap: [lo, hi] angles, from windows in their run's order. */
function litStretches(windows: readonly LightWindow[]): { lo: number; hi: number }[] {
  const lit: { lo: number; hi: number }[] = [];
  for (const w of windows) {
    const last = lit[lit.length - 1];
    if (last && w.from >= last.lo) last.lo = Math.min(last.lo, w.to); else lit.push({ lo: w.to, hi: w.from });
  }
  return lit;
}

/** One light's run round its ring: through every window once, the long way round from the ring's widest stretch with nothing seen. */
function lightRun(main: LightWindow & { r: number }, all: LightWindow[]): LightArc {
  const r = main.r;
  // In [0, 2π) at the low end: the same window shifted by whole turns is the same window.
  const turn = <W extends LightWindow>(w: W, k: number): W => ({ ...w, from: w.from + k * TURN, to: w.to + k * TURN });
  const norm = <W extends LightWindow>(w: W): W => turn(w, -Math.floor(w.to / TURN));
  const windows = all.map(norm);
  // The stretches of the ring that carry light (twin trails can overlap), low end ascending...
  const lit: { lo: number; hi: number }[] = [];
  for (const w of [...windows].sort((a, b) => a.to - b.to)) {
    const last = lit[lit.length - 1];
    if (last && w.to <= last.hi) last.hi = Math.max(last.hi, w.from); else lit.push({ lo: w.to, hi: w.from });
  }
  while (lit.length > 1 && lit[lit.length - 1].hi >= lit[0].lo + TURN) {
    const first = lit.shift()!, last = lit[lit.length - 1];
    last.hi = Math.max(last.hi, first.hi + TURN);
  }
  // ...and the widest gap between them, where the run does not go.
  let cut = lit.length - 1, widest = -Infinity;
  lit.forEach((s, k) => {
    const gap = k + 1 < lit.length ? lit[k + 1].lo - s.hi : lit[0].lo + TURN - s.hi;
    if (gap > widest) { widest = gap; cut = k; }
  });
  const start = lit[cut].hi, end = cut + 1 < lit.length ? lit[cut + 1].lo - TURN : lit[0].lo;
  const place = <W extends LightWindow>(w: W): W => turn(w, Math.floor((start + 1e-9 - w.from) / TURN));
  const at = place(norm({ index: main.index, from: main.from, to: main.to, length: main.length }));
  return { ...at, r, start, end, windows: windows.map(place).sort((a, b) => b.from - a.from || b.to - a.to) };
}

/** The light's run, window by window, each drawn in its direction of travel (sweep 0: anticlockwise on screen). */
export function lightPath(pole: Point, arc: LightArc): string {
  return arc.windows.map(w => {
    const p0 = { x: pole.x + arc.r * Math.cos(w.from), y: pole.y + arc.r * Math.sin(w.from) };
    const p1 = { x: pole.x + arc.r * Math.cos(w.to), y: pole.y + arc.r * Math.sin(w.to) };
    const large = w.from - w.to > Math.PI ? 1 : 0;
    return `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)}A${arc.r} ${arc.r} 0 ${large} 0 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }).join('');
}

/**
 * One continuously tapered ribbon, relative to the pole, with its head at angle zero (it travels
 * towards falling angles). Its gradient rotates with it. The tail spans about 85% of the light's
 * main stretch, at least 64px when the ring allows, up to 320px, and at most 1.5 radians, which
 * keeps the gradient monotone on small rings.
 *
 * Round 4: a small glow round the head (`glow`: an oval GLOW.across wide across the trail and
 * GLOW.along long, its middle GLOW.back behind the tip; a radial gradient, no filter), so the head
 * reads as a meteor's.
 */
export const METEOR_WIDTH = 2.8;
export const GLOW = { across: 4.5, along: 8, back: 1.5 } as const;
export interface Meteor {
  path: string; length: number; angle: number;
  tail: Point; head: Point; glow: Ellipse;
  /** Where the head rests with reduced motion (degrees): along its main stretch. */
  rest: number;
}
function meteorLength(r: number, longest: number): number {
  return Math.min(320, r * 1.5, Math.max(64, longest * 0.85));
}
export function lightMeteor(arc: LightArc): Meteor {
  const angle = meteorLength(arc.r, arc.length) / arc.r;
  const length = angle * arc.r, points = 64;
  const side = (sign: number, i: number) => {
    const t = i / points, a = angle * (1 - t), radius = arc.r + sign * METEOR_WIDTH * t / 2;
    return `${(radius * Math.cos(a)).toFixed(3)} ${(radius * Math.sin(a)).toFixed(3)}`;
  };
  const outer = Array.from({ length: points + 1 }, (_, i) => side(1, i));
  const inner = Array.from({ length: points }, (_, i) => side(-1, points - 1 - i));
  const path = `M${outer.join('L')}A${METEOR_WIDTH / 2} ${METEOR_WIDTH / 2} 0 0 0 ${arc.r - METEOR_WIDTH / 2} 0L${inner.join('L')}Z`;
  return { path, length, angle,
    tail: { x: arc.r * Math.cos(angle), y: arc.r * Math.sin(angle) }, head: { x: arc.r, y: 0 },
    glow: { cx: arc.r, cy: GLOW.back, rx: GLOW.across, ry: GLOW.along },
    rest: ((arc.from - (arc.from - arc.to) * 0.64) * 180) / Math.PI,
  };
}

/** Fixed annular windows, one for each stretch of the ring that carries light, clip the moving ribbon and its glow. */
export function lightClipPath(pole: Point, arc: LightArc): string {
  const half = GLOW.across + 0.5, outer = arc.r + half, inner = arc.r - half, over = WINDOW_OVERLAP / arc.r;
  const p = (r: number, a: number) => `${(pole.x + r * Math.cos(a)).toFixed(3)} ${(pole.y + r * Math.sin(a)).toFixed(3)}`;
  return litStretches(arc.windows).map(({ lo, hi }) => {
    const a0 = hi + over, a1 = lo - over, large = a0 - a1 > Math.PI ? 1 : 0;
    return `M${p(outer, a0)}A${outer} ${outer} 0 ${large} 0 ${p(outer, a1)}L${p(inner, a1)}A${inner} ${inner} 0 ${large} 1 ${p(inner, a0)}Z`;
  }).join('');
}

/**
 * The pace: about SPEED px/s, set by the main stretch as before (so a short arc near the pole does
 * not crawl and a long one far out does not race), that stretch and the tail taking 9 to 24 s.
 */
const SPEED = 12, SLOW_MS = 420, MIN_CYCLE = 9000, MAX_CYCLE = 24000;
/** Round 4: the longest a light takes to cross glass where none of it can be seen (ms): a short pause, never a long wait. */
export const TRANSIT_MS = 1260;
/** The part of the tail that can be seen at all: past it the tail is under 8% of its strength and a quarter of a pixel wide. */
const TAIL_SEEN = 0.92;

export interface LightSchedule {
  /** The head's angle at the start and the end of the cycle (degrees): one whole turn, so the loop has no seam. */
  from: number; to: number;
  /** One cycle (ms), and in units of the shared slow duration (--d-slow, 420 ms); the even pace (px per ms). */
  ms: number; cycle: number; pace: number;
  /** The way round the turn against the time, as a CSS linear() easing ('linear' when some of the light is always seen). */
  easing: string;
  /** Each crossing of glass where none of the light is seen (ms), and all of them together. */
  transits: number[]; hidden: number;
}

/**
 * Round 4: one cycle is one whole turn of the light. While any of it is in one of its windows
 * (from its glow ahead of the head to the seen part of its tail) it goes at the even pace; while
 * none of it is, it crosses in at most TRANSIT_MS. The cycle starts in the middle of the widest
 * such crossing, so it loops unseen (and, a whole turn, without a seam in any case).
 */
export function lightSchedule(arc: LightArc): LightSchedule {
  const m = lightMeteor(arc), r = arc.r;
  const tail = m.length + METEOR_WIDTH * 2, own = arc.length + tail;
  const pace = own / Math.min(MAX_CYCLE, Math.max(MIN_CYCLE, (own * 1000) / SPEED));   // px per ms
  const ahead = (GLOW.along - GLOW.back + 0.5 + WINDOW_OVERLAP) / r, behind = m.angle * TAIL_SEEN + WINDOW_OVERLAP / r;
  // The head's angles at which some of the light is seen, as [a, b] with a in [0, 2π), merged round the circle.
  const spans = litStretches(arc.windows).map(({ lo, hi }) => {
    const a = (((lo - behind) % TURN) + TURN) % TURN;
    return { a, b: a + (hi + ahead) - (lo - behind) };
  }).sort((x, y) => x.a - y.a);
  const seen: { a: number; b: number }[] = [];
  for (const s of spans) {
    const last = seen[seen.length - 1];
    if (last && s.a <= last.b) last.b = Math.max(last.b, s.b); else seen.push({ ...s });
  }
  while (seen.length > 1 && seen[seen.length - 1].b >= seen[0].a + TURN) {
    const first = seen.shift()!, last = seen[seen.length - 1];
    last.b = Math.max(last.b, first.b + TURN);
  }
  const deg = (a: number) => (a * 180) / Math.PI;
  if (!seen.length || seen.some(s => s.b - s.a >= TURN)) {
    const ms = (TURN * r) / pace;
    return { from: deg(arc.start), to: deg(arc.start - TURN), ms, cycle: Math.round((ms / SLOW_MS) * 100) / 100, pace, easing: 'linear', transits: [], hidden: 0 };
  }
  // The widest gap with nothing seen: the cycle starts (and ends) in its middle.
  let widest = -1, start = 0;
  seen.forEach((s, k) => {
    const gap = (k + 1 < seen.length ? seen[k + 1].a : seen[0].a + TURN) - s.b;
    if (gap > widest) { widest = gap; start = s.b + gap / 2; }
  });
  // Going round from there, the angle falling: how far the head has gone at either end of each seen span.
  const gone = (a: number) => (((start - a) % TURN) + TURN) % TURN;
  const legs = seen.map(s => ({ s0: gone(s.b), s1: gone(s.b) + (s.b - s.a) })).sort((x, y) => x.s0 - y.s0);
  const segments: { from: number; to: number; seen: boolean }[] = [];
  let at = 0;
  for (const leg of legs) {
    if (leg.s0 > at) segments.push({ from: at, to: leg.s0, seen: false });
    segments.push({ from: leg.s0, to: leg.s1, seen: true });
    at = leg.s1;
  }
  segments.push({ from: at, to: TURN, seen: false });
  const crossing = (angle: number) => Math.min((angle * r) / pace, TRANSIT_MS);
  // The first and the last segment are the two halves of the widest gap: one crossing between them.
  const last = segments.length - 1, ends = segments[0].to - segments[0].from + (segments[last].to - segments[last].from);
  const time = segments.map((s, k) => {
    const angle = s.to - s.from;
    if (s.seen) return (angle * r) / pace;
    return k === 0 || k === last ? (crossing(ends) * angle) / ends : crossing(angle);
  });
  const ms = time.reduce((a, b) => a + b, 0);
  const points = ['0 0%'];
  let t = 0;
  segments.forEach((s, k) => {
    if (!(time[k] > 0) || k === last) return;
    t += time[k];
    points.push(`${(s.to / TURN).toFixed(5)} ${((t / ms) * 100).toFixed(3)}%`);
  });
  points.push('1 100%');
  const transits = segments.flatMap((s, k) => (s.seen || k === last ? [] : [k === 0 ? time[0] + time[last] : time[k]]));
  return {
    from: deg(start), to: deg(start - TURN), ms, cycle: Math.round((ms / SLOW_MS) * 100) / 100, pace,
    easing: `linear(${points.join(', ')})`, transits, hidden: transits.reduce((a, b) => a + b, 0),
  };
}

/** How long one cycle of a light takes, in units of the shared slow duration (--d-slow, 420 ms). */
export function lightCycle(arc: LightArc): number {
  return lightSchedule(arc).cycle;
}

/** Where in its cycle each light starts: spread by the golden ratio over the trail's index, so stable. */
export function lightPhase(index: number): number {
  return (index * 0.6180339887498949) % 1;
}

/** The light flows while the music is heard; paused, buffering, muted or silent, it holds. */
export function lightFlows(player: Pick<PlayerSnapshot, 'status' | 'muted' | 'volume'>): boolean {
  return player.status === 'playing' && !player.muted && player.volume > 0;
}

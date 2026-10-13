/**
 * V1.2 round 2 (Claude): the stage's real layout, measured in a browser at many window sizes.
 *
 *   pnpm dev            (or any server for the preview, e.g. vite --host 127.0.0.1 --port 5179)
 *   node tests/ui/stage-layout.browser.mjs [baseUrl] [--json out.json]
 *
 * Needs Playwright with a Chromium (not a project dependency): `playwright` from node_modules, or
 * the module named by PLAYWRIGHT (path to its index.mjs). Not part of `vitest run`.
 *
 * Every frame is a preview still (?shot=…, fictional data, a fixed demo signal frame) at a window
 * size in CSS px. In each it checks, from the boxes the browser actually laid out:
 *   - no horizontal scroll; the stage, the text and the music field inside the window;
 *   - the field's drawing (at full height, the loudest it can be) inside its column and inside the
 *     stage, clear of the title's lines, the credit, the track chip, the facts and the buttons, and
 *     at least 18 px short of the memorial etching; in the frames with every band at full scale
 *     (&viz=full) also what the field actually drew: inside the drawing, so nothing is clipped;
 *   - the title's lines stop before the etching; the chip never wider than its column;
 *   - every point of every cold light's path inside the stage and clear of the text, the eyebrow,
 *     the buttons, the cover and the field (round 4, star-trail completion: by CLEAR, 8 px, from the
 *     path's centre; the path may now run to the stage's own edge and into its rounded corners, where
 *     the glass's mask cuts the light exactly as it cuts the etched trails under it), and never
 *     through the middle of the memorial's radial cut, where the glass shows nothing (its painted
 *     figures and their 6 px clearance are checked against the real pixels by
 *     stage-coverage.browser.mjs);
 *   - across the 1200–1450 px sweep and the other non-compact widths, the field's size changes
 *     smoothly (no step larger than the widths would explain).
 * Exits 1 if anything fails; prints one line per frame and a summary.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const base = (args[0] ?? 'http://127.0.0.1:5179').replace(/\/$/, '');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const T = 314;   // the demo signal's frame (ms), the same in every still
const SIZES = [
  [960, 600], [1099, 720], [1100, 719], [1100, 720], [1150, 760], [1280, 800], [1360, 800], [1440, 900],
  [1600, 900], [1920, 1080], [2560, 1440],
];
const SWEEP = Array.from({ length: 11 }, (_, i) => [1200 + i * 25, 800]);
const FRAMES = [
  ...[...SIZES, ...SWEEP].map(([w, h]) => ({ shot: 'stage-ja-long', theme: 'charcoal', w, h, sweep: w >= 1200 && w <= 1450 && h === 800 })),
  ...SIZES.map(([w, h]) => ({ shot: 'stage-short', theme: 'light', w, h })),
  ...[[1100, 720], [1280, 800], [1920, 1080]].map(([w, h]) => ({ shot: 'stage-long', theme: 'blue', w, h })),
  ...[[1100, 720], [1280, 800], [1920, 1080]].map(([w, h]) => ({ shot: 'stage-ja-long-paused', theme: 'charcoal', w, h })),
  ...[[1100, 720], [1280, 800], [1920, 1080]].map(([w, h]) => ({ shot: 'stage-ja-long', theme: 'charcoal', w, h, extra: 'fs=1.3' })),
  ...[[1100, 720], [1440, 900]].map(([w, h]) => ({ shot: 'stage-ja-long', theme: 'charcoal', w, h, extra: 'fs=0.85' })),
  ...[[1280, 800], [1920, 1080]].map(([w, h]) => ({ shot: 'stage-ja-long', theme: 'charcoal', w, h, extra: 'etch=0' })),
  ...[[1280, 800], [1920, 1080]].map(([w, h]) => ({ shot: 'stage-ja-long', theme: 'charcoal', w, h, extra: 'pattern=0' })),
  { shot: 'stage-ja-long', theme: 'light', w: 1360, h: 800, extra: 'accent=E0628F' },
  // Every band at full scale: the tallest the pattern can stand, at the tightest layouts.
  ...[[960, 600], [1100, 720], [1280, 800], [1920, 1080]].map(([w, h]) => ({ shot: 'stage-ja-long', theme: 'charcoal', w, h, viz: 'full' })),
  { shot: 'stage-ja-long', theme: 'charcoal', w: 1100, h: 720, viz: 'full', extra: 'fs=1.3' },
];

/** Runs in the page: the boxes, relative to the stage, and the light's sampled paths. */
function measure() {
  const st = document.querySelector('section[data-viz]');
  if (!st) return { error: 'no stage' };
  const S = st.getBoundingClientRect();
  const box = r => ({ l: r.left - S.left, t: r.top - S.top, r: r.right - S.left, b: r.bottom - S.top });
  const shown = el => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? box(r) : null; };
  const title = st.querySelector('h2');
  const range = document.createRange();
  range.selectNodeContents(title);
  const T = title.getBoundingClientRect();
  // The lines actually set, each within the title's own box (a line's content area is taller than
  // its line box; the ink stays inside the line box).
  const titleLines = [...range.getClientRects()].filter(r => r.width > 0 && r.bottom > T.top && r.top < T.bottom)
    .map(r => ({ ...box(r), t: Math.max(r.top, T.top) - S.top, b: Math.min(r.bottom, T.bottom) - S.top }));
  const svg = st.querySelector('svg[data-state]');
  let drawing = null;
  if (svg && getComputedStyle(svg).display !== 'none') {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, k = Math.min(r.width / vb.width, r.height / vb.height);
    // preserveAspectRatio xMinYMax meet: the drawing sits at the column's left and bottom.
    drawing = { l: r.left - S.left, t: r.bottom - S.top - vb.height * k, r: r.left - S.left + vb.width * k, b: r.bottom - S.top, scale: k, viewBox: vb.width };
  }
  // What the field drew in this frame: every line, cell, peak and arc that shows.
  let ink = null;
  if (drawing) {
    for (const el of svg.querySelectorAll('line, rect, path')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 || r.height > 0)) continue;
      const b = box(r);
      ink = ink ? { l: Math.min(ink.l, b.l), t: Math.min(ink.t, b.t), r: Math.max(ink.r, b.r), b: Math.max(ink.b, b.b) } : b;
    }
  }
  const lights = [...st.querySelectorAll('[data-ambient="stage"] g[data-trail]')].map(g => {
    const path = g.querySelector('[data-light-path]');
    const ctm = path.getScreenCTM();
    const len = path.getTotalLength();
    const pts = [];
    for (let s = 0; s <= len; s += 2) {
      const p = path.getPointAtLength(s);
      const q = new DOMPoint(p.x, p.y).matrixTransform(ctm);
      pts.push([q.x - S.left, q.y - S.top]);
    }
    return { trail: g.dataset.trail, width: parseFloat(getComputedStyle(path).strokeWidth), pts };
  });
  const light = st.querySelector('[data-ambient="stage"]');
  const etchEl = st.querySelector('[data-memorial="etch"]');
  return {
    win: { w: innerWidth, h: innerHeight }, scrollX: document.documentElement.scrollWidth - innerWidth,
    stage: { w: S.width, h: S.height, l: S.left, r: S.right },
    radius: parseFloat(getComputedStyle(st).borderTopLeftRadius) || 0,
    titleLines, eyebrow: shown(st.querySelector('[class*="_eyebrow_"]')), credit: shown(st.querySelector('[class*="_credit_"]')),
    chip: shown(st.querySelector('[class*="_track_"]')), facts: shown(st.querySelector('[class*="_facts_"]')),
    actions: shown(st.querySelector('[class*="_actions_"]')), buttons: [...st.querySelectorAll('button')].map(shown).filter(Boolean),
    art: shown(st.querySelector('[class*="_art_"]')), column: shown(st.querySelector('[data-stage-viz]')), drawing, ink,
    lit: svg ? [...svg.querySelectorAll('line[stroke-dasharray]')].filter(l => Number(l.getAttribute('y2')) < Number(l.getAttribute('y1'))).length : null,
    etch: etchEl && getComputedStyle(etchEl).display !== 'none' ? shown(etchEl) : null,
    firstEtchClass: st.querySelector('[class*="_etch_"]')?.dataset.memorial ?? null,
    markers: { viz: !!st.querySelector('[data-stage-viz]'), trails: !!st.querySelector('[data-etch="star-trails"]'), ambient: !!light },
    light: light ? { flow: light.dataset.flow, count: lights.length } : null, lights,
    fontScale: getComputedStyle(st).getPropertyValue('--fs').trim() || '1',
  };
}

const overlap = (a, b, gap = 0) => a.l < b.r + gap && b.l < a.r + gap && a.t < b.b + gap && b.t < a.b + gap;
const inBox = ([x, y], b, pad = 0) => x > b.l - pad && x < b.r + pad && y > b.t - pad && y < b.b + pad;

const browser = await chromium.launch();
const results = [];
let failures = 0;
for (const f of FRAMES) {
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const q = `shot=${f.shot}&theme=${f.theme}&viz=${f.viz ?? 'pulse'}&t=${T}&w=${f.w}&h=${f.h}${f.extra ? '&' + f.extra : ''}`;
  await page.goto(`${base}/preview/?${q}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const m = await page.evaluate(measure);
  await page.close();
  const fail = [...errors.map(e => `page error: ${e}`)];
  const check = (ok, what) => { if (!ok) fail.push(what); };
  if (m.error) fail.push(m.error);
  else {
    check(m.scrollX <= 0, `horizontal scroll ${m.scrollX}px`);
    check(m.stage.l >= 0 && m.stage.r <= m.win.w + 0.5, 'stage outside the window');
    check(m.markers.trails && m.markers.ambient, 'stage markers missing (data-etch="star-trails", data-ambient)');
    check(!m.etch || m.firstEtchClass === 'etch', 'first [class*="_etch_"] is not the memorial etching');
    for (const line of m.titleLines) {
      check(line.r <= m.stage.w, 'title line past the stage');
      if (m.etch) check(!overlap(line, m.etch), 'title line over the etching');
    }
    if (m.chip && m.column) check(m.chip.r <= m.column.l + 1, 'track chip wider than its column');
    const text = [...m.titleLines, m.credit, m.chip, m.facts, m.actions].filter(Boolean);
    const pattern = !(f.extra ?? '').includes('pattern=0');
    check(m.markers.viz === pattern, pattern ? 'music field missing' : 'music field shown with the pattern off');
    if (pattern && m.drawing) {
      const d = m.drawing;
      check(d.l >= m.column.l - 0.5 && d.r <= m.column.r + 0.5 && d.t >= m.column.t - 0.5 && d.b <= m.column.b + 0.5, 'drawing outside its column');
      check(d.l >= 0 && d.r <= m.stage.w && d.t >= 0 && d.b <= m.stage.h, 'drawing outside the stage');
      for (const t of text) check(!overlap(d, t), `drawing over text or buttons (${['l', 't', 'r', 'b'].map(k => Math.round(t[k])).join(',')} vs ${['l', 't', 'r', 'b'].map(k => Math.round(d[k])).join(',')})`);
      if (m.etch) check(m.etch.l - d.r >= 18 - 0.5, `drawing ${Math.round(m.etch.l - d.r)}px from the etching (< 18)`);
      if (f.viz === 'full') {
        check(m.lit === 24, `${m.lit} of 24 columns lit at full scale`);
        const k = m.ink;
        check(k && k.l >= d.l - 1 && k.r <= d.r + 1 && k.t >= d.t - 1 && k.b <= d.b + 1, 'the field drew outside its drawing (clipped)');
        if (k) for (const t of text) check(!overlap(k, t), 'the full-scale pattern over text or buttons');
      }
    } else if (pattern) {
      check(m.column && m.column.r - m.column.l < 120, 'field hidden although its column is wide enough');
    }
    // Round 4: the light's route reaches the glass's own edge (half a pixel of rounding allowed) and
    // keeps CLEAR (8 px, half a pixel of rounding allowed) from what stands in front; the memorial by
    // the middle of its cut (lib/trailLight.ts CUT: the box grown 28 x 22, 0.62 of that oval).
    const CLEAR = 8;
    const cutMiddle = m.etch && { cx: (m.etch.l + m.etch.r) / 2, cy: (m.etch.t + m.etch.b) / 2,
      rx: ((m.etch.r - m.etch.l) / 2 + 28) * 0.62 - 0.5, ry: ((m.etch.b - m.etch.t) / 2 + 22) * 0.62 - 0.5 };
    for (const l of m.lights) {
      let cut = 0, covered = 0, hollow = 0;
      for (const p of l.pts) {
        if (!inBox(p, { l: 0, t: 0, r: m.stage.w, b: m.stage.h }, 0.5)) cut++;
        if ([...text, m.eyebrow, ...m.buttons, m.art, m.drawing].filter(Boolean).some(b => inBox(p, b, CLEAR - 0.5))) covered++;
        if (cutMiddle && ((p[0] - cutMiddle.cx) / cutMiddle.rx) ** 2 + ((p[1] - cutMiddle.cy) / cutMiddle.ry) ** 2 < 1) hollow++;
      }
      check(cut === 0, `light on trail ${l.trail} outside the stage at ${cut} points`);
      check(covered === 0, `light on trail ${l.trail} within ${CLEAR} px of text, the eyebrow, buttons, the cover or the field at ${covered} points`);
      check(hollow === 0, `light on trail ${l.trail} in the middle of the memorial's cut at ${hollow} points`);
    }
    check(!m.light || m.light.flow === (f.shot.includes('paused') ? 'hold' : 'run'), `light ${m.light?.flow}`);
  }
  const row = {
    frame: q, window: `${f.w}x${f.h}`, theme: f.theme, viz: f.viz ?? 'pulse', extra: f.extra ?? '', fontScale: m.fontScale, demoFrameMs: T,
    stage: m.stage && `${Math.round(m.stage.w)}x${Math.round(m.stage.h)}`, titleLines: m.titleLines?.length,
    drawing: m.drawing && { w: Math.round(m.drawing.r - m.drawing.l), h: Math.round(m.drawing.b - m.drawing.t), scale: +m.drawing.scale.toFixed(3), viewBox: m.drawing.viewBox },
    toEtch: m.drawing && m.etch ? Math.round(m.etch.l - m.drawing.r) : null,
    // From the title's last line to the top of the field's tallest possible column (6 units under the drawing's top).
    underTitle: m.drawing && m.titleLines?.length ? Math.round(m.drawing.t + 6 * m.drawing.scale - Math.max(...m.titleLines.map(l => l.b))) : null,
    // At full scale: from the title's last line to the top of what the field actually drew.
    inkUnderTitle: f.viz === 'full' && m.ink && m.titleLines?.length ? Math.round(m.ink.t - Math.max(...m.titleLines.map(l => l.b))) : null,
    lights: m.light?.count ?? 0, flow: m.light?.flow,
    sweep: !!f.sweep, fail,
  };
  results.push(row);
  failures += fail.length ? 1 : 0;
  console.log(`${fail.length ? 'FAIL' : 'ok  '} ${row.window.padEnd(9)} ${f.shot.padEnd(20)} ${[f.viz, f.extra].filter(Boolean).join(' ').padEnd(14)} stage ${row.stage} drawing ${row.drawing ? `${row.drawing.w}x${row.drawing.h} @${row.drawing.scale}` : '—'} toEtch ${row.toEtch ?? '—'} underTitle ${row.underTitle ?? '—'}${row.inkUnderTitle !== null ? ` (ink ${row.inkUnderTitle})` : ''} lights ${row.lights}${fail.length ? '  ← ' + fail.join('; ') : ''}`);
}
await browser.close();

// Smooth scaling: across the sweep (and the same layout at the wider sizes) the drawing grows or
// stays, by no more than the width added (it is one column of the stage).
const sweep = results.filter(r => r.sweep && r.drawing).sort((a, b) => parseInt(a.window) - parseInt(b.window));
for (let i = 1; i < sweep.length; i++) {
  const a = sweep[i - 1], b = sweep[i], dw = parseInt(b.window) - parseInt(a.window);
  const grow = b.drawing.w - a.drawing.w, dh = Math.abs(b.drawing.h - a.drawing.h);
  if (grow < -1 || grow > dw + 1 || dh > dw) {
    failures++;
    console.log(`FAIL sweep ${a.window} → ${b.window}: drawing ${a.drawing.w}x${a.drawing.h} → ${b.drawing.w}x${b.drawing.h}`);
  }
}
const wide = results.filter(r => r.extra === '' && r.theme === 'charcoal' && r.drawing && !r.sweep && parseInt(r.window) >= 1440 && r.frame.startsWith('shot=stage-ja-long&'));
const sizes = new Set(wide.map(r => `${r.drawing.w}x${r.drawing.h}`));
if (sizes.size > 1) { failures++; console.log(`FAIL wide windows draw the field at different sizes: ${[...sizes].join(', ')}`); }

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
console.log(`\n${results.length} frames, ${failures} failing`);
process.exit(failures ? 1 : 0);

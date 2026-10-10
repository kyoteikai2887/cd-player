/**
 * The memorial plates' images and rules (Claude, core.27 → V1.1), checked without a renderer: the
 * runtime images, their sizes and budget, and the rules that keep them quiet and out of the way.
 * V1.1: three plate finishes (one per theme) and the etching split into its walls and its cut.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = resolve('src/ui/assets/memorial');
const css = (file: string) => readFileSync(resolve(file), 'utf8');
/**
 * Canvas size of a WebP that carries alpha: the extended header (VP8X, lossy with an alpha chunk —
 * the plates and the cut) or a lossless bitstream with its alpha bit set (VP8L — the etching's walls,
 * V1.1 round 2, where lossless keeps the thin walls exact and is also smaller).
 */
function webpSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 12)).toBe('WEBP');
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8L') {
    expect(b[20]).toBe(0x2f);                             // lossless signature
    const bits = b.readUInt32LE(21);
    expect((bits >>> 28) & 1).toBe(1);                    // alpha is used
    return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
  }
  expect(kind).toBe('VP8X');
  expect(b[20] & 0x10).toBe(0x10);                      // alpha flag
  return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
}
const webpKind = (file: string) => readFileSync(file).toString('ascii', 12, 16);

const PLATES = ['memorial-plate.webp', 'memorial-plate-blue.webp', 'memorial-plate-silver.webp'];
const ETCH = ['memorial-etch-cut.webp', 'memorial-etch-light.webp', 'memorial-etch.webp'];
describe('runtime images', () => {
  test('three plates at 3x of 360x240 and the etching (walls twice, cut once) at 3x of 141x112', () => {
    expect(readdirSync(DIR).sort()).toEqual([...ETCH, ...PLATES].sort());
    for (const f of PLATES) expect(webpSize(join(DIR, f))).toEqual([1080, 720]);
    for (const f of ETCH) expect(webpSize(join(DIR, f))).toEqual([422, 336]);
    // The walls are lossless; the cut keeps its V1.1 encoding, so its geometry is exactly the walls' cut.
    expect(webpKind(join(DIR, 'memorial-etch.webp'))).toBe('VP8L');
    expect(webpKind(join(DIR, 'memorial-etch-light.webp'))).toBe('VP8L');
  });
  test('together under the 450 KB budget (each plate under 120 KB)', () => {
    const total = readdirSync(DIR).reduce((n, f) => n + statSync(join(DIR, f)).size, 0);
    expect(total).toBeLessThan(450 * 1024);
    for (const f of PLATES) expect(statSync(join(DIR, f)).size).toBeLessThan(120 * 1024);
  });
  test('the authoring sources are never referenced by the app', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [join(d, e.name)] : []);
    for (const file of [...walk(resolve('src')), ...walk(resolve('preview')).filter(f => !f.includes('memorial-plates'))]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/memorial-plates\/|source\/(codex|claude)\.png/);
    }
  });
});

const ruleOf = (sheet: string, selector: string) => {
  const at = sheet.indexOf('\n' + selector + ' {');
  expect(at).toBeGreaterThan(-1);
  return sheet.slice(at, sheet.indexOf('}', at));
};
const block = (sheet: string, head: string) => { const from = sheet.indexOf(head); expect(from).toBeGreaterThan(-1); const b = sheet.slice(from); return b.slice(0, b.indexOf('\n}')); };

describe('stage etching rules', () => {
  const stage = css('src/ui/views/Spotlight.module.css');
  test('the walls and the floor are still images under the text: no pointer, no blend mode, no filter, nothing moving', () => {
    const walls = ruleOf(stage, '.etch'), floor = ruleOf(stage, '.etchFloor');
    expect(walls).toContain('url("../assets/memorial/memorial-etch.webp")');
    expect(walls).toContain('pointer-events: none;');
    expect(stage).toContain(':global(.cdp:not([data-theme="charcoal"])) .etch { background-image: url("../assets/memorial/memorial-etch-light.webp"); }');
    expect(floor).toContain('url("../assets/memorial/memorial-etch-cut.webp")');
    expect(floor).toContain('z-index: -1;');
    for (const rule of [walls, floor]) expect(rule).not.toMatch(/mix-blend-mode|filter|animation|transition/);
  });
  test('the frost leaves its grain out of the cut only while the etching is shown, at the etching\'s own box', () => {
    const cut = ruleOf(stage, '.stage[data-etch="true"] .light::after');
    expect(cut).toContain('url("../assets/memorial/memorial-etch-cut.webp") right var(--etch-r) bottom var(--etch-b) / auto var(--etch-h) no-repeat');
    expect(cut).toContain('mask-composite: exclude;');
    expect(cut).toContain('-webkit-mask-composite: xor;');
    const walls = ruleOf(stage, '.etch');
    expect(walls).toContain('right: var(--etch-r); bottom: var(--etch-b);');
    expect(walls).toContain('height: var(--etch-h); aspect-ratio: 422 / 336;');
  });
  test('hidden in the compact stage (the surface container query) and in high contrast; the cut goes with it', () => {
    const compact = block(stage, '@container (width < 1100px) or (height < 720px)');
    expect(compact).toContain('.etch { display: none; }');
    expect(compact).toContain('.stage[data-etch="true"] .light::after { -webkit-mask: none; mask: none; }');
    expect(block(stage, '@media (forced-colors: active)')).toContain('.etch { display: none; }');
  });
});

describe('lyrics plate rules', () => {
  const lyrics = css('src/ui/views/LyricsPanel.module.css');
  test('the plate image, sized with the lyrics pane, its shadow drawn by the page; hidden in high contrast', () => {
    const rule = ruleOf(lyrics, '.plate');
    expect(rule).toContain('url("../assets/memorial/memorial-plate.webp")');
    expect(rule).toContain('height: clamp(120px, 34cqh, 240px); aspect-ratio: 3 / 2;');
    expect(rule).not.toMatch(/filter|animation/);
    const forced = block(lyrics, '@media (forced-colors: active)');
    expect(forced).toContain('.plate { display: none; }');
    expect(forced).toMatch(/\.plateFallback \{ display: grid;/);
  });
  test('each theme has its own finish: silver on 纸白, blue-silver on 阿根廷蓝, graphite on 灰黑', () => {
    expect(lyrics).toMatch(/:global\(\.cdp\[data-theme="light"\]\) \.plate \{ background-image: url\("\.\.\/assets\/memorial\/memorial-plate-silver\.webp"\);/);
    expect(lyrics).toMatch(/:global\(\.cdp\[data-theme="blue"\]\) \.plate \{ background-image: url\("\.\.\/assets\/memorial\/memorial-plate-blue\.webp"\);/);
    expect(lyrics).not.toMatch(/data-theme="charcoal"\]\) \.plate \{[^}]*background-image/);   // graphite is the base rule
  });
});

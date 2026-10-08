/**
 * The memorial plates' images and rules (Claude, core.27), checked without a renderer: the three
 * runtime images, their sizes and budget, and the rules that keep them quiet and out of the way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = resolve('src/ui/assets/memorial');
const css = (file: string) => readFileSync(resolve(file), 'utf8');
/** Canvas size of a WebP with an extended header (VP8X), as these images all are (they carry alpha). */
function webpSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 12)).toBe('WEBP');
  expect(b.toString('ascii', 12, 16)).toBe('VP8X');
  expect(b[20] & 0x10).toBe(0x10);                      // alpha flag
  return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
}

describe('runtime images', () => {
  test('three WebP files: the plate at 3x of 360x240, the etchings at 3x of 141x112', () => {
    expect(readdirSync(DIR).sort()).toEqual(['memorial-etch-light.webp', 'memorial-etch.webp', 'memorial-plate.webp']);
    expect(webpSize(join(DIR, 'memorial-plate.webp'))).toEqual([1080, 720]);
    expect(webpSize(join(DIR, 'memorial-etch.webp'))).toEqual([422, 336]);
    expect(webpSize(join(DIR, 'memorial-etch-light.webp'))).toEqual([422, 336]);
  });
  test('together under the 300 KB budget', () => {
    const total = readdirSync(DIR).reduce((n, f) => n + statSync(join(DIR, f)).size, 0);
    expect(total).toBeLessThan(300 * 1024);
  });
  test('the authoring sources are never referenced by the app', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [join(d, e.name)] : []);
    for (const file of [...walk(resolve('src')), ...walk(resolve('preview')).filter(f => !f.includes('memorial-plates'))]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/memorial-plates\/|source\/(codex|claude)\.png/);
    }
  });
});

describe('stage etching rules', () => {
  const stage = css('src/ui/views/Spotlight.module.css');
  const rule = stage.slice(stage.indexOf('\n.etch {'), stage.indexOf('}', stage.indexOf('\n.etch {')));
  test('a plain image under the text: no pointer, no blend mode, no filter', () => {
    expect(rule).toContain('url("../assets/memorial/memorial-etch.webp")');
    expect(rule).toContain('pointer-events: none;');
    expect(rule).not.toMatch(/mix-blend-mode|filter|animation|transition/);
    expect(stage).toContain(':global(.cdp:not([data-theme="charcoal"])) .etch { background-image: url("../assets/memorial/memorial-etch-light.webp"); }');
  });
  test('hidden in the compact stage (the surface container query) and in high contrast', () => {
    const compact = stage.slice(stage.indexOf('@container (width < 1100px) or (height < 720px)'));
    expect(compact.slice(0, compact.indexOf('\n}'))).toContain('.etch { display: none; }');
    const forced = stage.slice(stage.indexOf('@media (forced-colors: active)'));
    expect(forced.slice(0, forced.indexOf('\n}'))).toContain('.etch { display: none; }');
  });
});

describe('lyrics plate rules', () => {
  const lyrics = css('src/ui/views/LyricsPanel.module.css');
  test('the plate image, sized with the lyrics pane, its shadow drawn by the page; hidden in high contrast', () => {
    const rule = lyrics.slice(lyrics.indexOf('\n.plate {'), lyrics.indexOf('}', lyrics.indexOf('\n.plate {')));
    expect(rule).toContain('url("../assets/memorial/memorial-plate.webp")');
    expect(rule).toContain('height: clamp(120px, 34cqh, 240px); aspect-ratio: 3 / 2;');
    expect(rule).not.toMatch(/filter|animation/);
    const forced = lyrics.slice(lyrics.indexOf('@media (forced-colors: active)'));
    expect(forced.slice(0, forced.indexOf('\n}'))).toContain('.plate { display: none; }');
  });
});

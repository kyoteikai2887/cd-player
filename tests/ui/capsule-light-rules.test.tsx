/**
 * MV round (Claude): the capsule light, the stylesheet and model half (the rendered half is in
 * capsule-light.test.tsx). Text tones are derived over any cover and any shelf behind the bar;
 * the stage and the mini card keep their accepted values.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { contrast, parseHex } from '../../src/ui/lib/color.ts';
import { FROST, frostBackdrops, frostTones } from '../../src/ui/lib/frost.ts';
import type { ThemeName } from '../../src/ui/lib/theme.ts';

const THEMES: ThemeName[] = ['light', 'blue', 'charcoal'];
const read = (file: string) => readFileSync(file, 'utf8');

describe('capsule tones', () => {
  test('every theme lays the cover on a tone; title, time, icons and accent read at 4.5:1 over any cover and any shelf behind', () => {
    for (const theme of THEMES) {
      const spec = FROST.capsule[theme];
      expect(spec.tone).toMatch(/^#[0-9A-F]{6}$/i);
      expect(spec.field).toBeLessThanOrEqual(0.5);                     // was 0.72: the colour now reaches across
      expect(spec.see).toBeGreaterThan(0);
      const backdrops = frostBackdrops(theme, spec);
      expect(backdrops.length).toBeGreaterThan(100);                    // the cover sweep × both ends of the shelf range
      const tones = frostTones(theme, spec, '#DB7A3D');
      for (const tone of [tones.ink, tones.ink2, tones.accent]) {
        expect(Math.min(...backdrops.map(bg => contrast(parseHex(tone)!, bg)))).toBeGreaterThanOrEqual(4.5);
      }
      expect(tones.ink2.toUpperCase()).not.toBe(tones.ink.toUpperCase());
    }
  });

  test('the stage and the mini card keep their accepted values', () => {
    expect(FROST.stage).toEqual({
      light: { art: 0.9, field: 0.34, grain: 1, tone: '#BCC7D3' },
      blue: { art: 0.85, field: 0.36, grain: 1, tone: '#A3BFDA' },
      charcoal: { art: 0.72, field: 0.44, grain: 1, tone: '#1E2329', grainVeil: 0.45 },
    });
    expect(FROST.mini.charcoal).toEqual({ art: 0.7, field: 0.46, grain: 1, tone: '#1E2329', grainVeil: 0.45 });
    expect(FROST.miniNative.light).toEqual({ art: 0.8, field: 0.4, grain: 0, tone: '#C8D1DB', see: 0.2, seeRange: [0, 255] });
  });

  test('the stylesheet: the colour layer spans the bar, the halo stays behind the thumbnail, the old clear strip is gone', () => {
    const css = readFileSync('src/ui/views/PlayerCapsule.module.css', 'utf8');
    const rule = (head: string) => { const at = css.indexOf(head); expect(at).toBeGreaterThan(-1); return css.slice(at, css.indexOf('}', at)); };
    const layer0 = rule(':global(.cdp) .light img[data-layer="0"]');
    expect(layer0).toContain('left: -8%; width: 116%;');
    expect(layer0).toContain('mix-blend-mode: color;');
    expect(layer0).not.toContain('object-fit: fill');                   // an SVG sleeve would stay square in the middle
    const layer1 = rule(':global(.cdp) .light img[data-layer="1"]');
    expect(layer1).toMatch(/radial-gradient\(circle at 38px 50%, #000 0 22px, transparent 34px\)/);   // gone before the title (x = 73px)
    expect(css).toContain(':global(.cdp) .light:has(img) { background: var(--frost-tone, var(--paper-2)); }');
    expect(css).not.toMatch(/--frost-clear|--frost-field-from/);
    expect(read('src/ui/views/PlayerCapsule.tsx')).toContain('<Frost cover={currentAlbum?.cover ?? null} className={styles.light} layers={2} />');
  });
});

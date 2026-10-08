/**
 * Frost (Claude, R2.2): text tones on a cover's light are derived against the darkest and the
 * lightest backgrounds any cover can produce, not against the theme paper alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrast, mix, parseHex } from '../../src/ui/lib/color.ts';
import { FROST, frostBackdrops, frostTones, frostVars, seeFilter, THEME_TONES } from '../../src/ui/lib/frost.ts';
import type { FrostSurface } from '../../src/ui/lib/frost.ts';
import type { ThemeName } from '../../src/ui/lib/theme.ts';

const THEMES: ThemeName[] = ['light', 'blue', 'charcoal'];
const SURFACES = Object.keys(FROST) as FrostSurface[];
const rgb = (hex: string) => parseHex(hex)!;

describe('frost', () => {
  test('the tones it starts from are the theme tokens', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/styles/tokens.css'), 'utf8');
    const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
    const blocks: Record<ThemeName, string> = { light: block('.cdp {'), blue: block('.cdp[data-theme="blue"] {'), charcoal: block('.cdp[data-theme="charcoal"] {') };
    const token = (theme: ThemeName, name: string) => new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(blocks[theme])?.[1]?.toUpperCase();
    for (const theme of THEMES) {
      const t = THEME_TONES[theme];
      expect([token(theme, 'paper'), token(theme, 'paper-2'), token(theme, 'ink'), token(theme, 'ink-2'), token(theme, 'ok'), token(theme, 'warning'), token(theme, 'danger')])
        .toEqual([t.paper, t.paper2, t.ink, t.ink2, t.ok, t.warning, t.danger]);
    }
  });

  test('the extremes are an all-black and an all-white cover seen through the field', () => {
    const spec = { art: 0.9, field: 0.6, grain: 0 as const };
    const [onPaperBlack, onPaperWhite] = frostBackdrops('light', spec);
    const paper = rgb(THEME_TONES.light.paper), base = rgb(THEME_TONES.light.paper2);
    expect(onPaperBlack).toEqual(mix(mix(base, [0, 0, 0], 0.9), paper, 0.6));
    expect(onPaperWhite).toEqual(mix(mix(base, [255, 255, 255], 0.9), paper, 0.6));
    // Any other cover lands between them in brightness, so passing both passes every cover.
    for (const cover of [[128, 128, 128], [211, 32, 42], [245, 217, 10], [10, 10, 11]] as [number, number, number][]) {
      const bg = mix(mix(base, cover, 0.9), paper, 0.6);
      const ink = rgb(THEME_TONES.light.ink);
      expect(contrast(ink, bg)).toBeGreaterThanOrEqual(Math.min(contrast(ink, onPaperBlack), contrast(ink, onPaperWhite)) - 1e-9);
    }
  });

  test('every text tone on every frost surface reads at 4.5:1 over any cover, in every theme', () => {
    for (const surface of SURFACES) {
      for (const theme of THEMES) {
        const spec = FROST[surface][theme];
        const backdrops = frostBackdrops(theme, spec);
        for (const accent of ['#6CACE4', '#2F80ED', '#E0628F', '#FFE066', '#1A237E', '#777777']) {
          const tones = frostTones(theme, spec, accent);
          for (const [name, tone] of Object.entries(tones)) {
            const worst = Math.min(...backdrops.map(bg => contrast(rgb(tone), bg)));
            if (worst < 4.5) throw new Error(`${surface}/${theme}/${accent}: ${name} ${tone} only ${worst.toFixed(2)}:1`);
          }
        }
      }
    }
  });

  test('the field stays thin enough for the cover to show, and the user accent is only read', () => {
    for (const surface of SURFACES) for (const theme of THEMES) {
      expect(FROST[surface][theme].field).toBeLessThanOrEqual(0.8);
      expect(FROST[surface][theme].art).toBeGreaterThan(0.3);
    }
    const vars = frostVars('charcoal', FROST.stage.charcoal, '#E0628F');
    expect(vars['--frost-field']).toBe(`${Math.round(FROST.stage.charcoal.field * 100)}%`);
    expect(frostVars('light', FROST.header.light, '#6CACE4')['--frost-grain']).toBe('none');           // no grey haze on open paper
    expect(Object.keys(vars)).not.toContain('--accent');                              // the accent itself is never replaced
    expect(() => frostVars('light', FROST.stage.light, 'not-a-colour')).not.toThrow();
  });

  test('the player capsule lets a little of the shelf through, pressed into a range the text survives', () => {
    for (const theme of THEMES) {
      const spec = FROST.capsule[theme];
      expect(spec.see).toBeGreaterThan(0);
      const [lo, hi] = spec.seeRange!;
      // The backdrop filter maps black to the dark end of the range and white to the light end.
      const [, c, b] = /contrast\(([\d.]+)\) brightness\(([\d.]+)\)/.exec(seeFilter([lo, hi]))!.map(Number);
      expect(Math.abs((0.5 - c / 2) * b * 255 - lo)).toBeLessThan(1);
      expect(Math.abs((0.5 + c / 2) * b * 255 - hi)).toBeLessThan(1);
      // Text is derived against the frost laid over both ends of that range.
      const opaque = frostBackdrops(theme, { ...spec, see: 0 });
      expect(frostBackdrops(theme, spec)).toHaveLength(opaque.length * 2);
      const vars = frostVars(theme, spec, '#6CACE4');
      expect(vars['--frost-opacity']).toBe(String(1 - spec.see!));
      expect(vars['--frost-see-filter']).toBe(seeFilter([lo, hi]));
    }
    expect(frostVars('light', FROST.stage.light, '#6CACE4')['--frost-see-filter']).toBeUndefined();   // the stage stays opaque
  });
});

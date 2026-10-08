/**
 * Crystal transport controls and the memorial colour (Claude, core.23).
 * The glass and its states are drawn in CSS; what can be checked without a renderer is checked
 * here: the tint and glyph chosen for every accent and theme, the backdrop range, and the rules
 * that keep glass-off and high-contrast modes plain.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrast, deriveAccentInk, DEFAULT_ACCENT, INK, LIGHT_INK, parseHex } from '../../src/ui/lib/color.ts';
import { CRYSTAL_RANGE, CRYSTAL_TARGET, crystalFaces, crystalFilter, crystalTint, crystalVars } from '../../src/ui/lib/crystal.ts';
import { THEME_TEXT_BACKGROUNDS } from '../../src/ui/lib/theme.ts';
import type { ThemeName } from '../../src/ui/lib/theme.ts';

const THEMES: ThemeName[] = ['light', 'blue', 'charcoal'];
const MEMORIAL = '#DB7A3D';
const ACCENTS = [MEMORIAL, DEFAULT_ACCENT, '#E0628F', '#2F80ED', '#FFE066', '#A0F0E0', '#1A237E', '#000000', '#FFFFFF', '#777777', '#E8834A'];
const css = (file: string) => readFileSync(resolve(file), 'utf8');
/** The rule whose selector list is exactly `selector`: the last such rule (where the crystal section sets it), or the first. */
const block = (source: string, selector: string, which: 'first' | 'last' = 'last') => {
  const key = '\n' + selector + ' {';
  const at = which === 'last' ? source.lastIndexOf(key) : source.indexOf(key);
  return at < 0 ? '' : source.slice(at, source.indexOf('}', at));
};

describe('crystal tint and glyph', () => {
  test('the backdrop filter presses black and white onto the ends of each theme range', () => {
    for (const theme of THEMES) {
      const [lo, hi] = CRYSTAL_RANGE[theme];
      const filter = crystalFilter([lo, hi]);
      const c = Number(/contrast\(([\d.]+)\)/.exec(filter)![1]), b = Number(/brightness\(([\d.]+)\)/.exec(filter)![1]);
      // contrast(c) then brightness(b), as the browser applies them, on black (0) and white (1).
      expect(((0 - 0.5) * c + 0.5) * b * 255).toBeCloseTo(lo, 0);
      expect(((1 - 0.5) * c + 0.5) * b * 255).toBeCloseTo(hi, 0);
    }
  });
  test('any accent: the play glyph reads as an icon (3:1) over every face the glass can show', () => {
    for (const accent of ACCENTS) {
      for (const theme of THEMES) {
        const { tint, glyph, contrast: worst } = crystalTint(accent, theme);
        expect(tint).toBeGreaterThanOrEqual(0.36);
        expect(tint).toBeLessThanOrEqual(0.92);
        expect(worst).toBeGreaterThanOrEqual(3);
        // The reported figure is the real minimum over the faces (no rounding in its favour).
        const faces = crystalFaces(parseHex(accent)!, theme, tint);
        expect(Math.min(...faces.map(face => contrast(face, parseHex(glyph)!)))).toBeCloseTo(worst, 5);
      }
    }
  });
  test('the memorial orange and the default blue reach the full target in every theme', () => {
    for (const accent of [MEMORIAL, DEFAULT_ACCENT]) {
      for (const theme of THEMES) expect(crystalTint(accent, theme).contrast).toBeGreaterThanOrEqual(CRYSTAL_TARGET);
    }
  });
  test('memorial orange: a light glyph in well-tinted glass on charcoal, an ink glyph in paler glass on the light papers', () => {
    expect(crystalTint(MEMORIAL, 'charcoal')).toMatchObject({ glyph: LIGHT_INK, tint: 0.7 });
    expect(crystalTint(MEMORIAL, 'light')).toMatchObject({ glyph: INK, tint: 0.5 });
    expect(crystalTint(MEMORIAL, 'blue')).toMatchObject({ glyph: INK, tint: 0.5 });
  });
  test('the custom properties the root view sets for the crystal', () => {
    const vars = crystalVars(MEMORIAL, 'charcoal');
    expect(vars['--crystal-tint']).toBe('70%');
    expect(vars['--crystal-glyph']).toBe(LIGHT_INK);
    expect(vars['--crystal-glyph-shadow']).toContain('rgba(0, 0, 0');
    expect(vars['--crystal-filter']).toBe(crystalFilter(CRYSTAL_RANGE.charcoal));
    expect(crystalVars(MEMORIAL, 'light')['--crystal-glyph-shadow']).toContain('rgba(255, 255, 255');
  });
});

describe('the memorial colour', () => {
  test('the preview shows the chosen orange; as text it stays its own colour and reads on charcoal', () => {
    expect(css('preview/scenarios.ts')).toContain(`export const MEMORIAL_ACCENT = '${MEMORIAL}';`);
    const ink = deriveAccentInk(MEMORIAL, THEME_TEXT_BACKGROUNDS.charcoal);
    for (const paper of THEME_TEXT_BACKGROUNDS.charcoal) expect(contrast(parseHex(ink)!, parseHex(paper)!)).toBeGreaterThanOrEqual(4.5);
    const [r, g, b] = parseHex(ink)!, [r0, g0, b0] = parseHex(MEMORIAL)!;
    expect(Math.max(Math.abs(r - r0), Math.abs(g - g0), Math.abs(b - b0))).toBeLessThan(16);   // barely moved
  });
});

describe('crystal rules', () => {
  const components = css('src/ui/styles/components.css');
  const tokens = css('src/ui/styles/tokens.css');
  test('the play button is the tinted slab: its filter, glyph and wall come from the crystal tokens', () => {
    const play = block(components, '.cdp .cdp-play');
    expect(play).toContain('backdrop-filter: var(--crystal-filter);');
    expect(play).toContain('color: var(--crystal-glyph);');
    expect(play).toContain('var(--crystal-tint)');
    expect(play).not.toMatch(/animation/);                                   // nothing runs while it rests
    expect(block(components, '.cdp .cdp-play::before')).toContain('var(--crystal-wall)');
    // Pill buttons (Apply, Save) keep their own accent glass.
    expect(components).not.toMatch(/\.cdp-btn--primary, \.cdp \.cdp-play/);
  });
  test('glass off and no backdrop filter pour the slab opaque; high contrast draws a plain system button', () => {
    expect(components).toContain('.cdp[data-solid="true"] .cdp-play { -webkit-backdrop-filter: none; backdrop-filter: none; }');
    expect(components).toContain('.cdp[data-solid="true"] { --crystal-base: var(--paper-2); }');
    const forced = components.slice(components.indexOf('@media (forced-colors: active) {\n  .cdp .cdp-seg'));
    expect(forced).toContain('.cdp .cdp-play, .cdp .cdp-icon-btn--glass, .cdp .cdp-icon-btn:hover:not(:disabled) { background: ButtonFace; -webkit-backdrop-filter: none; backdrop-filter: none; }');
    expect(forced).toContain('.cdp .cdp-icon-btn::after, .cdp .cdp-play::after { display: none; }');
  });
  test('every theme gives the slab its own face, wall and shadows; the wall is one width all round', () => {
    expect(tokens.match(/--slab-t:/g)).toHaveLength(1);
    for (const name of ['--slab-face:', '--slab-wall:', '--slab-edge:', '--slab-lip:', '--slab-drop:']) {
      expect(block(tokens, '.cdp', 'first')).toContain(name);
      expect(block(tokens, '.cdp[data-theme="blue"]')).toContain(name);
      expect(block(tokens, '.cdp[data-theme="charcoal"]')).toContain(name);
    }
    expect(block(components, '.cdp .cdp-icon-btn--glass::before, .cdp .cdp-icon-btn:hover:not(:disabled)::before')).toContain('padding: var(--slab-t);');
  });
});

describe('accent text on lit rows (core.23 page check with the memorial colour)', () => {
  const MIX = 'color: color-mix(in srgb, var(--accent-ink) 80%, var(--ink));';
  test('the current track and the album in the player take the accent one step toward ink', () => {
    expect(css('src/ui/views/AlbumDetail.module.css')).toContain(`.row[data-current="true"] .rowTitleText { ${MIX} }`);
    expect(css('src/ui/views/QueueList.module.css')).toContain(`.row[data-current="true"] .title { ${MIX} }`);
    expect(css('src/ui/views/NowPlaying.module.css')).toContain(`.listRow[data-current="true"] .listTitle { ${MIX} }`);
    expect(css('src/ui/views/LibraryView.module.css')).toContain(`.tile[data-playing="true"] .tileTitle { ${MIX} }`);
  });
  test('on charcoal the lit rows drop the button sheen that lay behind their titles', () => {
    expect(css('src/ui/views/QueueList.module.css')).toContain(':global(.cdp[data-theme="charcoal"]) .row[data-current="true"] { background: var(--fill-active); }');
    expect(css('src/ui/views/NowPlaying.module.css')).toContain(':global(.cdp[data-theme="charcoal"]) .listRow[data-current="true"] { background: var(--fill-active); }');
  });
  test('a step toward ink keeps every accent at 4.5:1 on the papers and lifts the memorial orange', () => {
    const mix = (a: string, b: string, t: number) => { const x = parseHex(a)!, y = parseHex(b)!; return x.map((v, i) => v * t + y[i] * (1 - t)) as [number, number, number]; };
    const inks: Record<ThemeName, string> = { charcoal: '#EDF1F6', light: '#13243B', blue: '#0F2136' };
    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        const tone = deriveAccentInk(accent, THEME_TEXT_BACKGROUNDS[theme]);
        for (const paper of THEME_TEXT_BACKGROUNDS[theme]) expect(contrast(mix(tone, inks[theme], 0.8), parseHex(paper)!)).toBeGreaterThanOrEqual(4.5);
      }
      const tone = deriveAccentInk(MEMORIAL, THEME_TEXT_BACKGROUNDS[theme]);
      for (const paper of THEME_TEXT_BACKGROUNDS[theme]) {
        expect(contrast(mix(tone, inks[theme], 0.8), parseHex(paper)!)).toBeGreaterThan(contrast(parseHex(tone)!, parseHex(paper)!));
      }
    }
  });
  test('mini window: the lyric line gets the full frost field under the part kept clear for the art', () => {
    const mini = css('src/ui/views/MiniSurface.module.css');
    expect(mini).toContain('.card[data-frost="true"] .lyric {');
    expect(mini).toMatch(/--frost-clear: 24%;/);
    expect(mini).toContain('calc((var(--frost-field) - var(--frost-clear)) / 0.76)');      // 0.76 = 1 − 24%
  });
});

describe('accent pill buttons keep their label at text contrast (core.23)', () => {
  test('the glass body under an Apply or Save label is chosen for 4.5:1 with any accent', async () => {
    const { accentFill, accentGlassAlpha, mix, onAccent } = await import('../../src/ui/lib/color.ts');
    for (const accent of ACCENTS) {
      const fill = accentFill(accent), label = parseHex(onAccent(fill))!;
      for (const theme of THEMES) {
        const alpha = accentGlassAlpha(fill, THEME_TEXT_BACKGROUNDS[theme], theme === 'charcoal' ? 0.86 : 0.74, 4.5);
        if (alpha === 1) continue;                 // opaque: the fill itself, as onAccent chose for it
        for (const paper of THEME_TEXT_BACKGROUNDS[theme]) expect(contrast(mix(parseHex(paper)!, parseHex(fill)!, alpha), label)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(accentGlassAlpha(MEMORIAL, THEME_TEXT_BACKGROUNDS.charcoal, 0.86, 4.5)).toBe(0.94);
  });
});

describe('the rim at the lower left (core.25 button-edge check)', () => {
  const tokens = css('src/ui/styles/tokens.css');
  const rule = (selector: string) => block(tokens, selector, selector === '.cdp' ? 'first' : 'last');
  const stops = (body: string, name: string) => {
    const at = body.indexOf(name + ':');
    const value = body.slice(at, body.indexOf(';', at));
    return [...value.matchAll(/(rgba\([^)]*\)|color-mix\((?:[^()]|\([^()]*\))*\))\s+([\d.]+)deg/g)].map(m => ({ colour: m[1], deg: Number(m[2]) }));
  };
  test('the deep tone of the crystal wall sits under the specular, not at the lower left', () => {
    for (const selector of ['.cdp', '.cdp[data-theme="charcoal"]']) {
      const wall = stops(rule(selector), '--crystal-wall');
      const lights = stops(rule(selector).includes('--slab-lights:') ? rule(selector) : rule('.cdp'), '--slab-lights');
      const peak = lights.reduce((a, b) => (Number(/,\s*([\d.]+)\)$/.exec(b.colour)![1]) > Number(/,\s*([\d.]+)\)$/.exec(a.colour)![1]) ? b : a));
      const deep = wall.filter(s => s.colour.includes('--accent-lo'));
      expect(deep).toHaveLength(1);
      expect(Math.abs(deep[0].deg - peak.deg)).toBeLessThanOrEqual(10);
      // From 6 o'clock round to 9 o'clock the wall holds the accent itself.
      for (const s of wall.filter(s => s.deg >= 180 && s.deg <= 270)) expect(s.colour).toContain('var(--accent)');
    }
  });
  test('on charcoal the slab lights do not go out at the lower left', () => {
    const lights = stops(rule('.cdp[data-theme="charcoal"]'), '--slab-lights');
    const lowerLeft = lights.filter(s => s.deg > 200 && s.deg < 300);
    expect(lowerLeft.length).toBeGreaterThan(0);
    for (const s of lowerLeft) expect(Number(/,\s*([\d.]+)\)$/.exec(s.colour)![1])).toBeGreaterThanOrEqual(0.15);
  });
});

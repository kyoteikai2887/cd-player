import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { accentFill, accentGlassAlpha, contrast, DEFAULT_ACCENT, deriveAccentInk, luminance, mix, onAccent, parseHex } from '../../src/ui/lib/color.ts';
import { CHARCOAL_RAISED_GLASS, raisedAccentInk, THEME_TEXT_BACKGROUNDS } from '../../src/ui/lib/theme.ts';
import type { ThemeName } from '../../src/ui/lib/theme.ts';

const ratio = (a: string, b: string) => contrast(parseHex(a)!, parseHex(b)!);
const THEMES = Object.keys(THEME_TEXT_BACKGROUNDS) as ThemeName[];

describe('accent tones stay readable in every theme', () => {
  test('Argentine blue is the default accent and too light for body text on the light papers', () => {
    expect(DEFAULT_ACCENT).toBe('#6CACE4');
    for (const paper of [...THEME_TEXT_BACKGROUNDS.light, ...THEME_TEXT_BACKGROUNDS.blue]) {
      expect(ratio(DEFAULT_ACCENT, paper)).toBeLessThan(4.5);
    }
  });
  test('on light papers the accent deepens toward ink; on charcoal it brightens toward white', () => {
    const accent = parseHex(DEFAULT_ACCENT)!;
    const onLight = deriveAccentInk(DEFAULT_ACCENT, THEME_TEXT_BACKGROUNDS.light);
    const onDark = deriveAccentInk('#2F5F9E', THEME_TEXT_BACKGROUNDS.charcoal);
    expect(luminance(parseHex(onLight)!)).toBeLessThan(luminance(accent));
    expect(luminance(parseHex(onDark)!)).toBeGreaterThan(luminance(parseHex('#2F5F9E')!));
    for (const paper of THEME_TEXT_BACKGROUNDS.charcoal) expect(ratio(onDark, paper)).toBeGreaterThanOrEqual(4.5);
  });
  test('an accent that already reads on charcoal is kept unchanged', () => {
    expect(deriveAccentInk(DEFAULT_ACCENT, THEME_TEXT_BACKGROUNDS.charcoal)).toBe(DEFAULT_ACCENT);
  });
  test('any custom accent yields text >= 4.5:1 in all three themes and glyphs >= 3:1 on its fill', () => {
    const accents = ['#6CACE4', '#2F80ED', '#FFE066', '#A0F0E0', '#E0628F', '#1A237E', '#000000', '#FFFFFF', '#777777'];
    for (const accent of accents) {
      for (const theme of THEMES) {
        const ink = deriveAccentInk(accent, THEME_TEXT_BACKGROUNDS[theme]);
        for (const paper of THEME_TEXT_BACKGROUNDS[theme]) expect(ratio(ink, paper)).toBeGreaterThanOrEqual(4.5);
      }
      const fill = accentFill(accent);
      expect(fill).toBe(accent.toUpperCase());
      expect(ratio(fill, onAccent(fill))).toBeGreaterThanOrEqual(3);
    }
  });
  test('charcoal sheets and menus: accent text derived for their lighter glass, hue kept, paper ink untouched', () => {
    const accents = ['#6CACE4', '#2F80ED', '#FFE066', '#A0F0E0', '#E0628F', '#1A237E', '#000000', '#FFFFFF', '#777777'];
    for (const accent of accents) {
      const ink = raisedAccentInk(accent);
      for (const bg of [...THEME_TEXT_BACKGROUNDS.charcoal, CHARCOAL_RAISED_GLASS.lightest]) expect(ratio(ink, bg)).toBeGreaterThanOrEqual(4.5);
      // An accent badge on a selected row: the tinted well (tokens.css --accent-well) over that row.
      const well = mix(parseHex(CHARCOAL_RAISED_GLASS.selectedRow)!, mix([0, 0, 0], parseHex(accent)!, 0.18 / 0.426), 0.426);
      expect(contrast(parseHex(ink)!, well)).toBeGreaterThanOrEqual(4.5);
    }
    const blue = parseHex(raisedAccentInk(DEFAULT_ACCENT))!;
    expect(blue[2] - blue[0]).toBeGreaterThan(40);                                      // still visibly blue
    expect(deriveAccentInk(DEFAULT_ACCENT, THEME_TEXT_BACKGROUNDS.charcoal)).toBe(DEFAULT_ACCENT);   // on the paper
  });
  test('sheets, editors and menus are never more see-through than at the default glass strength; glass off stays solid', () => {
    const css = readFileSync(resolve('src/ui/styles/tokens.css'), 'utf8');
    const strong = /--glass-body-strong: rgba\(var\(--glass-tint\), calc\(max\(([\d.]+), var\(--glass-a\)\) \+ var\(--glass-a-offset\) \+ 0\.3\)\);/.exec(css);
    expect(strong).not.toBeNull();
    const floor = Number(strong![1]);
    // The root view sets --glass-a = 0.78 - 0.46 × strength (rounded to 0.01); the default strength is 0.65.
    const glassA = (strength: number) => Math.round((0.78 - 0.46 * strength) * 100) / 100;
    expect(floor).toBe(glassA(0.65));                                   // the default looks exactly as before
    const offsets = { light: 0, blue: -0.06, charcoal: 0.16 };
    for (const [theme, offset] of Object.entries(offsets)) {
      if (theme !== 'light') {
        const block = css.slice(css.indexOf(`.cdp[data-theme="${theme}"] {`));
        expect(Number(/--glass-a-offset:\s*(-?[\d.]+);/.exec(block)?.[1])).toBe(offset);
      }
      const body = (strength: number) => Math.max(floor, glassA(strength)) + offset + 0.3;
      expect(body(1)).toBeCloseTo(body(0.65), 5);                       // full strength stops at the default body
      expect(body(0.3)).toBeGreaterThan(body(0.65));                    // lower strengths are still more opaque
    }
    // The bar, capsule and other glass still follow the strength.
    expect(css).toContain('--glass-body: rgba(var(--glass-tint), calc(var(--glass-a) + var(--glass-a-offset)));');
    // Glass off (strength 0, transparency disabled) replaces the strong body with an opaque one.
    const solidAt = css.indexOf('.cdp[data-solid="true"] {');
    expect(solidAt).toBeGreaterThan(strong!.index);
    expect(css.slice(solidAt, css.indexOf('}', solidAt))).toContain('--glass-body-strong: rgb(var(--glass-tint));');
  });
  test('Argentine blue keeps its colour on fills and takes a dark glyph', () => {
    expect(accentFill('#6cace4')).toBe('#6CACE4');
    expect(onAccent('#6CACE4')).not.toBe('#FFFFFF');
    expect(ratio(onAccent('#6CACE4'), '#6CACE4')).toBeGreaterThanOrEqual(4.5);
  });
  test('accent glass (R2.1) keeps the user colour and takes only the body its glyph needs', () => {
    const accents = ['#6CACE4', '#2F80ED', '#FFE066', '#A0F0E0', '#E0628F', '#1A237E', '#000000', '#FFFFFF', '#777777'];
    for (const accent of accents) {
      const fill = accentFill(accent), glyph = parseHex(onAccent(fill))!;
      for (const theme of THEMES) {
        const alpha = accentGlassAlpha(fill, THEME_TEXT_BACKGROUNDS[theme]);
        expect(alpha).toBeGreaterThanOrEqual(0.74);
        expect(alpha).toBeLessThanOrEqual(1);
        if (alpha < 1) {
          for (const paper of THEME_TEXT_BACKGROUNDS[theme]) {
            expect(contrast(mix(parseHex(paper)!, parseHex(fill)!, alpha), glyph)).toBeGreaterThanOrEqual(4);
          }
        }
      }
    }
    // Argentine blue under its ink glyph only gains contrast as light paper shows through.
    expect(accentGlassAlpha('#6CACE4', THEME_TEXT_BACKGROUNDS.light)).toBe(0.74);
    expect(accentGlassAlpha('#6CACE4', THEME_TEXT_BACKGROUNDS.blue)).toBe(0.74);
    // A mid-tone accent, readable under neither glyph by much, is poured with more body.
    expect(accentGlassAlpha('#777777', THEME_TEXT_BACKGROUNDS.light)).toBeGreaterThan(0.74);
  });
  test('invalid accent values fall back to the default instead of throwing', () => {
    expect(parseHex('red')).toBeNull();
    expect(deriveAccentInk('red', THEME_TEXT_BACKGROUNDS.light)).toBe(deriveAccentInk(DEFAULT_ACCENT, THEME_TEXT_BACKGROUNDS.light));
    expect(accentFill('red')).toBe(DEFAULT_ACCENT);
  });
});

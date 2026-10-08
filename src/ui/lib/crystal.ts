/**
 * Crystal controls (Claude, core.23 memorial round). The transport buttons are slabs of glass of
 * even thickness: a flat face, a wall of the same width all round that catches and bends the
 * light, and light passing through. The play button is that slab tinted with the accent, as if
 * the colour were inside the glass.
 *
 * Whatever lies behind a button can be any colour (a cover, the stage, the shelf scrolling under
 * the capsule, the desktop under the mini window). Its backdrop filter first presses that into a
 * grey range per theme, like the capsule's see-through frost; the tint is then laid over it. The
 * glyph colour and the least tint that keep it readable are derived against the ends of that
 * range, the theme's own paper (glass off, where the slab is poured opaque over it) and the face's
 * reflection, so it holds for any accent the user picks.
 */
import { contrast, mix, parseHex, toHex, DEFAULT_ACCENT, INK, LIGHT_INK } from './color.ts';
import type { Rgb } from './color.ts';
import { THEME_TONES } from './frost.ts';
import type { ThemeName } from './theme.ts';

/** Grey range (0–255) what is behind a crystal control is pressed into, per theme. */
export const CRYSTAL_RANGE: Record<ThemeName, [number, number]> = {
  light: [198, 250],
  blue: [176, 236],
  charcoal: [16, 92],
};
/** The face's reflection at the glyph (a flat sheen, strongest at the top edge). */
export const CRYSTAL_REFLECTION = 0.05;
/**
 * Glyph contrast asked for. The play/pause glyph is a large icon, for which 3:1 is the bar
 * (non-text contrast); a margin above it covers the grain of whatever shows through.
 */
export const CRYSTAL_TARGET = 3.3;
/**
 * Accent share of the face the crystal is drawn with; it moves away from this only if the glyph
 * needs it. On charcoal the glass carries more colour so it glows rather than darkening to brown
 * over the dark paper; on the light papers less, so the paper's light comes through the colour.
 */
export const CRYSTAL_TINT: Record<ThemeName, number> = { light: 0.5, blue: 0.5, charcoal: 0.7 };
const TINTS = Array.from({ length: 29 }, (_, i) => 0.36 + i * 0.02);

const WHITE: Rgb = [255, 255, 255];

/** Backdrop filter: a little blur and colour, then contrast and brightness into the range. */
export function crystalFilter([lo, hi]: [number, number]): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `blur(3px) saturate(1.35) contrast(${r((hi - lo) / (lo + hi))}) brightness(${r((lo + hi) / 255)})`;
}

/** Every face colour the glyph can sit on at a given tint. */
export function crystalFaces(fill: Rgb, theme: ThemeName, tint: number): Rgb[] {
  const [lo, hi] = CRYSTAL_RANGE[theme];
  const t = THEME_TONES[theme];
  const unders: Rgb[] = [[lo, lo, lo], [hi, hi, hi], parseHex(t.paper)!, parseHex(t.paper2)!];
  return unders.flatMap(under => {
    const face = mix(under, fill, tint);
    return [face, mix(face, WHITE, CRYSTAL_REFLECTION)];
  });
}

export interface CrystalTint {
  /** Accent share of the face, 0–1. */
  tint: number;
  /** Glyph colour on the face. */
  glyph: string;
  /** Lowest glyph contrast over every face it can meet. */
  contrast: number;
}

/**
 * The glyph each theme would rather draw: light on the dark glass, so the crystal glows around it;
 * ink on the light papers, where the glass is pale.
 */
const PREFERRED_GLYPH: Record<ThemeName, string> = { light: INK, blue: INK, charcoal: LIGHT_INK };

/**
 * The tint nearest the theme's CRYSTAL_TINT (clearer or deeper, 0.36–0.92) at which the theme's
 * preferred glyph reaches the target; failing that, the other glyph; failing both, the closest pair.
 */
export function crystalTint(accentHex: string, theme: ThemeName, target = CRYSTAL_TARGET): CrystalTint {
  const fill = parseHex(accentHex) ?? parseHex(DEFAULT_ACCENT)!;
  const prefer = CRYSTAL_TINT[theme];
  const order = [...TINTS].sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer) || a - b).map(t => Math.round(t * 100) / 100);
  const first = PREFERRED_GLYPH[theme], other = first === INK ? LIGHT_INK : INK;
  let best: CrystalTint | null = null;
  for (const glyphHex of [first, other]) {
    const glyph = parseHex(glyphHex)!;
    for (const tint of order) {
      const worst = Math.min(...crystalFaces(fill, theme, tint).map(face => contrast(face, glyph)));
      const here = { tint, glyph: toHex(glyph), contrast: worst };
      if (worst >= target) return here;
      if (!best || worst > best.contrast) best = here;
    }
  }
  return best!;
}

/** Custom properties for the crystal controls, set by PlayerUI next to the other accent tones. */
export function crystalVars(accentHex: string, theme: ThemeName): Record<string, string> {
  const { tint, glyph } = crystalTint(accentHex, theme);
  return {
    '--crystal-tint': `${Math.round(tint * 100)}%`,
    '--crystal-glyph': glyph,
    // A light glyph is set off by a dark hairline below it, an ink glyph by a light one.
    '--crystal-glyph-shadow': glyph === LIGHT_INK ? '0 1px 1px rgba(0, 0, 0, 0.38)' : '0 1px 0 rgba(255, 255, 255, 0.45)',
    '--crystal-filter': crystalFilter(CRYSTAL_RANGE[theme]),
  };
}

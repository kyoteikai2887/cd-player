/**
 * Frost (Claude, R2.2): the material of the stage — an album's own colours, blurred, under a
 * grained "field" of paper — now shared by the other surfaces that carry an album (the album
 * page header, the player capsule, the mini window).
 *
 * The cover can be any colour, so text on frost is never checked against the theme paper alone.
 * Brightness is monotonic in each channel, so the darkest and lightest things the text can meet
 * are an all-black and an all-white cover seen through the field. Every text tone used on frost
 * is derived against those composites (with a margin for the grain), and the field is as thin as
 * that allows, so the cover's colour still comes through.
 */
import { deriveAccentInk, mix, parseHex, toHex } from './color.ts';
import type { Rgb } from './color.ts';
import type { ThemeName } from './theme.ts';

/** Theme papers, pools and inks as tokens.css defines them (tests keep the two in step). */
export interface ThemeTones {
  paper: string; paper2: string; pool1: string; pool1Alpha: number;
  ink: string; ink2: string; ok: string; warning: string; danger: string;
}
export const THEME_TONES: Record<ThemeName, ThemeTones> = {
  light: { paper: '#F6F9FD', paper2: '#EDF3FA', pool1: '#6CACE4', pool1Alpha: 0.3,
    ink: '#13243B', ink2: '#4A5A72', ok: '#1B714E', warning: '#8F5A0B', danger: '#B93A32' },
  blue: { paper: '#C7DFF5', paper2: '#BBD9F3', pool1: '#6CACE4', pool1Alpha: 0.78,
    ink: '#0F2136', ink2: '#2B3F5A', ok: '#105539', warning: '#653C03', danger: '#8E1E18' },
  charcoal: { paper: '#121519', paper2: '#191D23', pool1: '#6CACE4', pool1Alpha: 0.22,
    ink: '#EDF1F6', ink2: '#B3BDCB', ok: '#63D2A2', warning: '#EBB867', danger: '#FF8F85' },
};

/**
 * One frost surface in one theme.
 * - art: opacity of the blurred cover over the theme base.
 * - field: opacity of the paper laid over it where text sits (the grained "frosted" part).
 * - grain: whether the grain is on (1) or off (0). Off for the album page on the light themes,
 *   where its grey veil over open paper would read as haze rather than frost.
 */
export interface FrostSpec {
  art: number; field: number; grain: 0 | 1;
  /**
   * How much of what lies behind the surface shows through it, blurred (0 when opaque). The
   * player capsule floats over the scrolling shelf and lets a little of it through, so scrolling
   * reads as sliding beneath frosted glass. Whatever is behind can be any colour, so the text is
   * derived against an all-black and an all-white backdrop too.
   */
  see?: number;
  /**
   * What shows through is first pressed into this grey range (0–255, darkest to lightest) by the
   * surface's backdrop filter (contrast and brightness after the blur), so the scrolling shelf
   * reads as movement and colour, never as a black or white patch behind the text.
   */
  seeRange?: [number, number];
}

/** Where text sits on each frost surface. The left of the stage stays clear for the case and disc. */
export type FrostSurface = 'stage' | 'header' | 'capsule' | 'mini' | 'dialog';
export const FROST: Record<FrostSurface, Record<ThemeName, FrostSpec>> = {
  stage: { light: { art: 0.92, field: 0.68, grain: 1 }, blue: { art: 0.85, field: 0.7, grain: 1 }, charcoal: { art: 0.72, field: 0.7, grain: 1 } },
  header: { light: { art: 0.42, field: 0.3, grain: 0 }, blue: { art: 0.42, field: 0.46, grain: 0 }, charcoal: { art: 0.32, field: 0.5, grain: 1 } },
  capsule: {
    light: { art: 0.7, field: 0.72, grain: 1, see: 0.4, seeRange: [120, 236] },
    blue: { art: 0.66, field: 0.72, grain: 1, see: 0.4, seeRange: [120, 225] },
    charcoal: { art: 0.6, field: 0.72, grain: 1, see: 0.4, seeRange: [24, 100] },
  },
  mini: { light: { art: 0.7, field: 0.7, grain: 1 }, blue: { art: 0.66, field: 0.7, grain: 1 }, charcoal: { art: 0.6, field: 0.68, grain: 1 } },
  dialog: { light: { art: 0.8, field: 0.8, grain: 1 }, blue: { art: 0.76, field: 0.8, grain: 1 }, charcoal: { art: 0.66, field: 0.76, grain: 1 } },
};

/** Contrast the model asks for: 4.5:1 for normal text, with room for the grain's speckle. */
export const FROST_TARGET = 5;
/**
 * The grain is mid-grey noise laid over the field with soft-light; where the field is thin, part
 * of that grey shows through unblended (it is what reads as frosted paper, or as bead-blasted
 * metal on charcoal). On average it lifts dark backgrounds and dims light ones like a grey veil of
 * this strength times the clear part of the field (measured in Chromium).
 */
export const FROST_GRAIN = 0.45;
const GREY: Rgb = [128, 128, 128];

const rgb = (hex: string): Rgb => parseHex(hex)!;
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/**
 * The extreme backgrounds text can meet on a frost surface: an all-black and an all-white cover,
 * over either base the light can sit on (the paper, or its accent pool), seen through the field
 * and the grain. Blending is in sRGB, as the browser composites.
 */
export function frostBackdrops(theme: ThemeName, spec: FrostSpec): Rgb[] {
  const t = THEME_TONES[theme];
  const paper = rgb(t.paper), base = rgb(t.paper2);
  const pool = mix(base, rgb(t.pool1), t.pool1Alpha);
  const out: Rgb[] = [];
  const see = spec.see ?? 0;
  for (const under of [base, pool]) {
    for (const cover of [BLACK, WHITE]) {
      const seen = mix(mix(under, cover, spec.art), paper, spec.field);
      const frost = mix(seen, GREY, FROST_GRAIN * spec.grain * (1 - spec.field));
      if (!see) { out.push(frost); continue; }
      // The frost is laid at (1 - see) over whatever is behind, at its darkest and lightest.
      const [lo, hi] = spec.seeRange ?? [0, 255];
      for (const level of [lo, hi]) out.push(mix([level, level, level], frost, 1 - see));
    }
  }
  return out;
}

export interface FrostTones {
  /** Primary text (titles): the theme ink, deepened or brightened only if it would not read. */
  ink: string;
  /** Secondary text, icons and numbers. */
  ink2: string;
  /** The accent as text (playback state), in its own hue. */
  accent: string;
  ok: string; warning: string; danger: string;
}

/** Text tones for one frost surface, derived against its extreme backdrops. */
export function frostTones(theme: ThemeName, spec: FrostSpec, accentHex: string, target = FROST_TARGET): FrostTones {
  const t = THEME_TONES[theme];
  const backdrops = frostBackdrops(theme, spec).map(toHex);
  return {
    ink: deriveAccentInk(t.ink, backdrops, target),
    ink2: deriveAccentInk(t.ink2, backdrops, target),
    accent: deriveAccentInk(accentHex, backdrops, target),
    ok: deriveAccentInk(t.ok, backdrops, target),
    warning: deriveAccentInk(t.warning, backdrops, target),
    danger: deriveAccentInk(t.danger, backdrops, target),
  };
}

/**
 * CSS custom properties for a frost surface, set inline on its container. The theme's own text
 * tokens are re-pointed at the derived tones inside it, so everything already written against
 * --ink-2, --accent-ink or --ok (badges, rip marks, menus) reads on the cover without changes.
 */
export function frostVars(theme: ThemeName, spec: FrostSpec, accentHex: string): Record<string, string> {
  const tones = frostTones(theme, spec, accentHex);
  return {
    '--frost-art': String(spec.art),
    '--frost-field': `${Math.round(spec.field * 100)}%`,
    '--frost-grain': spec.grain ? 'var(--grain)' : 'none',
    '--frost-opacity': String(1 - (spec.see ?? 0)),
    ...(spec.see ? { '--frost-see-filter': seeFilter(spec.seeRange ?? [0, 255]) } : {}),
    '--ink': tones.ink,
    '--ink-2': tones.ink2,
    '--ink-3': tones.ink2,
    '--accent-ink': tones.accent,
    '--ok': tones.ok,
    '--warning': tones.warning,
    '--danger': tones.danger,
  };
}

/**
 * Backdrop filter for a see-through frost: blur and a little more colour, then contrast and
 * brightness chosen so black lands on the range's dark end and white on its light end.
 */
export function seeFilter([lo, hi]: [number, number]): string {
  const brightness = (lo + hi) / 255;
  const contrastAmount = (hi - lo) / (lo + hi);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `blur(24px) saturate(1.4) contrast(${r(contrastAmount)}) brightness(${r(brightness)})`;
}

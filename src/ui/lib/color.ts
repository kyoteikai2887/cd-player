/** Pure colour helpers for deriving readable accent tones from the user's #RRGGBB accent. */
export type Rgb = [number, number, number];

export const INK = '#14253D';
/** Light end used when an accent must brighten to stay readable on dark paper. */
export const LIGHT_INK = '#F2F6FB';
export const DEFAULT_ACCENT = '#6CACE4';
const DEEP = '#0B2A4A';

export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(typeof hex === 'string' ? hex.trim() : '');
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function channel(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const accentOrDefault = (hex: string) => parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;

/**
 * Accent tone usable as text on the given backgrounds (>= `target`, 4.5:1 by default).
 * On light papers the accent deepens toward ink; on dark papers it brightens toward white.
 * The hue is kept; only depth changes, in the smallest step that passes.
 */
export function deriveAccentInk(accentHex: string, backgroundsHex: string[], target = 4.5): string {
  const accent = accentOrDefault(accentHex);
  const backgrounds = backgroundsHex.map(parseHex).filter((c): c is Rgb => !!c);
  if (!backgrounds.length) return toHex(accent);
  const dark = backgrounds.reduce((sum, bg) => sum + luminance(bg), 0) / backgrounds.length < 0.18;
  const end = parseHex(dark ? LIGHT_INK : INK)!;
  for (let step = 0; step <= 40; step++) {
    const candidate = mix(accent, end, step / 40);
    if (backgrounds.every(bg => contrast(candidate, bg) >= target)) return toHex(candidate);
  }
  return toHex(end);
}

/** Glyph colour on an accent fill: whichever of white and ink contrasts more (>= 3:1 in practice). */
export function onAccent(fillHex: string): string {
  const fill = accentOrDefault(fillHex);
  return contrast(fill, [255, 255, 255]) >= contrast(fill, parseHex(INK)!) ? '#FFFFFF' : INK;
}

/**
 * Fill used for the accent's solid objects (Play, primary buttons, switches). The user's colour is
 * kept as is: a light accent such as Argentine blue gets a dark glyph instead of being darkened.
 */
export function accentFill(accentHex: string): string {
  return toHex(accentOrDefault(accentHex));
}

/**
 * How much body the accent needs when poured as glass (Play, primary buttons; R2.1): the lowest
 * opacity, from `min` up, at which the glyph on it (onAccent) still reads at `target` over every
 * paper of the theme. A light accent under an ink glyph only gains contrast as paper shows
 * through, so it stays clear; a dark accent under a white glyph gets more body. The user's colour
 * itself is never changed.
 */
export function accentGlassAlpha(fillHex: string, backgroundsHex: string[], min = 0.74, target = 4): number {
  const fill = accentOrDefault(fillHex);
  const glyph = parseHex(onAccent(fillHex))!;
  const papers = backgroundsHex.map(parseHex).filter((c): c is Rgb => !!c);
  for (let step = Math.round(min * 50); step < 50; step++) {
    const alpha = step / 50;
    if (papers.every(paper => contrast(mix(paper, fill, alpha), glyph) >= target)) return alpha;
  }
  return 1;
}

/** Lighter and deeper ends of the liquid gradient on accent objects. */
export function accentRamp(accentHex: string, dark = false): { hi: string; lo: string; edge: string } {
  const fill = accentOrDefault(accentHex);
  return {
    hi: toHex(mix(fill, [255, 255, 255], 0.4)),
    lo: toHex(mix(fill, dark ? [0, 0, 0] : parseHex(DEEP)!, dark ? 0.28 : 0.2)),
    edge: rgba(toHex(mix(fill, parseHex(DEEP)!, 0.45)), dark ? 0.7 : 0.4),
  };
}

export function rgba(hex: string, alpha: number): string {
  const rgb = accentOrDefault(hex);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Stable small hash for generated placeholder art. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

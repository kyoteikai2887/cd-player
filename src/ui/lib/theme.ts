import type { SettingsPatch, UserSettings } from '../../contracts/player.ts';
import { deriveAccentInk, mix, parseHex, toHex, DEFAULT_ACCENT } from './color.ts';

/**
 * Visual theme (Claude, R1.1). Stored without changing the frozen 0.2.0 enum:
 *   settings.ui.main.materialTheme  absent | 'standard' → follow settings.background ('light' | 'blue')
 *                                    'charcoal'          → the grey-black glass theme
 * Both surfaces read ui.main, so the main window and the mini window always match.
 */
export type ThemeName = 'light' | 'blue' | 'charcoal';
export const MATERIAL_THEME_KEY = 'materialTheme';

export const THEME_LABEL: Record<ThemeName, string> = { light: '纸白', blue: '阿根廷蓝', charcoal: '灰黑' };

export function resolveTheme(settings: Pick<UserSettings, 'background' | 'ui'>): ThemeName {
  const material = settings.ui?.main?.[MATERIAL_THEME_KEY];
  if (material === 'charcoal') return 'charcoal';
  return settings.background === 'blue' ? 'blue' : 'light';
}

/** One updateSettings patch per choice; other ui.main keys are untouched by the core's per-key merge. */
export function themePatch(theme: ThemeName): SettingsPatch {
  if (theme === 'charcoal') return { ui: { main: { [MATERIAL_THEME_KEY]: 'charcoal' } } };
  return { background: theme, ui: { main: { [MATERIAL_THEME_KEY]: 'standard' } } };
}

export const isDarkTheme = (theme: ThemeName) => theme === 'charcoal';

/**
 * Backgrounds that text may sit on in each theme (paper shades, raised glass, pools).
 * Used to derive an accent tone that stays readable as text.
 */
export const THEME_TEXT_BACKGROUNDS: Record<ThemeName, string[]> = {
  light: ['#F6F9FD', '#EDF3FA', '#E1EBF6', '#FFFFFF'],
  blue: ['#C7DFF5', '#BBD9F3', '#B0D2F0', '#F4F9FE'],
  charcoal: ['#121519', '#191D23', '#20252D', '#2A3039'],
};

/**
 * 灰黑 only: the raised glass (sheets, editors, dialogs, menus) is lighter than the paper shades
 * above — frost grain and sheen — so accent text there is derived for its lightest tone (rendered
 * surfaces, 2nd percentile behind text) and for an accent badge on a selected row, whose tinted
 * well is --accent-well in tokens.css. Applied inside those surfaces only; the paper keeps its own.
 */
export const CHARCOAL_RAISED_GLASS = { lightest: '#4B525D', selectedRow: '#5B6169' };
export function raisedAccentInk(accent: string): string {
  const tint = parseHex(accent) ?? parseHex(DEFAULT_ACCENT)!;
  // color-mix(accent 18%, rgb(0 0 0 / 0.3)) is the accent at 42% depth with 0.426 alpha.
  const well = mix(parseHex(CHARCOAL_RAISED_GLASS.selectedRow)!, mix([0, 0, 0], tint, 0.18 / 0.426), 0.426);
  return deriveAccentInk(accent, [...THEME_TEXT_BACKGROUNDS.charcoal, CHARCOAL_RAISED_GLASS.lightest, toHex(well)]);
}

/** Default accent: Argentine blue, the user's base colour. */
export const ARGENTINE_BLUE = '#6CACE4';

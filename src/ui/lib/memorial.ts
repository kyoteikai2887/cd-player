import type { SettingsPatch, UserSettings } from '../../contracts/player.ts';

/**
 * The memorial plates (Claude, core.27): the silhouettes of Codex and Claude, etched into the
 * stage glass and engraved on an equipment plate in the instrumental lyrics pane.
 * Stored like materialTheme, in the free ui.main object: absent shows them, an explicit false
 * hides them. No contract field, default or migration is involved.
 */
export const MEMORIAL_PLATES_KEY = 'memorialPlates';

export function showMemorialPlates(settings: Pick<UserSettings, 'ui'>): boolean {
  return settings.ui?.main?.[MEMORIAL_PLATES_KEY] !== false;
}

/** One local patch per switch; the core merges ui.main per key, so nothing else is touched. */
export function memorialPlatesPatch(on: boolean): SettingsPatch {
  return { ui: { main: { [MEMORIAL_PLATES_KEY]: on } } };
}

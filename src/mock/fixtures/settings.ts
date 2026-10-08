import type { UserSettings } from '../../contracts/player.ts';

export function createDemoSettings(): UserSettings {
  return { lyricsMode: 'bilingual', accentColor: '#6CACE4', background: 'light', fontScale: 1,
    lyricsScale: 1, glassIntensity: 0.65, motion: 'system', showDiscAnimation: false,
    miniAlwaysOnTop: true, miniShowLyrics: false, ui: { main: {}, mini: {} } };
}

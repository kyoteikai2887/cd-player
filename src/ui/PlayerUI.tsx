import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { PlayerUIProps } from '../contracts/player.ts';
import { ActionsProvider } from './lib/actions.tsx';
import { DirtyProvider } from './lib/drafts.tsx';
import { accentFill, accentGlassAlpha, accentRamp, deriveAccentInk, onAccent, parseHex, DEFAULT_ACCENT, rgba } from './lib/color.ts';
import { crystalVars } from './lib/crystal.ts';
import { useMediaQuery } from './lib/env.ts';
import { indexLibrary } from './lib/library.ts';
import { PlayerContext, SurfaceContext } from './lib/surface.tsx';
import type { SurfaceState } from './lib/surface.tsx';
import { isDarkTheme, raisedAccentInk, resolveTheme, THEME_TEXT_BACKGROUNDS } from './lib/theme.ts';
import { MainSurface } from './views/MainSurface.tsx';
import { MiniSurface } from './views/MiniSurface.tsx';

/**
 * Single integration entry (contract 0.2.0). Controlled by the snapshot; all intent goes
 * through onAction. Navigation, search, overlays and previews are local UI state only.
 * The theme is read from settings.ui.main for both surfaces (see lib/theme.ts).
 */
export function PlayerUI({ snapshot, surface, onAction }: PlayerUIProps) {
  const { settings, host, library, player } = snapshot;
  const osReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const reduced = host.effectiveReducedMotion || settings.motion === 'reduced' || (settings.motion === 'system' && osReduced);
  const index = useMemo(() => indexLibrary(library), [library]);
  const currentTrack = player.currentTrackId ? index.tracksById.get(player.currentTrackId) ?? null : null;
  const currentAlbum = currentTrack ? index.albumsById.get(currentTrack.albumId) ?? null : null;
  const theme = resolveTheme(settings);

  const vars = useMemo(() => {
    const dark = isDarkTheme(theme);
    const accent = parseHex(settings.accentColor) ? settings.accentColor.toUpperCase() : DEFAULT_ACCENT;
    const fill = accentFill(accent);
    const ramp = accentRamp(fill, dark);
    const intensity = Math.min(1, Math.max(0, Number.isFinite(settings.glassIntensity) ? settings.glassIntensity : 0.65));
    const fontScale = Math.min(1.3, Math.max(0.85, settings.fontScale || 1));
    return {
      '--accent': accent,
      '--accent-ink': deriveAccentInk(accent, THEME_TEXT_BACKGROUNDS[theme]),
      // 灰黑 sheets, editors and menus are lighter than the paper (tokens.css, raised glass).
      '--accent-ink-raised': theme === 'charcoal' ? raisedAccentInk(accent) : undefined,
      '--accent-fill': fill,
      '--accent-hi': ramp.hi,
      '--accent-lo': ramp.lo,
      '--accent-edge': ramp.edge,
      '--on-accent': onAccent(fill),
      '--accent-soft': rgba(accent, dark ? 0.2 : 0.14),
      '--accent-ring': rgba(accent, dark ? 0.45 : 0.35),
      '--accent-shadow': rgba(fill, dark ? 0.3 : 0.36),
      // Accent pill buttons (Apply, Save) are tinted glass; this is the least body that keeps their
      // label at text contrast (4.5:1; core.23 — with the memorial orange it had been 4:1).
      '--accent-glass-auto': `${Math.round(accentGlassAlpha(fill, THEME_TEXT_BACKGROUNDS[theme], dark ? 0.86 : 0.74, 4.5) * 100)}%`,
      // Crystal transport controls: the accent inside clear glass, with a glyph that reads on it.
      ...crystalVars(fill, theme),
      // More transparent glass than R1: 0.78 → 0.32 body alpha across the intensity range.
      '--glass-a': String(Math.round((0.78 - 0.46 * intensity) * 100) / 100),
      '--glass-blur': `${Math.round(14 + 26 * intensity)}px`,
      '--fs': String(surface === 'mini' ? Math.min(1.1, fontScale) : fontScale),
      '--ls': String(Math.min(1.5, Math.max(0.8, settings.lyricsScale || 1))),
    } as CSSProperties;
  }, [theme, settings.accentColor, settings.glassIntensity, settings.fontScale, settings.lyricsScale, surface]);

  const state = useMemo<SurfaceState>(() => ({
    surface, library, index, settings, host, currentTrack, currentAlbum, reduced, theme,
    visible: host.surfaceVisible, online: host.coreStatus === 'ready',
  }), [surface, library, index, settings, host, currentTrack, currentAlbum, reduced, theme]);

  const solid = settings.glassIntensity <= 0 || !host.transparencyAllowed;
  return (
    <SurfaceContext.Provider value={state}>
      <PlayerContext.Provider value={player}>
        <ActionsProvider onAction={onAction}>
          <DirtyProvider surface={surface} onAction={onAction}>
          <div className="cdp" data-surface={surface} data-theme={theme}
            data-motion={reduced ? 'reduced' : 'full'} data-solid={solid ? 'true' : 'false'}
            data-backdrop={host.backdrop} data-visible={host.surfaceVisible ? 'true' : 'false'} style={vars}>
            {surface === 'mini' ? <MiniSurface snapshot={snapshot} /> : <MainSurface snapshot={snapshot} />}
          </div>
          </DirtyProvider>
        </ActionsProvider>
      </PlayerContext.Provider>
    </SurfaceContext.Provider>
  );
}

import { createContext, useContext } from 'react';
import type { Album, HostInfo, LibrarySnapshot, PlayerSnapshot, Surface, Track, UserSettings } from '../../contracts/player.ts';
import type { LibraryIndex } from './library.ts';
import type { ThemeName } from './theme.ts';

/**
 * Stable per-surface state. Every member keeps its reference across position ticks
 * (library/settings/host are structurally shared by the bridge), so consumers do not
 * re-render 5 times per second. Fast-changing playback state lives in PlayerContext.
 */
export interface SurfaceState {
  surface: Surface;
  library: LibrarySnapshot;
  index: LibraryIndex;
  settings: UserSettings;
  host: HostInfo;
  currentTrack: Track | null;
  currentAlbum: Album | null;
  /** Effective reduced motion: host result, user setting, and the OS query when the setting is "system". */
  reduced: boolean;
  /** Resolved look, shared by main and mini (settings.ui.main.materialTheme, else background). */
  theme: ThemeName;
  /** This surface is actually visible; hidden surfaces stop timers, rAF and decorative motion. */
  visible: boolean;
  /** The core is reachable; transport and saves are disabled when it is not. */
  online: boolean;
}

export const SurfaceContext = createContext<SurfaceState | null>(null);
export const PlayerContext = createContext<PlayerSnapshot | null>(null);

export function useSurface(): SurfaceState {
  const value = useContext(SurfaceContext);
  if (!value) throw new Error('useSurface must be used inside PlayerUI');
  return value;
}

/** Playback snapshot (changes with every position sample). Use only in small leaf components. */
export function usePlayer(): PlayerSnapshot {
  const value = useContext(PlayerContext);
  if (!value) throw new Error('usePlayer must be used inside PlayerUI');
  return value;
}

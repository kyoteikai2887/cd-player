import { createContext, useContext, useEffect, useState } from 'react';
import type { LyricsDocument } from '../../contracts/player.ts';
import type { Album, Track } from '../../contracts/player.ts';
import type { LyricsDraft } from './lyricsDraft.ts';
import type { AlbumForm, TrackForm } from './metadataDraft.ts';

/** matchMedia with a safe fallback (jsdom and very old shells have none). */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

export const supportsViewTransitions = () =>
  typeof document !== 'undefined' && typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === 'function';

/**
 * Runs a DOM update inside a same-document View Transition when available and motion is allowed;
 * otherwise runs it directly. The update must flush synchronously (flushSync) to be captured.
 */
export function withViewTransition(update: () => void, reduced: boolean) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (reduced || !doc.startViewTransition) { update(); return; }
  try { doc.startViewTransition(update).finished.catch(() => undefined); } catch { update(); }
}

/** Preview-only initial UI state (route, overlay, tab, query). Production code never provides it. */
export interface UIBoot {
  route?: { name: 'library' } | { name: 'album'; albumId: string } | { name: 'nowPlaying' };
  libraryTab?: 'albums' | 'works' | 'artists';
  query?: string;
  overlay?: 'settings' | null;
  nowPlayingTab?: 'lyrics' | 'album' | 'queue';
  /** Force the mini hover controls visible for static review. */
  miniShowControls?: boolean;
  /** Initial shelf scroll offset, so a static frame can show glass over covers. */
  scrollTop?: number;
  /** Static frames of the lyrics editor with unsaved work, a conflict or an open prompt. */
  lyricsEditor?: LyricsEditorBoot;
  /** Opens the metadata editor in a static frame. */
  metadataEditor?: MetadataEditorBoot;
  /** Opens the remove-album confirmation in a static frame (R2.2). */
  removeAlbum?: RemoveAlbumBoot;
  /** Static frames of the lyric candidates sheet (R2.3); the review itself comes from the snapshot. */
  lyricsReview?: LyricsReviewBoot;
}
export interface LyricsReviewBoot {
  /** Candidate shown in the preview. */
  candidateIndex?: number;
  /** Search terms as typed (not yet searched). */
  query?: { title: string; artist: string };
  /** An adoption that came back refused. */
  failure?: { code: 'conflict' | 'locked'; message: string };
  /** A failure shown inline in the sheet. */
  error?: string;
  /** Preview shows the source's translation under the original. */
  bilingual?: boolean;
}
export interface RemoveAlbumBoot {
  albumId: string;
  /** Shows the "changed before you confirmed" state. */
  conflict?: boolean;
  /** Shows a failure message in the dialog. */
  error?: string;
  /** Shows the confirm button as in progress. */
  pending?: boolean;
  /** Offsets the remembered revision (static frames only). */
  revisionOffset?: number;
  /** Unsaved drafts to list, by label (static frames only; live drafts come from the editors). */
  drafts?: string[];
}
export interface MetadataEditorBoot {
  albumId: string;
  /** Entry shown first: 'album' or a track id. */
  select?: string;
  /** The drafts started from an older saved version (conflict frames). */
  staleAlbum?: (album: Album) => Album;
  staleTrack?: (track: Track) => Track;
  editAlbum?: (form: AlbumForm) => AlbumForm;
  editTrack?: (form: TrackForm, track: Track) => TrackForm;
  compare?: string;
  confirm?: { id: string; kind: 'loadLatest' | 'overwrite' };
  closing?: boolean;
}
export interface LyricsEditorBoot {
  /** The draft started from an older saved version (conflict frames). */
  base?: (latest: LyricsDocument) => LyricsDocument;
  /** Unsaved edits applied to the opened draft. */
  edit?: (draft: LyricsDraft) => LyricsDraft;
  view?: 'compare';
  mode?: 'tap';
  cursorIndex?: number;
  showIssues?: boolean;
  closing?: boolean;
  confirm?: 'loadLatest' | 'overwrite' | 'clear' | 'toPlain' | 'align';
  note?: { message: string; warnings: string[]; canAlign: boolean };
}
export const UIBootContext = createContext<UIBoot>({});
export const useBoot = () => useContext(UIBootContext);

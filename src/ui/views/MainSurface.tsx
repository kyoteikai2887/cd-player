import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { UISnapshot } from '../../contracts/player.ts';
import { useActions } from '../lib/actions.tsx';
import { useDirtyKeys, useDraftStash } from '../lib/drafts.tsx';
import { useBoot, withViewTransition } from '../lib/env.ts';
import type { UIBoot } from '../lib/env.ts';
import type { SortKey } from '../lib/library.ts';
import { useSurface } from '../lib/surface.tsx';
import { AlbumDetail } from './AlbumDetail.tsx';
import { LibraryView } from './LibraryView.tsx';
import { NowPlaying } from './NowPlaying.tsx';
import { PlayerCapsule } from './PlayerCapsule.tsx';
import { SettingsSheet } from './SettingsSheet.tsx';
import { LyricsEditorSheet } from './LyricsEditorSheet.tsx';
import { MetadataEditor } from './MetadataEditor.tsx';
import { MetadataReviewSheet } from './MetadataReviewSheet.tsx';
import { LyricsReviewSheet } from './LyricsReviewSheet.tsx';
import { RemoveAlbumDialog } from './RemoveAlbumDialog.tsx';
import type { RemovalDraft } from './RemoveAlbumDialog.tsx';
import { Notices, CoreBanner } from './Notices.tsx';
import { TopBar } from './TopBar.tsx';
import styles from './MainSurface.module.css';

export type Route = NonNullable<UIBoot['route']>;
export type LibraryTab = 'albums' | 'works' | 'artists';
const TABS: LibraryTab[] = ['albums', 'works', 'artists'];
const SORTS: SortKey[] = ['added', 'title', 'artist', 'year'];

export function MainSurface({ snapshot }: { snapshot: UISnapshot }) {
  const boot = useBoot();
  const { settings, index, reduced, currentTrack, currentAlbum, visible, online } = useSurface();
  const { run, show } = useActions();
  const prefs = settings.ui.main ?? {};
  const [route, setRoute] = useState<Route>(boot.route ?? { name: 'library' });
  const [tab, setTab] = useState<LibraryTab>(boot.libraryTab ?? (TABS.includes(prefs.libraryTab as LibraryTab) ? prefs.libraryTab as LibraryTab : 'albums'));
  const [sort, setSort] = useState<SortKey>(SORTS.includes(prefs.sort as SortKey) ? prefs.sort as SortKey : 'added');
  const [query, setQuery] = useState(boot.query ?? '');
  const [settingsOpen, setSettingsOpen] = useState(boot.overlay === 'settings');
  /** The metadata editor is UI-local: its drafts live in it until saved or discarded. */
  const [metaEdit, setMetaEdit] = useState<{ albumId: string; trackId?: string } | null>(() =>
    boot.metadataEditor ? { albumId: boot.metadataEditor.albumId } : null);
  const [heroAlbumId, setHeroAlbumId] = useState<string | null>(route.name === 'album' ? route.albumId : null);
  /** Removing an album: which one, and the library revision on screen when the user asked. */
  const [removal, setRemoval] = useState<{ albumId: string; revision: number } | null>(() =>
    boot.removeAlbum ? { albumId: boot.removeAlbum.albumId, revision: snapshot.library.revision + (boot.removeAlbum.revisionOffset ?? 0) } : null);
  const libraryRevision = useRef(snapshot.library.revision);
  libraryRevision.current = snapshot.library.revision;
  /** A lyric review the user closed stays closed here, even if a late snapshot still carries it. */
  const [dismissedReview, setDismissedReview] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<HTMLDivElement>(null);

  // An album route whose album disappeared (rescan, removal) falls back to the shelf.
  const routeAlbum = route.name === 'album' ? index.albumsById.get(route.albumId) ?? null : null;
  const effective: Route = route.name === 'album' && !routeAlbum ? { name: 'library' } : route;

  const returnTo = useRef<Route>({ name: 'library' });
  const routeRef = useRef(route);
  routeRef.current = route;
  const navigate = useCallback((next: Route, heroId?: string | null) => {
    if (next.name === 'nowPlaying' && routeRef.current.name !== 'nowPlaying') returnTo.current = routeRef.current;
    // Name the shared cover in the *old* state first, so the transition can morph it.
    if (heroId !== undefined) flushSync(() => setHeroAlbumId(heroId));
    withViewTransition(() => flushSync(() => setRoute(next)), reduced);
  }, [reduced]);

  const persist = useCallback((patch: Record<string, string>) => {
    void run({ type: 'updateSettings', patch: { ui: { main: patch } } }, { slot: 'settings', key: 'persist-ui' });
  }, [run]);

  const onSort = useCallback((next: SortKey) => { setSort(next); persist({ sort: next }); }, [persist]);

  // ── Removing an album ─────────────────────────────────────────────────────
  const dirtyKeys = useDirtyKeys();
  const stash = useDraftStash();
  const openRemoval = useCallback((albumId: string) => setRemoval({ albumId, revision: libraryRevision.current }), []);
  /** Unsaved drafts that would lose their subject: lyrics of its tracks (open or set aside), its metadata. */
  const removalDrafts = useMemo<RemovalDraft[]>(() => {
    const album = removal ? index.albumsById.get(removal.albumId) : null;
    if (!album) return [];
    const ids = new Set(album.trackIds);
    const name = (trackId: string) => `「${index.tracksById.get(trackId)?.title ?? '未知曲目'}」的歌词`;
    const out: RemovalDraft[] = [];
    const editing = snapshot.lyricsEditor?.trackId;
    if (editing && ids.has(editing) && dirtyKeys.includes('lyrics-editor')) out.push({ key: 'lyrics:' + editing, label: name(editing), open: true });
    for (const entry of stash.entries) {
      const trackId = entry.key.startsWith('lyrics:') ? entry.key.slice('lyrics:'.length) : null;
      if (trackId && ids.has(trackId) && trackId !== editing) out.push({ key: entry.key, label: name(trackId) });
    }
    if (metaEdit?.albumId === album.id && dirtyKeys.includes('metadata-editor')) out.push({ key: 'metadata-editor', label: '专辑与曲目资料', open: true });
    return out;
  }, [removal, index, snapshot.lyricsEditor, dirtyKeys, stash.entries, metaEdit]);
  const onRemoved = useCallback(() => {
    const albumId = removal?.albumId;
    setRemoval(null);
    if (metaEdit?.albumId === albumId) setMetaEdit(null);
    // Views of the album fall back to the shelf; make that the real route, not just the effective one.
    if (routeRef.current.name === 'album' && routeRef.current.albumId === albumId) navigate({ name: 'library' }, null);
    if (returnTo.current.name === 'album' && returnTo.current.albumId === albumId) returnTo.current = { name: 'library' };
  }, [removal, metaEdit, navigate]);
  const onRemovalGone = useCallback(() => {
    setRemoval(null);
    show('library', '这张专辑已经不在收藏里了。');
  }, [show]);
  const openAlbum = useCallback((albumId: string) => navigate({ name: 'album', albumId }, albumId), [navigate]);
  const openNowPlaying = useCallback(() => navigate({ name: 'nowPlaying' }, currentAlbum?.id ?? null), [navigate, currentAlbum]);
  /** Now playing returns to where it was opened from; an album returns to the shelf. */
  const back = useCallback(() => {
    if (routeRef.current.name === 'nowPlaying') {
      const target = returnTo.current;
      const valid = target.name !== 'album' || index.albumsById.has(target.albumId);
      navigate(valid ? target : { name: 'library' }, target.name === 'album' ? target.albumId : currentAlbum?.id ?? null);
    } else navigate({ name: 'library' }, routeRef.current.name === 'album' ? routeRef.current.albumId : null);
  }, [navigate, index, currentAlbum]);

  // The top bar turns into acrylic once content scrolls beneath it (no React render per scroll).
  useEffect(() => {
    const views = viewsRef.current, bar = barRef.current;
    if (!views || !bar) return;
    let frame = 0;
    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement;
      if (frame || typeof requestAnimationFrame !== 'function') return;
      frame = requestAnimationFrame(() => { frame = 0; bar.dataset.scrolled = target.scrollTop > 4 ? 'true' : 'false'; });
    };
    views.addEventListener('scroll', onScroll, true);
    return () => { views.removeEventListener('scroll', onScroll, true); if (frame) cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    const bar = barRef.current, views = viewsRef.current;
    if (!bar || !views) return;
    const active = views.querySelector<HTMLElement>(route.name === 'album' ? '[data-scroller="album"]' : '[data-scroller="library"]');
    bar.dataset.scrolled = active && active.scrollTop > 4 ? 'true' : 'false';
  }, [route]);

  // In-window shortcuts only while this surface is visible; media keys belong to the native layer.
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (effective.name === 'nowPlaying') navigate({ name: 'library' });
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (editing) return;
      if (event.key === ' ' && !(target instanceof HTMLButtonElement) && !(target?.getAttribute('role') === 'menuitem')) {
        event.preventDefault();
        void run({ type: 'togglePlayback' }, { slot: 'transport', key: 'togglePlayback' });
      } else if (event.key === 'Escape' && !settingsOpen && effective.name !== 'library') {
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, effective.name, settingsOpen, navigate, back, run]);

  const inNowPlaying = effective.name === 'nowPlaying';
  const hasPlayback = !!currentTrack || snapshot.player.queue.length > 0;
  return (
    <div className={styles.main}>
      <div className={styles.backdrop} aria-hidden="true" />
      <div className={styles.frame} inert={inNowPlaying || undefined} aria-hidden={inNowPlaying || undefined}
        data-covered={inNowPlaying ? 'true' : 'false'}
        style={{ ['--bar-h' as string]: online ? '64px' : '118px' }}>
        <div ref={barRef} className={styles.barWrap} data-scrolled="false">
          <TopBar route={effective} tab={tab} query={query} searchRef={searchRef} tasks={snapshot.tasks}
            onTab={next => { setTab(next); persist({ libraryTab: next }); }}
            onQuery={setQuery} onBack={back}
            onOpenSettings={() => setSettingsOpen(true)} libraryEmpty={!snapshot.library.albums.length} />
          <CoreBanner />
        </div>
        <div ref={viewsRef} className={styles.views}>
          <LibraryView hidden={effective.name !== 'library'} tab={tab} sort={sort} query={query}
            onSort={onSort}
            onOpenAlbum={openAlbum} onOpenNowPlaying={openNowPlaying} heroAlbumId={effective.name === 'library' ? heroAlbumId : null}
            playingAlbumId={currentAlbum?.id ?? null} />
          {effective.name === 'album' && routeAlbum && (
            <AlbumDetail key={routeAlbum.id} album={routeAlbum} lyricsByCurrent={snapshot.lyrics} tasks={snapshot.tasks}
              onOpenNowPlaying={openNowPlaying} onEditMetadata={trackId => setMetaEdit({ albumId: routeAlbum.id, trackId })}
              onRemove={() => openRemoval(routeAlbum.id)} />
          )}
        </div>
      </div>
      {hasPlayback && !inNowPlaying && <PlayerCapsule onOpenNowPlaying={openNowPlaying} />}
      {inNowPlaying && (
        <NowPlaying snapshot={snapshot} initialTab={boot.nowPlayingTab}
          onBack={back}
          onOpenAlbum={albumId => navigate({ name: 'album', albumId }, albumId)} />
      )}
      <Notices notices={snapshot.notices} placement={inNowPlaying ? 'nowPlaying' : hasPlayback ? 'capsule' : 'plain'} />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {metaEdit && <MetadataEditor key={metaEdit.albumId} albumId={metaEdit.albumId} focusTrackId={metaEdit.trackId}
        tasks={snapshot.tasks} onClose={() => setMetaEdit(null)} />}
      {snapshot.lyricsEditor && <LyricsEditorSheet editor={snapshot.lyricsEditor} tasks={snapshot.tasks} />}
      {snapshot.metadataReview && <MetadataReviewSheet review={snapshot.metadataReview} />}
      {snapshot.lyricsReview && snapshot.lyricsReview.id !== dismissedReview && (
        <LyricsReviewSheet key={snapshot.lyricsReview.trackId} review={snapshot.lyricsReview} editor={snapshot.lyricsEditor}
          lyrics={snapshot.lyrics} onDismiss={setDismissedReview} />
      )}
      {removal && <RemoveAlbumDialog key={removal.albumId} albumId={removal.albumId} openedRevision={removal.revision}
        drafts={boot.removeAlbum?.drafts ? [...removalDrafts, ...boot.removeAlbum.drafts.map((label, i) => ({ key: 'seed:' + i, label }))] : removalDrafts}
        seed={boot.removeAlbum} onCancel={() => setRemoval(null)} onRemoved={onRemoved} onGone={onRemovalGone} />}
    </div>
  );
}

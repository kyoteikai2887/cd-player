import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Album, Track } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { DiscArt } from '../components/DiscArt.tsx';
import { Icon } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import { useActions } from '../lib/actions.tsx';
import { formatClock } from '../lib/clock.ts';
import { groupByArtist, groupByWork, searchLibrary, sortAlbums, SORT_LABEL } from '../lib/library.ts';
import type { AlbumGroup, SortKey } from '../lib/library.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { langHint, versionBadge } from '../lib/text.ts';
import { useBoot } from '../lib/env.ts';
import type { LibraryTab } from './MainSurface.tsx';
import { EmptyLibrary } from './EmptyLibrary.tsx';
import { Spotlight, formatRunningTime } from './Spotlight.tsx';
import styles from './LibraryView.module.css';

interface LibraryViewProps {
  hidden: boolean;
  tab: LibraryTab;
  sort: SortKey;
  query: string;
  heroAlbumId: string | null;
  playingAlbumId: string | null;
  onSort(sort: SortKey): void;
  onOpenAlbum(albumId: string): void;
  onOpenNowPlaying(): void;
}

/**
 * The shelf. A stage at the top for the album in the player (or the newest arrival), then the
 * covers on the paper, each lit by its own colours. Chrome is icons; words are kept for content.
 */
export const LibraryView = memo(function LibraryView({ hidden, tab, sort, query, heroAlbumId, playingAlbumId, onSort, onOpenAlbum, onOpenNowPlaying }: LibraryViewProps) {
  const { library, index } = useSurface();
  const sorted = useMemo(() => sortAlbums(library.albums, sort), [library.albums, sort]);
  const totalMs = useMemo(() => library.tracks.reduce((sum, t) => sum + t.durationMs, 0), [library.tracks]);
  const results = useMemo(() => query.trim() ? searchLibrary(library, index, query) : null, [library, index, query]);
  const groups = useMemo<AlbumGroup[] | null>(() => tab === 'works' ? groupByWork(sorted) : tab === 'artists' ? groupByArtist(sorted) : null, [tab, sorted]);
  const scroller = useRef<HTMLElement>(null);
  const boot = useBoot();
  useLayoutEffect(() => { if (boot.scrollTop && scroller.current) scroller.current.scrollTop = boot.scrollTop; }, [boot.scrollTop]);

  const grid = (albums: Album[]) => (
    <ul className={styles.grid}>
      {albums.map(album => (
        <li key={album.id}>
          <AlbumTile album={album} hero={album.id === heroAlbumId} playing={album.id === playingAlbumId} onOpen={onOpenAlbum} />
        </li>
      ))}
    </ul>
  );

  return (
    <>
    {/* Wide windows (V1.1): two discs at the sides of the desk, out of the way of everything. */}
    {!hidden && library.albums.length > 0 && <span className={styles.sides} aria-hidden="true" data-decor="sides"><i data-side="start" /><i data-side="end" /></span>}
    <section ref={scroller} className={styles.scroller} data-scroller="library" data-hidden={hidden ? 'true' : 'false'} inert={hidden || undefined}
      aria-hidden={hidden || undefined} aria-label="收藏">
      {!library.albums.length ? <EmptyLibrary /> : (
        <div className={styles.inner}>
          {results ? (
            <SearchResults query={query} albums={sortAlbums(results.albums, sort)} tracks={results.tracks} grid={grid} />
          ) : (
            <>
              <Spotlight onOpenAlbum={onOpenAlbum} onOpenNowPlaying={onOpenNowPlaying} />
              <div className={styles.head}>
                <ul className={styles.summary} aria-label="收藏统计">
                  <li title="专辑"><Icon name="shelf" size={15} /><span className="num">{library.albums.length}</span><span className="sr-only">张专辑</span></li>
                  <li title="曲目"><Icon name="note" size={15} /><span className="num">{library.tracks.length}</span><span className="sr-only">首曲目</span></li>
                  <li title="总时长"><Icon name="clock" size={15} /><span className="num">{formatRunningTime(totalMs)}</span><span className="sr-only">总时长</span></li>
                </ul>
                <Menu label={`排序：${SORT_LABEL[sort]}`} align="end" items={(Object.keys(SORT_LABEL) as SortKey[]).map(key => ({
                  label: SORT_LABEL[key], icon: key === sort ? 'check' as const : undefined, onSelect: () => onSort(key),
                }))} trigger={({ open, toggle, id, ref }) => (
                  <button ref={ref} type="button" className={styles.sort} aria-haspopup="menu" aria-expanded={open}
                    aria-controls={open ? id : undefined} onClick={toggle} aria-label={`排序：${SORT_LABEL[sort]}`} title={`排序：${SORT_LABEL[sort]}`}>
                    <Icon name="sort" size={17} />
                    <span className={styles.sortWord} aria-hidden="true">{SORT_LABEL[sort]}</span>
                  </button>
                )} />
              </div>
              {groups ? groups.map(group => (
                <section key={group.key} className={styles.group} aria-label={group.title ?? '未关联作品'}>
                  <h2 className={styles.groupTitle}>
                    <span lang={langHint(group.title)}>{group.title ?? '未关联作品'}</span>
                    <span className={styles.groupCount} title={`${group.albums.length} 张专辑`}><Icon name="shelf" size={13} /><span className="num">{group.albums.length}</span></span>
                  </h2>
                  {grid(group.albums)}
                </section>
              )) : grid(sorted)}
            </>
          )}
        </div>
      )}
    </section>
    </>
  );
});

const AlbumTile = memo(function AlbumTile({ album, hero, playing, onOpen }: { album: Album; hero: boolean; playing: boolean; onOpen(id: string): void }) {
  const { run } = useActions();
  const { online } = useSurface();
  const lang = langHint(album.title, null, album.language);
  return (
    <div className={styles.tile} data-playing={playing ? 'true' : 'false'}>
      <TileGlow album={album} />
      {/* The album in the player keeps its disc out of the case. Only the stage's disc turns: one moving thing per screen. */}
      <DiscArt albumId={album.id} title={album.title} cover={album.cover} className={styles.tileDisc} />
      <button type="button" className={styles.tileOpen} onClick={() => onOpen(album.id)}>
        <Cover albumId={album.id} title={album.title} lang={lang} cover={album.cover} className={styles.tileCover}
          style={hero ? { viewTransitionName: 'cdp-hero' } : undefined} />
        <span className={styles.tileTitle} lang={lang}>{album.title}</span>
        <span className={styles.tileCredit} lang={langHint(album.albumArtistCredit, null, album.language)}>{album.albumArtistCredit}</span>
      </button>
      {playing && <PlayingTag />}
      <button type="button" className={`cdp-play cdp-play--sm ${styles.tilePlay}`} aria-label={`播放 ${album.title}`} title="播放" disabled={!online}
        onClick={() => run({ type: 'playAlbum', albumId: album.id }, { slot: 'library', key: 'play-' + album.id })}>
        <Icon name="play" size={17} />
      </button>
    </div>
  );
});

/** The album in the player: an EQ bead on the cover instead of a caption. */
function PlayingTag() {
  const player = usePlayer();
  const playing = player.status === 'playing';
  return (
    <span className={`${styles.playingTag} glass-flat`} title={playing ? '正在播放' : '已暂停'}>
      <span className="cdp-eq" data-paused={playing ? 'false' : 'true'} aria-hidden="true"><i /><i /><i /></span>
      <span className="sr-only">{playing ? '正在播放' : '已暂停'}</span>
    </span>
  );
}


/** A soft pool of the cover's own colours under it (the image, blurred), instead of a grey shadow. */
function TileGlow({ album }: { album: Album }) {
  const url = album.cover?.thumbUrl;
  return (
    <span className={styles.tileGlow} aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} loading="lazy" decoding="async" /> : <i />}
    </span>
  );
}

function SearchResults({ query, albums, tracks, grid }: { query: string; albums: Album[]; tracks: Track[]; grid: (albums: Album[]) => ReactNode }) {
  const { index } = useSurface();
  const { run } = useActions();
  if (!albums.length && !tracks.length) {
    return (
      <div className={styles.noResults} role="status">
        <p className={styles.noResultsTitle}>没有找到“{query}”</p>
        <p>试试作品名、歌手或 CV 的名字，或者 CD 侧标上的品番。</p>
      </div>
    );
  }
  return (
    <>
      {albums.length > 0 && (
        <section className={styles.group} aria-label="匹配的专辑">
          <h2 className={styles.groupTitle}>专辑<span className={styles.groupCount}>{albums.length}</span></h2>
          {grid(albums)}
        </section>
      )}
      {tracks.length > 0 && (
        <section className={styles.group} aria-label="匹配的曲目">
          <h2 className={styles.groupTitle}>曲目<span className={styles.groupCount}>{tracks.length}</span></h2>
          <ol className={styles.trackResults}>
            {tracks.map((track, i) => {
              const album = index.albumsById.get(track.albumId);
              const badge = versionBadge(track.versionKind, track.versionLabel);
              const lang = langHint(track.title, track.language, album?.language);
              return (
                <li key={track.id}>
                  <button type="button" className={styles.trackResult} disabled={!track.available}
                    onClick={() => run({ type: 'playTracks', trackIds: tracks.map(t => t.id), startIndex: i }, { slot: 'library', key: 'play-' + track.id })}>
                    {album && <Cover albumId={album.id} title={album.title} cover={album.cover} className={styles.trackThumb} showTitleOnPlaceholder={false} />}
                    <span className={styles.trackMain}>
                      <span className={styles.trackTitle} lang={lang}>{track.title}{badge && <span className="cdp-badge">{badge}</span>}</span>
                      <span className={styles.trackSub} lang={langHint(track.artistCredit, null, album?.language)}>{track.artistCredit}</span>
                    </span>
                    <span className={styles.trackAlbum} lang={langHint(album?.title, null, album?.language)}>{album?.title}</span>
                    <span className={`${styles.trackTime} num`}>{formatClock(track.durationMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </>
  );
}

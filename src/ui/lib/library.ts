import type { Album, LibrarySnapshot, Track } from '../../contracts/player.ts';
import { matchesQuery, normalizeForSearch } from './text.ts';

export interface LibraryIndex {
  albumsById: Map<string, Album>;
  tracksById: Map<string, Track>;
  trackCount: number;
}

/** Memoise on the snapshot's library reference: it is stable across position ticks. */
export function indexLibrary(library: LibrarySnapshot): LibraryIndex {
  return {
    albumsById: new Map(library.albums.map(album => [album.id, album])),
    tracksById: new Map(library.tracks.map(track => [track.id, track])),
    trackCount: library.tracks.length,
  };
}

export function albumTracks(album: Album, index: LibraryIndex): Track[] {
  return album.trackIds.map(id => index.tracksById.get(id)).filter((t): t is Track => !!t);
}

export function albumDuration(album: Album, index: LibraryIndex): number {
  return albumTracks(album, index).reduce((sum, track) => sum + (track.durationMs || 0), 0);
}

export interface DiscGroup { number: number; title?: string; tracks: Track[] }

/** Groups by disc in the authoritative trackIds order; disc titles come from album.discs. */
export function groupByDisc(album: Album, index: LibraryIndex): DiscGroup[] {
  const groups = new Map<number, DiscGroup>();
  for (const disc of album.discs) groups.set(disc.number, { number: disc.number, title: disc.title, tracks: [] });
  for (const track of albumTracks(album, index)) {
    const group = groups.get(track.discNumber) ?? { number: track.discNumber, tracks: [] };
    group.tracks.push(track);
    groups.set(track.discNumber, group);
  }
  return [...groups.values()].filter(group => group.tracks.length).sort((a, b) => a.number - b.number);
}

export type SortKey = 'added' | 'title' | 'artist' | 'year';
export const SORT_LABEL: Record<SortKey, string> = { added: '最近添加', title: '标题', artist: '艺术家', year: '发行年份' };

const collator = new Intl.Collator(['ja', 'zh-Hans', 'en'], { sensitivity: 'base', numeric: true });

export function sortAlbums(albums: readonly Album[], key: SortKey): Album[] {
  const byTitle = (a: Album, b: Album) => collator.compare(a.titleSort ?? a.title, b.titleSort ?? b.title);
  const sorted = [...albums];
  switch (key) {
    case 'title': return sorted.sort(byTitle);
    case 'artist': return sorted.sort((a, b) => collator.compare(a.albumArtistCredit, b.albumArtistCredit) || byTitle(a, b));
    case 'year': return sorted.sort((a, b) => (b.releaseYear ?? 0) - (a.releaseYear ?? 0) || byTitle(a, b));
    default: return sorted.sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b));
  }
}

export interface AlbumGroup { key: string; title: string | null; albums: Album[] }

/** Works view: grouped by the saved workTitle only; albums without one go last. */
export function groupByWork(albums: readonly Album[]): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup>();
  const loose: Album[] = [];
  for (const album of albums) {
    const title = album.workTitle?.trim();
    if (!title) { loose.push(album); continue; }
    const key = normalizeForSearch(title);
    const group = groups.get(key) ?? { key, title, albums: [] };
    group.albums.push(album);
    groups.set(key, group);
  }
  const named = [...groups.values()].sort((a, b) => collator.compare(a.title!, b.title!));
  return loose.length ? [...named, { key: '__none__', title: null, albums: loose }] : named;
}

/** Artists view: each structured album artist gets a group (an album can appear under several). */
export function groupByArtist(albums: readonly Album[]): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup>();
  for (const album of albums) {
    const names = album.albumArtists.length ? album.albumArtists : [album.albumArtistCredit];
    for (const name of names) {
      const key = normalizeForSearch(name);
      const group = groups.get(key) ?? { key, title: name, albums: [] };
      if (!group.albums.includes(album)) group.albums.push(album);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => collator.compare(a.title!, b.title!));
}

export interface SearchResult { albums: Album[]; tracks: Track[] }

/** Client-side search across titles, credits, CV names, work titles and catalog numbers. */
export function searchLibrary(library: LibrarySnapshot, index: LibraryIndex, query: string): SearchResult {
  const q = normalizeForSearch(query);
  if (!q) return { albums: [...library.albums], tracks: [] };
  const albums = library.albums.filter(album => matchesQuery([
    album.title, album.albumArtistCredit, album.albumArtists.join(' '), album.workTitle ?? '',
    album.catalogNumber ?? '', album.label ?? '',
  ].join(' \u0000 '), q));
  const tracks = library.tracks.filter(track => {
    const album = index.albumsById.get(track.albumId);
    return matchesQuery([track.title, track.artistCredit, track.artists.join(' '), track.versionLabel ?? '',
      album?.title ?? '', album?.workTitle ?? ''].join(' \u0000 '), q);
  });
  return { albums, tracks };
}

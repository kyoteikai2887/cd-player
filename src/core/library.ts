import type { LibrarySnapshot, OperationError } from '../contracts/player.ts';

export type AlbumRemovalPlan =
  | { ok: true; library: LibrarySnapshot; trackIds: string[] }
  | ({ ok: false } & OperationError);

/** No I/O: UI confirmation uses the observed library revision, never a silent retry. */
export function planAlbumRemoval(library: LibrarySnapshot, albumId: string, baseLibraryRevision: number): AlbumRemovalPlan {
  if (typeof albumId !== 'string' || !albumId || !Number.isSafeInteger(baseLibraryRevision) || baseLibraryRevision < 0)
    return { ok: false, code: 'invalidAction', message: '移除请求无效。' };
  if (library.revision !== baseLibraryRevision)
    return { ok: false, code: 'conflict', message: '收藏已变化，请查看最新资料后重新确认移除。' };
  if (!library.albums.some(album => album.id === albumId))
    return { ok: false, code: 'notFound', message: '专辑已不在收藏中。' };
  const trackIds = library.tracks.filter(track => track.albumId === albumId).map(track => track.id);
  const removed = new Set(trackIds);
  return { ok: true, trackIds, library: { ...library, revision: library.revision + 1,
    albums: library.albums.filter(album => album.id !== albumId),
    tracks: library.tracks.filter(track => !removed.has(track.id)) } };
}

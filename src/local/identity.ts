import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { Stats } from 'node:fs';
import type { FileIdentity, LocalData } from './model.ts';
import { LocalError } from './model.ts';
import type { ScanResult } from './scanner.ts';

export interface IdentityObservation {
  trackId: string;
  file: LocalData['files'][string];
  identity: FileIdentity;
}
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new LocalError('unavailable', '扫描已取消。');
};

/** Bounded streaming read; never writes audio or follows a changed canonical path. */
export async function hashMusicFile(filename: string, expected: Pick<Stats, 'size' | 'mtimeMs'>, signal: AbortSignal) {
  check(signal);
  if (await realpath(filename) !== filename) throw new Error('Changed canonical path');
  const handle = await open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs)
      throw new Error('File changed before hashing');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      check(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      check(signal);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const currentPath = await stat(filename);
    check(signal);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      currentPath.dev !== before.dev || currentPath.ino !== before.ino || currentPath.size !== before.size ||
      currentPath.mtimeMs !== before.mtimeMs || currentPath.ctimeMs !== before.ctimeMs ||
      await realpath(filename) !== filename) throw new Error('File changed during hashing');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/** Upgrade legacy stores while their old files are still readable. Missing files are never guessed. */
export async function observeLegacyIdentities(data: LocalData, signal: AbortSignal): Promise<IdentityObservation[]> {
  const result: IdentityObservation[] = [];
  for (const track of data.library.tracks) {
    check(signal);
    if (data.fileIdentities?.[track.id] || !data.files[track.id]) continue;
    const file = data.files[track.id];
    try {
      const { common } = await parseFile(file.path);
      const discFromDirectory = Number(path.basename(path.dirname(file.path)).match(/^(?:disc|disk|cd)[ _-]*(\d+)$/i)?.[1]) || 1;
      const discNumber = Number.isInteger(common.disk.no) && common.disk.no! > 0 ? common.disk.no! : discFromDirectory;
      const trackNumber = Number.isInteger(common.track.no) && common.track.no! > 0 ? common.track.no! :
        Number(path.basename(file.path).match(/^\d+/)?.[0]) ||
        (!track.userEditedFields.includes('trackNumber') ? track.trackNumber : null);
      if (!trackNumber) continue;
      result.push({ trackId: track.id, file, identity: {
        sha256: await hashMusicFile(file.path, file, signal), size: file.size,
        albumId: track.albumId, discNumber, trackNumber,
      } });
    } catch { check(signal); }
  }
  return result;
}

export function acceptIdentityObservations(data: LocalData, observations: IdentityObservation[]) {
  data.fileIdentities ??= {};
  for (const observation of observations) {
    if (data.fileIdentities[observation.trackId]) continue;
    const current = data.files[observation.trackId];
    // A concurrent removal still needs this identity to reject a late import of a moved copy.
    if ((current && current.path === observation.file.path && current.size === observation.file.size &&
      current.mtimeMs === observation.file.mtimeMs) || (!current && data.excludedTrackIds?.[observation.trackId] !== undefined))
      data.fileIdentities[observation.trackId] = { ...observation.identity };
  }
}

export const identitySlot = (identity: FileIdentity) =>
  `${identity.discNumber}:${identity.trackNumber}:${identity.size}:${identity.sha256}`;
export const albumIdentity = (identities: FileIdentity[]) =>
  identities.map(identitySlot).sort().join('|');

/** Only complete, unique albums with unique hash/slot pairs can reuse their existing IDs. */
export function relinkScan(data: LocalData, scan: ScanResult): number {
  if (!scan.identities) return 0;
  const known = data.fileIdentities ?? {};
  const groups = new Map<string, string[]>();
  for (const album of data.library.albums) groups.set(album.id,
    data.library.tracks.filter(track => track.albumId === album.id).map(track => track.id));
  for (const [id, identity] of Object.entries(known)) {
    if (data.excludedTrackIds?.[id] !== undefined && !data.library.albums.some(album => album.id === identity.albumId))
      groups.set(identity.albumId, [...(groups.get(identity.albumId) ?? []), id]);
  }
  const candidates = new Map<string, { albumId: string; ids: string[] }[]>();
  for (const [albumId, ids] of groups) {
    if (!ids.length || ids.some(id => !known[id])) continue;
    const signature = albumIdentity(ids.map(id => known[id]));
    candidates.set(signature, [...(candidates.get(signature) ?? []), { albumId, ids }]);
  }
  let relocated = 0;
  const originalIds = new Set(scan.albums.map(album => album.id));
  const selectedPaths = new Set<string>();
  for (const album of scan.albums) {
    if (groups.has(album.id) || album.trackIds.some(id => !scan.identities![id])) continue;
    const matches = candidates.get(albumIdentity(album.trackIds.map(id => scan.identities![id]))) ?? [];
    if (!matches.length) continue;
    const target = matches[0];
    if (matches.length !== 1 || new Set(target.ids.map(id => identitySlot(known[id]))).size !== target.ids.length) {
      scan.warnings.push('发现内容相同但关联不唯一的专辑，未自动合并：' + album.title);
      continue;
    }
    const oldAlbumId = album.id;
    // When a broad root contains both copies, retain the already known path.
    if (originalIds.has(target.albumId) || selectedPaths.has(target.albumId)) {
      scan.tracks = scan.tracks.filter(track => track.albumId !== oldAlbumId);
      album.trackIds = [];
      continue;
    }
    selectedPaths.add(target.albumId);
    album.id = target.albumId;
    if (album.cover) album.cover = { ...album.cover,
      thumbUrl: '/api/cover/' + album.id, fullUrl: '/api/cover/' + album.id };
    if (scan.covers[oldAlbumId]) scan.covers[album.id] = scan.covers[oldAlbumId];
    album.trackIds = album.trackIds.map(id => {
      const retained = target.ids.find(old => identitySlot(known[old]) === identitySlot(scan.identities![id]))!;
      const track = scan.tracks.find(item => item.id === id)!;
      track.id = retained;
      track.albumId = album.id;
      scan.files[retained] = scan.files[id];
      scan.lyrics[retained] = { ...scan.lyrics[id], trackId: retained };
      scan.identities![retained] = { ...scan.identities![id], albumId: album.id };
      return retained;
    });
    relocated++;
  }
  return relocated;
}

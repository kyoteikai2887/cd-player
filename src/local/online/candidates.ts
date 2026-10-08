import type { Album, Track, LyricsDocument, LyricsReview, LyricsCandidate } from '../../contracts/player.ts';
import { validateLyricsEdit } from '../../core/lyrics.ts';
import { LocalError, copy } from '../model.ts';
import type { LocalData } from '../model.ts';
import { fillOnlineLyrics } from './lyrics.ts';

export interface LyricSearchRecord {
  provider: string; recordId: string; title: string; artistCredit: string; albumTitle: string;
  durationMs: number | null; document: LyricsDocument; warnings?: string[];
}
export interface PreparedLyricsReview { review: LyricsReview; expiresAt: number; documents: Map<string, LyricsDocument> }
const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const version = (s: string) => (s.match(/tv[\s.-]*(?:size|ver(?:sion)?)|movie[\s.-]*edit|live|remix|instrumental|off[\s.-]*vocal|karaoke|hatha/gi) ?? []).map(norm).sort().join('|');

export function prepareLyricsReview(track: Track, album: Album, document: LyricsDocument,
  records: LyricSearchRecord[], query = { title: track.title, artist: track.artists[0] ?? track.artistCredit }, now = Date.now()): PreparedLyricsReview {
  const documents = new Map<string, LyricsDocument>(), seen = new Set<string>();
  const candidates: LyricsCandidate[] = [];
  for (const r of records) {
    const key = r.provider + ':' + r.recordId;
    if (seen.has(key) || r.document.trackId !== track.id || !['plain', 'synced'].includes(r.document.kind) ||
      validateLyricsEdit({ ...r.document, kind: r.document.kind as 'plain' | 'synced' }).length) continue;
    seen.add(key);
    const delta = r.durationMs === null ? null : r.durationMs - track.durationMs;
    const warnings: string[] = [...new Set([...(r.warnings ?? []), ...r.document.warnings])];
    if (norm(r.title) !== norm(track.title)) warnings.push('曲名不同，请核对版本。');
    if (norm(r.artistCredit) !== norm(track.artistCredit)) warnings.push('歌手署名不同，请核对演唱者。');
    if (norm(r.albumTitle) !== norm(album.title)) warnings.push('来自其他专辑。');
    if (delta === null) warnings.push('来源没有提供时长。');
    else if (Math.abs(delta) > 2000) warnings.push('时长相差超过 2 秒，请核对时间轴。');
    if (version(r.title) !== version(track.title + ' ' + (track.versionLabel ?? ''))) warnings.push('版本标记不同，请先预览。');
    const id = globalThis.crypto.randomUUID(), preview = copy(r.document);
    documents.set(id, copy(r.document));
    candidates.push({ id, provider: r.provider, recordId: r.recordId, title: r.title, artistCredit: r.artistCredit,
      albumTitle: r.albumTitle, durationMs: r.durationMs, durationDeltaMs: delta,
      match: norm(r.title) === norm(track.title) && delta !== null && Math.abs(delta) <= 2000 &&
        version(r.title) === version(track.title + ' ' + (track.versionLabel ?? '')) ? 'close' : 'check', warnings, document: preview });
  }
  candidates.sort((a,b) => Number(b.match === 'close') - Number(a.match === 'close') ||
    Number(b.document.kind === 'synced') - Number(a.document.kind === 'synced') ||
    Number(norm(b.albumTitle) === norm(album.title)) - Number(norm(a.albumTitle) === norm(album.title)) ||
    (Math.abs(a.durationDeltaMs ?? Infinity) - Math.abs(b.durationDeltaMs ?? Infinity)) || a.recordId.localeCompare(b.recordId));
  // Reserve the best result from each source so one large catalogue cannot hide
  // every alternative. Keep the existing quality order within the bounded list.
  const selected = new Set<string>(), providers = new Set<string>();
  for (const c of candidates) if (!providers.has(c.provider) && selected.size < 12) {
    providers.add(c.provider); selected.add(c.id);
  }
  for (const c of candidates) { if (selected.size >= 12) break; selected.add(c.id); }
  const kept = candidates.filter(c => selected.has(c.id));
  for (const id of documents.keys()) if (!kept.some(c => c.id === id)) documents.delete(id);
  return { expiresAt: now + 30 * 60 * 1000, documents, review: { id: globalThis.crypto.randomUUID(), trackId: track.id,
    baseRevision: document.revision, baseTrackRevision: track.revision, baseAlbumRevision: album.revision,
    query, status: kept.length ? 'ready' : 'noResults', candidates: kept, error: null } };
}

export function selectedLyrics(data: Pick<LocalData, 'library' | 'lyricsByTrack'>, prepared: PreparedLyricsReview,
  action: { trackId: string; reviewId: string; candidateId: string }, now = Date.now()) {
  const r = prepared.review, track = data.library.tracks.find(t => t.id === action.trackId),
    doc = data.lyricsByTrack[action.trackId], album = track && data.library.albums.find(a => a.id === track.albumId);
  if (!track || !doc || !album) throw new LocalError('notFound', '曲目已移除。');
  if (doc.locked) throw new LocalError('locked', '歌词已锁定。');
  if (r.trackId !== action.trackId || r.id !== action.reviewId || now >= prepared.expiresAt ||
    doc.revision !== r.baseRevision || track.revision !== r.baseTrackRevision || album.revision !== r.baseAlbumRevision)
    throw new LocalError('conflict', '歌词候选已过期或资料已修改，请重新查找。');
  const candidate = prepared.documents.get(action.candidateId);
  if (!candidate) throw new LocalError('invalidAction', '歌词候选不存在。');
  return copy(candidate);
}
export function applyLyricsReview(data: LocalData, prepared: PreparedLyricsReview,
  action: { trackId: string; reviewId: string; candidateId: string }) {
  const candidate = selectedLyrics(data, prepared, action), r = prepared.review;
  if (data.lyricsByTrack[action.trackId].kind !== 'missing')
    throw new LocalError('invalidAction', '已有歌词，请在编辑器里将候选导入草稿。');
  return fillOnlineLyrics(data, { trackId: r.trackId, lyricsRevision: r.baseRevision,
    trackRevision: r.baseTrackRevision, albumRevision: r.baseAlbumRevision }, candidate);
}

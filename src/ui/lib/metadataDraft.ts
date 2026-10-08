/**
 * Album and track metadata drafts (Claude, R2). Pure: forms ↔ entities, validation, patches and the
 * field-by-field comparison used on conflict. The core's validateMetadataPatch is the final guard;
 * nothing here writes tags, paths or storage.
 *
 * Forms keep text as typed (numbers too), so an invalid entry stays visible and marked. Empty
 * optional text means "not set" (null); required fields are never sent empty.
 */
import type { Album, AlbumEditableFields, Track, TrackEditableFields, VersionKind } from '../../contracts/player.ts';
import { validateMetadataPatch } from '../../core/metadata.ts';

export interface AlbumForm {
  title: string;
  albumArtists: string[];
  albumArtistCredit: string;
  workTitle: string;
  releaseYear: string;
  catalogNumber: string;
  label: string;
  language: string | null;
  titleSort: string;
  /** Disc titles by disc number ('' = no title). */
  discTitles: Record<number, string>;
}
export interface TrackForm {
  title: string;
  artists: string[];
  artistCredit: string;
  discNumber: string;
  trackNumber: string;
  language: string | null;
  versionKind: VersionKind | null;
  versionLabel: string;
}
export type AlbumFormField = keyof AlbumForm;
export type TrackFormField = keyof TrackForm;
export interface FieldIssue { field: string; message: string; blocking: boolean }

export const VERSION_KINDS: [VersionKind, string][] = [
  ['full', '完整版'], ['short', '短版（TV size 等）'], ['live', '现场'], ['instrumental', '器乐版'],
  ['offVocal', '伴奏（off vocal）'], ['remix', '混音'], ['other', '其他'],
];

export const ALBUM_FIELD_LABEL: Record<keyof AlbumEditableFields | 'cover', string> = {
  title: '专辑名', albumArtists: '专辑艺术家', albumArtistCredit: '署名', workTitle: '作品', releaseYear: '发行年份',
  catalogNumber: '品番', label: '厂牌', language: '语言', titleSort: '排序用名', discs: '碟片标题', cover: '封面',
};
export const TRACK_FIELD_LABEL: Record<keyof TrackEditableFields, string> = {
  title: '曲名', artists: '歌手', artistCredit: '署名', discNumber: '碟号', trackNumber: '曲号',
  language: '语言', versionKind: '版本', versionLabel: '版本说明',
};

// ── Entity → form ─────────────────────────────────────────────────────────────

export function albumForm(album: Album): AlbumForm {
  return {
    title: album.title, albumArtists: [...album.albumArtists], albumArtistCredit: album.albumArtistCredit,
    workTitle: album.workTitle ?? '', releaseYear: album.releaseYear === null ? '' : String(album.releaseYear),
    catalogNumber: album.catalogNumber ?? '', label: album.label ?? '', language: album.language, titleSort: album.titleSort ?? '',
    discTitles: Object.fromEntries(album.discs.map(d => [d.number, d.title ?? ''])),
  };
}
export function trackForm(track: Track): TrackForm {
  return {
    title: track.title, artists: [...track.artists], artistCredit: track.artistCredit,
    discNumber: String(track.discNumber), trackNumber: String(track.trackNumber), language: track.language,
    versionKind: track.versionKind, versionLabel: track.versionLabel ?? '',
  };
}

// ── Form → values ─────────────────────────────────────────────────────────────

const optional = (text: string) => text.trim() ? text.trim() : null;
const names = (list: string[]) => [...new Set(list.map(n => n.trim()).filter(Boolean))];
const positiveInt = (text: string) => /^\s*\d+\s*$/.test(text) && Number(text) > 0 && Number.isSafeInteger(Number(text)) ? Number(text) : null;

/**
 * Album values from the form. `discNumbers` are the album's listed discs; a disc that only tracks
 * use (the album view groups those by itself) is added once the user gives it a title.
 */
export function albumValues(form: AlbumForm, discNumbers: number[]): AlbumEditableFields {
  const titled = Object.entries(form.discTitles).filter(([, title]) => title.trim()).map(([n]) => Number(n));
  // An unreadable year stays NaN: it differs from every saved value and never passes the shared guard.
  const year = form.releaseYear.trim() === '' ? null : positiveInt(form.releaseYear) ?? NaN;
  return {
    title: form.title.trim(), albumArtists: names(form.albumArtists), albumArtistCredit: form.albumArtistCredit.trim(),
    workTitle: optional(form.workTitle), releaseYear: year, catalogNumber: optional(form.catalogNumber),
    label: optional(form.label), language: form.language, titleSort: optional(form.titleSort),
    discs: [...new Set([...discNumbers, ...titled])].sort((a, b) => a - b).map(number => {
      const title = (form.discTitles[number] ?? '').trim();
      return title ? { number, title } : { number };
    }),
  };
}
export function trackValues(form: TrackForm): TrackEditableFields {
  return {
    title: form.title.trim(), artists: names(form.artists), artistCredit: form.artistCredit.trim(),
    discNumber: positiveInt(form.discNumber) ?? NaN, trackNumber: positiveInt(form.trackNumber) ?? NaN,
    language: form.language, versionKind: form.versionKind, versionLabel: optional(form.versionLabel),
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

export function albumIssues(form: AlbumForm): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (!form.title.trim()) issues.push({ field: 'title', message: '专辑名不能为空。', blocking: true });
  if (!form.albumArtistCredit.trim()) issues.push({ field: 'albumArtistCredit', message: '署名不能为空；不确定时可以写“Various Artists”。', blocking: true });
  if (form.releaseYear.trim() !== '') {
    const year = positiveInt(form.releaseYear);
    if (year === null || year > 9999) issues.push({ field: 'releaseYear', message: '年份要是 1–9999 的整数，或者留空。', blocking: true });
  }
  return issues;
}
export function trackIssues(form: TrackForm, siblings: { id: string; disc: number; track: number; title: string }[] = [], selfId = ''): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (!form.title.trim()) issues.push({ field: 'title', message: '曲名不能为空。', blocking: true });
  if (!form.artistCredit.trim()) issues.push({ field: 'artistCredit', message: '署名不能为空。', blocking: true });
  const disc = positiveInt(form.discNumber), track = positiveInt(form.trackNumber);
  if (disc === null) issues.push({ field: 'discNumber', message: '碟号要是正整数。', blocking: true });
  if (track === null) issues.push({ field: 'trackNumber', message: '曲号要是正整数。', blocking: true });
  if (disc !== null && track !== null) {
    const clash = siblings.find(s => s.id !== selfId && s.disc === disc && s.track === track);
    if (clash) issues.push({ field: 'trackNumber', message: `和“${clash.title}”的碟号、曲号相同。`, blocking: false });
  }
  return issues;
}

// ── Patches ───────────────────────────────────────────────────────────────────

const stable = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'number' && !Number.isFinite(v) ? '\u0000NaN' : v);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** Only the fields that differ from `from` (so untouched fields never become "edited by hand"). */
export function diffPatch<T extends object>(values: T, from: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(values) as (keyof T)[]) if (!same(values[key], from[key])) patch[key] = values[key];
  return patch;
}
export const pickAlbumFields = (album: Album): AlbumEditableFields => ({
  title: album.title, albumArtists: album.albumArtists, albumArtistCredit: album.albumArtistCredit, workTitle: album.workTitle,
  releaseYear: album.releaseYear, catalogNumber: album.catalogNumber, label: album.label, language: album.language,
  titleSort: album.titleSort, discs: album.discs,
});
export const pickTrackFields = (track: Track): TrackEditableFields => ({
  title: track.title, artists: track.artists, artistCredit: track.artistCredit, discNumber: track.discNumber,
  trackNumber: track.trackNumber, language: track.language, versionKind: track.versionKind, versionLabel: track.versionLabel,
});
/** Shared guard before anything is sent. */
export const patchIsValid = (patch: object, album: boolean) => validateMetadataPatch(patch as Record<string, unknown>, album);
export const sameFields = (a: unknown, b: unknown) => same(a, b);

// ── Display and comparison ────────────────────────────────────────────────────

export function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '（未填写）';
  if (Array.isArray(value)) {
    if (field === 'discs') return (value as { number: number; title?: string }[]).map(d => `${d.number}${d.title ? ' ' + d.title : ''}`).join('；') || '（未填写）';
    return value.length ? (value as string[]).join('、') : '（未填写）';
  }
  if (field === 'versionKind') return VERSION_KINDS.find(([k]) => k === value)?.[1] ?? String(value);
  return String(value);
}

export interface FieldCompareRow { field: string; label: string; latest: string; draft: string; theirs: boolean; mine: boolean }
/**
 * Fields where the latest saved version or the draft differ from the version the draft started
 * from. `theirs`: changed elsewhere; `mine`: changed in the draft. Both = a real clash.
 */
export function compareFields<T extends object>(base: T, latest: T, draft: T, labels: Record<string, string>): FieldCompareRow[] {
  const rows: FieldCompareRow[] = [];
  for (const key of Object.keys(draft) as (keyof T & string)[]) {
    const theirs = !same(base[key], latest[key]), mine = !same(base[key], draft[key]);
    if (!theirs && !mine) continue;
    if (same(latest[key], draft[key])) continue;   // both arrived at the same value
    rows.push({ field: key, label: labels[key] ?? key, latest: displayValue(key, latest[key]), draft: displayValue(key, draft[key]), theirs, mine });
  }
  return rows;
}

/** Disc numbers in use: the album's discs plus the given track disc numbers. */
export function discUnion(discs: { number: number }[], numbers: (number | null)[]): number[] {
  return [...new Set([...discs.map(d => d.number), ...numbers.filter((n): n is number => n !== null && Number.isInteger(n) && n > 0)])].sort((a, b) => a - b);
}
export const discOf = (form: TrackForm) => positiveInt(form.discNumber);

/** A plain credit from a list of names (users usually refine it, e.g. with CV credits). */
export const creditFrom = (artists: string[]) => names(artists).join(' / ');

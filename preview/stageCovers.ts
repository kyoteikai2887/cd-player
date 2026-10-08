/**
 * Original fictional covers at the extremes of brightness and colour (Claude, R2.2), for checking
 * text over a cover's light: a near-black sleeve with thin white type, a near-white one, a mid
 * grey, a saturated red and a bright yellow. Preview only; the fixtures are untouched.
 */
import type { Album, LibrarySnapshot, Track } from '../src/contracts/player.ts';

export type CoverKind = 'night' | 'snow' | 'ash' | 'ember' | 'citrus';

interface Spec { title: string; work: string; artist: string; tracks: [string, number][]; svg: string }

const svg = (body: string) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'>${body}</svg>`;

const SPECS: Record<CoverKind, Spec> = {
  night: {
    title: '夜更けの台帳 — Nocturne Ledger', work: '夜更けの台帳', artist: '灯火ユニット',
    tracks: [['零時の索引', 214000], ['インクの雨', 198000], ['Nocturne Ledger (inst.)', 205000]],
    svg: svg(`<rect width='600' height='600' fill='#0A0A0B'/>
      <line x1='60' y1='470' x2='540' y2='470' stroke='#F2F2F2' stroke-width='1.5'/>
      <text x='60' y='510' fill='#F2F2F2' font-family='Georgia,serif' font-size='30' letter-spacing='9'>NOCTURNE LEDGER</text>
      <text x='60' y='540' fill='#9A9A9A' font-family='Arial,sans-serif' font-size='13' letter-spacing='4'>FICTIONAL DEMO ALBUM</text>`),
  },
  snow: {
    title: '雪見ノート', work: '雪見ノート', artist: '白樺カルテット',
    tracks: [['初雪の譜面', 176000], ['窓に息を', 231000]],
    svg: svg(`<rect width='600' height='600' fill='#FAFAF7'/>
      <circle cx='420' cy='190' r='70' fill='none' stroke='#E3E3DE' stroke-width='2'/>
      <text x='60' y='520' fill='#C9C9C2' font-family='Georgia,serif' font-size='28' letter-spacing='6'>SNOW NOTES</text>`),
  },
  ash: {
    title: '灰色の午後 — Ash Afternoon', work: '灰色の午後', artist: '鉛筆座',
    tracks: [['曇天メトロノーム', 188000], ['灰の手紙', 207000]],
    svg: svg(`<rect width='600' height='600' fill='#7B7B7B'/>
      <rect x='60' y='60' width='220' height='220' fill='#8C8C8C'/>
      <rect x='320' y='320' width='220' height='220' fill='#6A6A6A'/>
      <text x='60' y='540' fill='#D8D8D8' font-family='Arial,sans-serif' font-size='22' letter-spacing='6'>ASH AFTERNOON</text>`),
  },
  ember: {
    title: '残り火ダンスホール', work: '残り火ダンスホール', artist: 'ネオン燐寸',
    tracks: [['Ember Step', 196000], ['火花のワルツ', 224000]],
    svg: svg(`<rect width='600' height='600' fill='#D3202A'/>
      <circle cx='300' cy='260' r='150' fill='#F26A1B'/>
      <circle cx='300' cy='260' r='80' fill='#FFB020'/>
      <text x='60' y='540' fill='#FFF1E6' font-family='Arial,sans-serif' font-size='24' letter-spacing='6'>EMBER DANCEHALL</text>`),
  },
  citrus: {
    title: 'シトラス通信', work: 'シトラス通信', artist: '蜜柑レディオ',
    tracks: [['朝のビタミン', 168000], ['レモン色の信号', 185000]],
    svg: svg(`<rect width='600' height='600' fill='#F5D90A'/>
      <circle cx='190' cy='200' r='110' fill='#FFF27A'/>
      <text x='60' y='540' fill='#5C4A00' font-family='Arial,sans-serif' font-size='24' letter-spacing='6'>CITRUS LETTERS</text>`),
  },
};

export const COVER_KINDS = Object.keys(SPECS) as CoverKind[];
export const COVER_LABEL: Record<CoverKind, string> = { night: '近黑', snow: '近白', ash: '中灰', ember: '饱和红', citrus: '亮黄' };

export const coverUri = (kind: CoverKind) => 'data:image/svg+xml;utf8,' + encodeURIComponent(SPECS[kind].svg.replace(/\n\s*/g, ''));

/** Adds one fictional album with the given cover; returns its id and first track id. */
export function addCoverAlbum(library: LibrarySnapshot, kind: CoverKind, addedAt = Date.UTC(2026, 9, 4)): { albumId: string; trackId: string } {
  const spec = SPECS[kind];
  const albumId = 'album-pv-' + kind;
  const uri = coverUri(kind);
  const trackIds = spec.tracks.map((_, i) => `${albumId}-t${i + 1}`);
  const album: Album = {
    id: albumId, title: spec.title, albumArtists: [spec.artist], albumArtistCredit: spec.artist, trackIds,
    cover: { thumbUrl: uri, fullUrl: uri, width: 600, height: 600 },
    revision: 0, workTitle: spec.work, releaseYear: 2026, catalogNumber: `PV-${kind.toUpperCase()}`, label: '架空レコード',
    language: 'ja', titleSort: null, discs: [{ number: 1 }], addedAt,
    metadataStatus: 'matched', userEditedFields: [], rip: { hasLog: true, hasCue: true, accurateRip: 'verified' },
  };
  const tracks: Track[] = spec.tracks.map(([title, durationMs], i) => ({
    id: trackIds[i], albumId, title, artists: [spec.artist], artistCredit: spec.artist, revision: 0, available: true,
    discNumber: 1, trackNumber: i + 1, durationMs, language: 'ja', versionKind: null, versionLabel: null, userEditedFields: [],
  }));
  library.albums = [...library.albums, album];
  library.tracks = [...library.tracks, ...tracks];
  return { albumId, trackId: trackIds[0] };
}

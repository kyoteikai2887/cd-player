/**
 * Fictional lyric candidates for the preview (Claude, R2.3). Every line, title and source name
 * here is invented for the demo. Reviews are prepared by the same code the core uses
 * (prepareLyricsReview), so warnings and order match what the app would show.
 */
import type { Album, LyricsDocument, LyricsReview, Track } from '../src/contracts/player.ts';
import { parseLyrics, translationStatus } from '../src/core/lyrics.ts';
import { prepareLyricsReview } from '../src/local/online/candidates.ts';
import type { LyricSearchRecord } from '../src/local/online/candidates.ts';

const PROVIDER = '虚构歌词库';
const LINES = [
  '窓辺に置いた 青いガラス', '朝の光を ひとつ集めて', '名前のない 歌を待ってる', 'きみの声が 届くまで', '',
  'ページをめくる 指先に', '昨日の空が まだ残ってる', '遠回りでも かまわないよ', 'ふたりで見つけた この色', '',
  '次の角を 曲がったら', '知らない風が 吹いている', 'まだ白い 地図の上', '小さな印を つけていこう',
];

/** The demo's own Chinese translation of the lines above (blank where the line is a break). */
const TRANSLATION = [
  '放在窗边的蓝色玻璃', '收集起一束清晨的光', '等待一首还没有名字的歌', '直到你的声音传来', '',
  '翻页的指尖上', '还留着昨天的天空', '绕点远路也没关系', '这是我们一起找到的颜色', '',
  '在下一个转角转弯', '吹来陌生的风', '在仍然空白的地图上', '留下小小的记号吧',
];

/** LRC text with lines spread from `startMs` every `stepMs`; blank lines become breaks. */
function lrc(lines: string[], startMs: number, stepMs: number): string {
  return lines.map((text, i) => {
    const ms = startMs + i * stepMs, m = Math.floor(ms / 60000), s = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
    return `[${String(m).padStart(2, '0')}:${s}]${text}`;
  }).join('\n');
}
const synced = (track: Track, lines: string[], startMs: number, stepMs: number, recordId: string): LyricsDocument =>
  parseLyrics(lrc(lines, startMs, stepMs), track.id, { source: { kind: 'provider', name: PROVIDER, recordId }, language: 'ja' });
/**
 * A synced document that came with a translation, already paired by time the way the core pairs it.
 * `skip` leaves some lines without one, as a source with gaps would.
 */
function translated(doc: LyricsDocument, provider: string, recordId: string, skip: number[] = []): LyricsDocument {
  let k = 0;
  const lines = doc.lines.map(line => {
    if (!line.original.trim()) return line;
    const text = TRANSLATION[LINES.indexOf(line.original)] ?? '';
    return skip.includes(k++) || !text ? line : { ...line, translation: text };
  });
  const status = translationStatus(lines);
  return { ...doc, lines, translationStatus: status, translationLanguage: 'zh-Hans',
    source: { ...doc.source, translation: { kind: 'provider', name: provider, recordId } },
    warnings: skip.length ? [...doc.warnings, `${skip.length} 行译文无法安全配对，请人工核对。`] : doc.warnings };
}
const plain = (track: Track, lines: string[], recordId: string): LyricsDocument =>
  parseLyrics(lines.filter(Boolean).join('\n'), track.id, { source: { kind: 'provider', name: PROVIDER, recordId }, language: 'ja' });

/** Five versions of one song: the full one, a TV Size, a different credit, a Movie Edit, plain text. */
export function candidateRecords(track: Track, album: Album): LyricSearchRecord[] {
  const d = track.durationMs, step = Math.max(4000, Math.round((d - 24000) / LINES.length));
  return [
    { provider: PROVIDER, recordId: 'pv-full', title: track.title, artistCredit: track.artistCredit, albumTitle: album.title,
      durationMs: d + 1000, document: synced(track, LINES, 12000, step, 'pv-full') },
    { provider: PROVIDER, recordId: 'pv-tv', title: `${track.title} (TV Size)`, artistCredit: track.artistCredit, albumTitle: `${album.title.split(' — ')[0]} TV Edition`,
      durationMs: 89000, document: synced(track, LINES.slice(0, 9), 9000, 8600, 'pv-tv') },
    { provider: PROVIDER, recordId: 'pv-credit', title: track.title, artistCredit: track.artists.length > 1 ? track.artists[0] : `${track.artistCredit}, 星野レナ`,
      albumTitle: 'Character Songs Collection', durationMs: d, document: synced(track, LINES, 12500, step, 'pv-credit') },
    { provider: '另一个虚构歌词库', recordId: 'pv-movie', title: `${track.title} -Movie Edit-`, artistCredit: track.artistCredit, albumTitle: '劇場版 オリジナル・サウンドトラック',
      durationMs: d + 42000, document: synced(track, LINES, 30000, step + 2600, 'pv-movie') },
    { provider: PROVIDER, recordId: 'pv-plain', title: track.title, artistCredit: track.artistCredit, albumTitle: album.title,
      durationMs: null, document: plain(track, LINES, 'pv-plain') },
  ];
}

/** Twelve records (the most the core sends): variations of the five above. */
export function manyRecords(track: Track, album: Album): LyricSearchRecord[] {
  const five = candidateRecords(track, album), out: LyricSearchRecord[] = [];
  for (let i = 0; out.length < 14; i++) {
    const r = five[i % five.length];
    out.push({ ...r, recordId: `${r.recordId}-${i}`, durationMs: r.durationMs === null ? null : r.durationMs + (i % 3) * 700 });
  }
  return out;
}

export function reviewFor(track: Track, album: Album, doc: LyricsDocument, records: LyricSearchRecord[],
  query?: { title: string; artist: string }): LyricsReview {
  const review = prepareLyricsReview(track, album, doc, records, query).review;
  return { ...review, id: 'pv-review-' + track.id };
}

/**
 * One version from each source the app searches (core.19): a translated one, one with gaps in its
 * translation, one without, and a source that did not answer for part of the search.
 */
export function multiSourceRecords(track: Track, album: Album): LyricSearchRecord[] {
  const d = track.durationMs, step = Math.max(4000, Math.round((d - 24000) / LINES.length));
  const note = 'QQ 音乐的部分查询未完成；其他可用候选仍可预览。';
  return [
    { provider: '网易云音乐', recordId: 'pv-163', title: track.title, artistCredit: track.artistCredit, albumTitle: album.title,
      durationMs: d + 300, warnings: [note], document: translated(synced(track, LINES, 12000, step, 'pv-163'), '网易云音乐', 'pv-163') },
    { provider: 'LRCLIB', recordId: 'pv-lrclib', title: track.title, artistCredit: track.artistCredit, albumTitle: album.title,
      durationMs: d - 400, warnings: [note], document: synced(track, LINES, 12100, step, 'pv-lrclib') },
    { provider: 'QQ 音乐', recordId: 'pv-qq', title: track.title, artistCredit: `${track.artistCredit} / 星野レナ`, albumTitle: '',
      durationMs: null, warnings: [note], document: translated(synced(track, LINES, 11900, step, 'pv-qq'), 'QQ 音乐', 'pv-qq', [3, 7]) },
    { provider: '酷狗音乐', recordId: 'pv-kugou', title: `${track.title} (TV Size)`, artistCredit: track.artistCredit, albumTitle: 'アニメ主題歌集',
      durationMs: 89000, warnings: [note], document: synced(track, LINES.slice(0, 9), 9000, 8600, 'pv-kugou') },
  ];
}

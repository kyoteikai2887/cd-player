import type { Album, LyricsDocument, Track } from '../../contracts/player.ts';
import { attachTranslation, parseLyrics, translationStatus, validateLyricsEdit } from '../../core/lyrics.ts';
import { LocalError } from '../model.ts';
import type { LyricSearchRecord } from './candidates.ts';
import { cancelled, createOnlineHttp } from './http.ts';

/** Independent adapters for ordinary, unauthenticated line-LRC responses. No LDDC code/runtime is bundled. */
export const LYRIC_SOURCES = ['lrclib', 'qq', 'netease', 'kugou'] as const;
export type LyricSource = typeof LYRIC_SOURCES[number];
const names: Record<LyricSource, string> = { lrclib: 'LRCLIB', qq: 'QQ 音乐', netease: '网易云音乐', kugou: '酷狗音乐' };
export interface LyricsSourceResult {
  provider: string;
  status: 'ready' | 'noResults' | 'partial' | 'failed';
  count: number;
  message: string | null;
}
export interface LyricsSearchResult { records: LyricSearchRecord[]; sources: LyricsSourceResult[] }
type Http = ReturnType<typeof createOnlineHttp>;
type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 2000;
const id = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) ||
  (typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v)) ? String(v) : null;
const duration = (v: unknown, multiplier = 1): number | null => typeof v === 'number' && Number.isFinite(v) && v > 0 &&
  v * multiplier <= 24 * 3600000 ? Math.round(v * multiplier) : null;
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const artistsOf = (value: unknown) => Array.isArray(value) && value.length <= 30 ? value.map(v => row(v).name).filter(text).join(' / ') : '';
function useful(title: string, artist: string, query: { title: string; artist: string }) {
  const t = norm(title), q = norm(query.title), a = norm(artist), qa = norm(query.artist);
  // Upstreams can ignore part of a query and return popular unrelated songs. Keep
  // title variants, but never spend our bounded lyric downloads on unrelated titles.
  return !!q && (t === q || (q.length >= 3 && t.includes(q))) && (!qa || a.includes(qa) || qa.includes(a) && !!a);
}
function base64(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 700000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 500000) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}
function entities(s: string) {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi, token => {
    const key = token.slice(1, -1).toLowerCase();
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[key]) return named[key];
    const cp = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : token;
  });
}
function document(body: unknown, translation: unknown, trackId: string, provider: string, recordId: string): LyricsDocument | null {
  if (typeof body !== 'string' || !body.trim() || body.length > 500000) return null;
  const source = { kind: 'provider' as const, name: provider, recordId };
  const result = parseLyrics(entities(body), trackId, { source });
  if (!result.lines.some(l => l.original.trim()) || !['plain', 'synced'].includes(result.kind) || result.lines.length > 2000 ||
    validateLyricsEdit({ ...result, kind: result.kind as 'plain' | 'synced' }).length) return null;
  if (typeof translation === 'string' && translation.trim() && translation.length <= 500000) {
    const translated = parseLyrics(entities(translation), trackId, { source });
    // Plain-text translations require explicit alignment in the editor.
    if (translated.lines.length <= 2000 && result.lines.length * translated.lines.length <= 250000) {
      const paired = attachTranslation(result.lines, translated.lines, 100);
      result.lines = paired.lines; result.warnings.push(...paired.warnings);
    } else result.warnings.push('译文行数过多，没有自动配对。');
    result.translationStatus = translationStatus(result.lines);
    if (result.translationStatus !== 'missing') result.source.translation = source;
  }
  if (validateLyricsEdit({ ...result, kind: result.kind as 'plain' | 'synced' }).length) return null;
  return result;
}
function array(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new LocalError('unavailable', message);
  return value;
}
const qqBody = (module: string, method: string, param: Row) =>
  JSON.stringify({ comm: { ct: 11, cv: '1003006', v: '1003006' }, request: { module, method, param } });
const qqEndpoint = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const qqData = (raw: unknown) => {
  const v = row(raw), request = row(v.request);
  if (v.code !== 0 || request.code !== 0 || !request.data || typeof request.data !== 'object')
    throw new LocalError('unavailable', 'QQ 音乐查询未完成。');
  return row(request.data);
};

export async function searchLyricsSources(http: Http, track: Track, album: Album, signal: AbortSignal,
  query?: { title: string; artist: string }, options: { sources?: readonly LyricSource[]; sourceTimeoutMs?: number } = {}): Promise<LyricsSearchResult> {
  cancelled(signal);
  const title = query?.title ?? track.title;
  const fragments = track.artistCredit.split(/,\s*|，\s*|\s+&\s+|×|\s+(?:feat\.?|featuring)\s+/i).map(s => s.trim()).filter(Boolean);
  const credits = query ? [query.artist] : [...new Set([track.artistCredit, ...fragments, ...track.artists, ...album.albumArtists].filter(Boolean))].slice(0, 3);
  const queries = (credits.length ? credits : ['']).map(artist => ({ title, artist }));
  if (!title.trim() || title.length > 2000 || queries.some(q => q.artist.length > 2000)) throw new LocalError('invalidAction', '请输入有效曲名与歌手。');
  const enabled = [...new Set(options.sources ?? LYRIC_SOURCES)];
  if (!enabled.length || enabled.some(s => !LYRIC_SOURCES.includes(s))) throw new LocalError('invalidAction', '歌词来源配置无效。');
  const results = await Promise.all(enabled.map(async source => {
    const timeout = AbortSignal.timeout(options.sourceTimeoutMs ?? 20000);
    const sourceSignal = AbortSignal.any([signal, timeout]);
    const found = new Map<string, LyricSearchRecord>(), attempted = new Set<string>();
    let incomplete = false, failure: string | null = null;
    const take = (recordId: string, song: { title: string; artist: string; album: string; duration: number | null }, doc: LyricsDocument | null) => {
      if (doc) found.set(recordId, { provider: names[source], recordId, title: song.title, artistCredit: song.artist,
        albumTitle: song.album, durationMs: song.duration, document: doc });
    };
    const attempt = async (fn: () => Promise<void>) => {
      try { cancelled(sourceSignal); await fn(); } catch (error) {
        cancelled(signal); incomplete = true;
        if (error instanceof LocalError) failure = error.message;
      }
    };
    for (const q of queries) {
      if (sourceSignal.aborted) { incomplete = true; break; }
      // Four lyric downloads per source, across every credit variant, not per query.
      if (source !== 'lrclib' && attempted.size >= 4) break;
      await attempt(async () => {
        const keyword = [q.artist, q.title].filter(Boolean).join(' ');
        if (source === 'lrclib') {
          const hits = await http.json('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: q.title,
            ...(q.artist ? { artist_name: q.artist } : {}) }), source, sourceSignal, v => { array(v, 'LRCLIB 搜索结果格式无效。'); });
          for (const value of (hits as unknown[]).slice(0, 20)) {
            const r = row(value), rid = id(r.id);
            if (!rid || !text(r.trackName) || !text(r.artistName) || typeof r.albumName !== 'string' || r.albumName.length > 2000 || r.instrumental === true) continue;
            take(rid, { title: r.trackName, artist: r.artistName, album: r.albumName, duration: duration(r.duration, 1000) },
              document(typeof r.syncedLyrics === 'string' && !!r.syncedLyrics.trim() ? r.syncedLyrics : r.plainLyrics,
                null, track.id, names[source], rid));
          }
          return;
        }
        if (source === 'qq') {
          const body = qqBody('music.search.SearchCgiService', 'DoSearchForQQMusicLite', { query: keyword, num_per_page: 20, page_num: 1, search_type: 0, highlight: 0 });
          const raw = await http.json(qqEndpoint, source, sourceSignal, v => { array(row(qqData(v).body).item_song, 'QQ 音乐搜索结果格式无效。'); }, body);
          const hits = array(row(qqData(raw).body).item_song, 'QQ 音乐搜索结果格式无效。');
          for (const value of hits.slice(0, 20)) {
            const r = row(value), rid = id(r.id), artist = artistsOf(r.singer), al = row(r.album).name;
            if (!rid || !text(r.title) || !text(artist) || !useful(r.title, artist, q) || r.language === 9 || attempted.has(rid)) continue;
            if (attempted.size >= 4) break;
            attempted.add(rid);
            const song = { title: r.title, artist, album: typeof al === 'string' && al.length <= 2000 ? al : '', duration: duration(r.interval, 1000) };
            await attempt(async () => {
              const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');
              const requestBody = qqBody('music.musichallSong.PlayLyricInfo', 'GetPlayLyricInfo', {
                songID: Number(rid), songName: enc(song.title), singerName: enc(artist), albumName: enc(song.album), interval: Math.round((song.duration ?? 0) / 1000),
                crypt: 0, qrc: 0, trans: 1, roma: 0, ct: 19, cv: 2111, type: 0,
              });
              const raw = await http.json(qqEndpoint, source, sourceSignal, v => {
                const data = qqData(v);
                if (data.crypt !== 0 || data.qrc !== 0 || typeof data.lyric !== 'string' || (data.lyric.trim() && base64(data.lyric) === null))
                  throw new LocalError('unavailable', 'QQ 音乐没有返回有效的普通逐行歌词。');
              }, requestBody);
              const data = qqData(raw);
              if (data.crypt !== 0 || data.qrc !== 0) throw new LocalError('unavailable', 'QQ 音乐没有返回普通逐行歌词。');
              if (typeof data.lyric !== 'string') throw new LocalError('unavailable', 'QQ 音乐歌词格式无效。');
              const body = data.lyric.trim() ? base64(data.lyric) : '';
              if (body === null) throw new LocalError('unavailable', 'QQ 音乐歌词编码无效。');
              take(rid, song, document(body, base64(data.trans), track.id, names[source], rid));
            });
          }
          return;
        }
        if (source === 'netease') {
          const raw = await http.json('https://music.163.com/api/cloudsearch/pc?' + new URLSearchParams({ s: keyword, type: '1', limit: '20', offset: '0' }), source, sourceSignal, v => {
            const r = row(v); if (r.code !== 200 || !r.result || typeof r.result !== 'object' || Array.isArray(r.result) ||
              (row(r.result).songs === undefined && row(r.result).songCount !== 0)) throw new LocalError('unavailable', '网易云音乐搜索未完成。');
            if (row(r.result).songs !== undefined) array(row(r.result).songs, '网易云音乐搜索结果格式无效。');
          });
          const hits = row(row(raw).result).songs ?? [];
          for (const value of array(hits, '网易云音乐搜索结果格式无效。').slice(0, 20)) {
            const r = row(value), rid = id(r.id), artist = artistsOf(r.ar ?? r.artists), al = row(r.al ?? r.album).name;
            if (!rid || !text(r.name) || !text(artist) || !useful(r.name, artist, q) || attempted.has(rid)) continue;
            if (attempted.size >= 4) break;
            attempted.add(rid);
            const song = { title: r.name, artist, album: typeof al === 'string' && al.length <= 2000 ? al : '', duration: duration(r.dt ?? r.duration) };
            await attempt(async () => {
              const raw = await http.json('https://music.163.com/api/song/lyric?' + new URLSearchParams({ id: rid, lv: '-1', tv: '-1', rv: '-1' }), source, sourceSignal,
                v => {
                  const data = row(v);
                  if (data.code !== 200 || (data.nolyric !== true && data.uncollected !== true && typeof row(data.lrc).lyric !== 'string'))
                    throw new LocalError('unavailable', '网易云音乐歌词查询未完成。');
                });
              const data = row(raw);
              if (data.nolyric === true || data.uncollected === true) return;
              if (row(data.lrc).lyric !== undefined && typeof row(data.lrc).lyric !== 'string') throw new LocalError('unavailable', '网易云音乐歌词格式无效。');
              take(rid, song, document(row(data.lrc).lyric, row(data.tlyric).lyric, track.id, names[source], rid));
            });
          }
          return;
        }
        const raw = await http.json('https://lyrics.kugou.com/search?' + new URLSearchParams({ ver: '1', man: 'yes', client: 'pc', keyword,
          duration: String(Math.max(0, Math.round(track.durationMs))) }), source, sourceSignal, v => {
          if (row(v).status !== 200) throw new LocalError('unavailable', '酷狗音乐搜索未完成。');
          array(row(v).candidates, '酷狗音乐搜索结果格式无效。');
        });
        // This is the lyric search itself: no song/audio request or file hash is required.
        const hits = array(row(raw).candidates, '酷狗音乐搜索结果格式无效。').slice(0, 20).sort((a, b) =>
          Math.abs((duration(row(a).duration) ?? Infinity) - track.durationMs) - Math.abs((duration(row(b).duration) ?? Infinity) - track.durationMs));
        for (const value of hits) {
          const r = row(value), rid = id(r.id);
          if (!rid || !text(r.song) || !text(r.singer) || !text(r.accesskey) || !useful(r.song, r.singer, q) || attempted.has(rid)) continue;
          if (attempted.size >= 4) break;
          attempted.add(rid);
          await attempt(async () => {
            const raw = await http.json('https://lyrics.kugou.com/download?' + new URLSearchParams({ id: rid, accesskey: r.accesskey as string,
              fmt: 'lrc', charset: 'utf8', client: 'pc', ver: '1' }), source, sourceSignal,
              v => { if (row(v).status !== 200 || row(v).fmt !== 'lrc' || base64(row(v).content) === null)
                throw new LocalError('unavailable', '酷狗音乐没有返回有效的普通逐行歌词。'); });
            const data = row(raw), body = base64(data.content);
            if (body === null) throw new LocalError('unavailable', '酷狗音乐歌词编码无效。');
            take(rid, { title: r.song as string, artist: r.singer as string, album: '', duration: duration(r.duration) },
              document(body, null, track.id, names[source], rid));
          });
        }
      });
    }
    cancelled(signal);
    const records = [...found.values()];
    return { records, summary: { provider: names[source], status: incomplete ? records.length ? 'partial' : 'failed' : records.length ? 'ready' : 'noResults',
      count: records.length, message: incomplete ? (timeout.aborted ? '此来源查询超时。' : failure ?? '此来源的部分查询未完成。') : null } as LyricsSourceResult };
  }));
  cancelled(signal);
  const sources = results.map(r => r.summary), records = results.flatMap(r => r.records);
  const unavailable = sources.filter(s => s.status === 'partial' || s.status === 'failed').map(s => s.provider);
  if (unavailable.length) for (const record of records) record.warnings = [unavailable.join('、') + '的部分查询未完成；其他可用候选仍可预览。'];
  return { records, sources };
}

export function usableSearch(result: LyricsSearchResult): LyricSearchRecord[] {
  if (!result.records.length && result.sources.some(s => s.status === 'failed' || s.status === 'partial'))
    throw new LocalError('unavailable', result.sources.filter(s => s.status === 'failed' || s.status === 'partial').map(s => s.provider).join('、') +
      '查询未完成，其他来源暂未找到候选。稍后可重试，这不代表没有歌词。');
  return result.records;
}

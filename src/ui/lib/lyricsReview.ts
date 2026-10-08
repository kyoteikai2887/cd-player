/**
 * Lyric candidates (Claude, R2.3; contract 0.4.0). Display helpers only: what differs between a
 * candidate and the track, where the lines fall in time, and where an adoption can go. Nothing here
 * ranks, scores or validates a candidate; the core's order and warnings are shown as they are.
 */
import type { LyricLine, LyricsCandidate, LyricsDocument, LyricsEditorState, Track } from '../../contracts/player.ts';
import { formatClock } from './clock.ts';

/** The core sends at most 12; the list never shows more even if a host sends more. */
export const MAX_CANDIDATES = 12;

const fold = (c: string) => c.normalize('NFKC').toLowerCase();
const same = (a: string, b: string) => fold(a) === fold(b) || (/\s/.test(a) && /\s/.test(b));
/** Width, case and spacing differences are not differences for display. */
export const sameText = (a: string, b: string) =>
  a.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() === b.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Splits a candidate's text around what it shares with the track's: `extra` is what only the
 * candidate has (" (TV Size)", " -HaThA-"), `missing` what only the track has. Character level,
 * so a version mark anywhere in a title is found without a list of known marks.
 */
export interface TextDiff { same: boolean; before: string; extra: string; after: string; missing: string }
export function textDiff(local: string, candidate: string): TextDiff {
  if (sameText(local, candidate)) return { same: true, before: candidate, extra: '', after: '', missing: '' };
  const l = Array.from(local), c = Array.from(candidate);
  let p = 0;
  while (p < l.length && p < c.length && same(l[p], c[p])) p++;
  let s = 0;
  while (s < l.length - p && s < c.length - p && same(l[l.length - 1 - s], c[c.length - 1 - s])) s++;
  let before = c.slice(0, p).join(''), extra = c.slice(p, c.length - s).join(''), after = c.slice(c.length - s).join('');
  // Keep the spaces around a mark outside it, so only the mark itself is highlighted.
  const lead = /^\s+/.exec(extra)?.[0] ?? '', trail = /\s+$/.exec(extra)?.[0] ?? '';
  if (lead.length < extra.length) { before += lead; after = trail + after; extra = extra.slice(lead.length, extra.length - trail.length); }
  return { same: false, before, extra, after, missing: l.slice(p, l.length - s).join('').trim() };
}

/** Short signed difference for a list row: "+1.0 秒", "−1:30". */
export function deltaShort(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '时长未知';
  if (Math.abs(ms) < 50) return '时长相同';
  const sign = ms > 0 ? '+' : '−', abs = Math.abs(ms);
  return abs < 60000 ? `${sign}${(abs / 1000).toFixed(1)} 秒` : `${sign}${formatClock(abs)}`;
}
/** The same difference in words: "比本曲长 1.0 秒", "比本曲短 1 分 30 秒". */
export function deltaLong(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '来源没有提供时长';
  if (Math.abs(ms) < 50) return '与本曲时长相同';
  const abs = Math.abs(ms), word = ms > 0 ? '长' : '短';
  if (abs < 60000) return `比本曲${word} ${(abs / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(abs / 60000), seconds = Math.round((abs % 60000) / 1000);
  return `比本曲${word} ${minutes} 分${seconds ? ` ${seconds} 秒` : '钟'}`;
}
/** Two seconds is the core's line for "close"; beyond it the duration is worth a look. */
export const deltaNotable = (ms: number | null) => ms === null || Math.abs(ms) > 2000;

/** Where an adoption can go for this track right now. */
export type AdoptPath = 'document' | 'editorDraft' | 'openEditor';
/**
 * - The editor is open on this track: into its draft (pendingImport), saved by the user.
 * - No lyrics yet: straight into the saved document (the core keeps the user's offset).
 * - Lyrics, or a "no lyrics" mark, already there: only through the editor's draft.
 */
export function adoptPath(trackId: string, editor: LyricsEditorState | null, lyrics: LyricsDocument | null, track?: Track): AdoptPath {
  if (editor?.trackId === trackId && editor.document) return 'editorDraft';
  const kind = knownDocument(trackId, editor, lyrics)?.kind ?? track?.lyricsSummary?.kind ?? null;
  return kind === 'missing' ? 'document' : 'openEditor';
}
/** The saved lyrics of this track if this surface has them (editor or now playing). */
export function knownDocument(trackId: string, editor: LyricsEditorState | null, lyrics: LyricsDocument | null): LyricsDocument | null {
  if (editor?.trackId === trackId && editor.document) return editor.document;
  return lyrics?.trackId === trackId ? lyrics : null;
}

/** A candidate's lines against the track's length, for the small timeline in the preview. */
export interface Timeline { span: number; ticks: number[]; lastMs: number | null; trackMs: number; candidateMs: number | null }
export function timeline(lines: readonly LyricLine[], offsetMs: number, trackMs: number, candidateMs: number | null): Timeline {
  const times = lines.filter(l => l.startMs !== null && l.original.trim()).map(l => l.startMs! + offsetMs);
  const lastMs = times.length ? Math.max(...times) : null;
  const span = Math.max(trackMs, candidateMs ?? 0, lastMs ?? 0, 1);
  return { span, ticks: times.map(t => Math.min(1, Math.max(0, t / span))), lastMs, trackMs, candidateMs };
}

/** A one-line account of a candidate for screen readers and tooltips. */
export function candidateSummary(c: LyricsCandidate): string {
  const tr = translationCount(c.document.lines).lines;
  return [c.document.kind === 'synced' ? '同步歌词' : '纯文本歌词', tr ? `带 ${tr} 行译文` : '', c.title, c.artistCredit, c.albumTitle,
    c.durationMs === null ? '时长未知' : formatClock(c.durationMs), deltaLong(c.durationDeltaMs), c.provider,
    ...c.warnings].filter(Boolean).join('，');
}

/** Lines the source sent a translation for (paired by time in the core; never guessed here). */
export function translationCount(lines: readonly LyricLine[]): { lines: number; of: number } {
  const sung = lines.filter(l => l.original.trim());
  return { lines: sung.filter(l => l.translation?.trim()).length, of: sung.length };
}

/**
 * Notes every candidate carries (with two or more), such as a source that did not answer: said once
 * above the list instead of in every preview. With a single candidate nothing is lifted, so a note
 * about that one candidate stays with it.
 */
export function sharedWarnings(candidates: readonly LyricsCandidate[]): string[] {
  if (candidates.length < 2) return [];
  return candidates[0].warnings.filter((w, i, all) => all.indexOf(w) === i && candidates.every(c => c.warnings.includes(w)));
}

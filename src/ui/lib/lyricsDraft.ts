import type { LyricLine, LyricsDocument, LyricsEdit, LyricsPendingImport, LyricsValidationIssue } from '../../contracts/player.ts';
import { attachTranslation, validateLyricsEdit } from '../../core/lyrics.ts';

/**
 * The lyrics editor's draft (Claude, R2). Pure functions only: the component keeps the draft in
 * React state, this module transforms it. Timing rules follow CONTRACT_BEHAVIOR §2:
 *   effective time (what the editor shows and edits) = startMs + offsetMs
 *   saving keeps startMs = effective − offsetMs; tap timing records renderPos − offsetMs.
 * Negative times are valid. A timed line with an empty original is a break (clears highlighting).
 */
export interface DraftLine {
  id: string;
  /** Stored like the document: without the user offset. null = untimed. */
  startMs: number | null;
  original: string;
  /** '' = no translation for this line. */
  translation: string;
}
export type DraftKind = 'synced' | 'plain' | 'missing';
export interface LyricsDraft {
  trackId: string;
  /** Revision of the saved document this draft was started from (or rebased onto). */
  baseRevision: number;
  kind: DraftKind;
  language: string | null;
  translationLanguage: string | null;
  offsetMs: number;
  locked: boolean;
  lines: DraftLine[];
  /** Counter for new line IDs; IDs stay unique inside the document. */
  seq: number;
}

const toDraftLine = (line: LyricLine): DraftLine => ({
  id: line.id, startMs: line.startMs, original: line.original, translation: line.translation ?? '',
});

/** Instrumental/spoken marks keep their old lines; the draft shows what saving would write. */
function draftKind(doc: LyricsDocument): DraftKind {
  if (doc.kind === 'synced' || doc.kind === 'plain' || doc.kind === 'missing') return doc.kind;
  if (!doc.lines.length) return 'missing';
  return doc.lines.every(line => line.startMs !== null) ? 'synced' : 'plain';
}

export function draftFromDocument(doc: LyricsDocument): LyricsDraft {
  const kind = draftKind(doc);
  return {
    trackId: doc.trackId, baseRevision: doc.revision, kind,
    language: doc.language, translationLanguage: doc.translationLanguage,
    offsetMs: doc.offsetMs, locked: doc.locked,
    lines: kind === 'missing' ? [] : doc.lines.map(toDraftLine), seq: 0,
  };
}

export function toEdit(draft: LyricsDraft): LyricsEdit {
  return {
    kind: draft.kind,
    language: draft.language,
    translationLanguage: draft.translationLanguage,
    offsetMs: draft.offsetMs,
    locked: draft.locked,
    lines: draft.kind === 'missing' ? [] : draft.lines.map(line => {
      const out: LyricLine = { id: line.id, startMs: draft.kind === 'plain' ? null : line.startMs, original: line.original };
      if (line.translation.trim()) out.translation = line.translation;
      return out;
    }),
  };
}

/** Same content as far as saving is concerned (ignores the draft's base revision and ID counter). */
export function sameContent(a: LyricsDraft, b: LyricsDraft): boolean {
  return JSON.stringify(toEdit(a)) === JSON.stringify(toEdit(b));
}

export function isDirty(draft: LyricsDraft, base: LyricsDocument | null): boolean {
  return !!base && !sameContent(draft, draftFromDocument(base));
}

export const validateDraft = (draft: LyricsDraft): LyricsValidationIssue[] => validateLyricsEdit(toEdit(draft));

export const effectiveTime = (draft: LyricsDraft, line: DraftLine) => line.startMs === null ? null : line.startMs + draft.offsetMs;

// ── Time text ─────────────────────────────────────────────────────────────────

/** m:ss.cc (centiseconds), with a real minus sign for negative times. */
export function formatStamp(ms: number): string {
  const sign = ms < 0 ? '−' : '';
  const abs = Math.abs(Math.round(ms));
  const minutes = Math.floor(abs / 60000), seconds = Math.floor(abs / 1000) % 60, centi = Math.floor(abs % 1000 / 10);
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}.${String(centi).padStart(2, '0')}`;
}

/** Accepts 1:23.45, 1:23, 83.4, -0:01.2 (ASCII or U+2212 minus). Returns integer ms or null. */
export function parseStamp(text: string): number | null {
  const match = /^\s*([-−])?\s*(?:(\d{1,3}):)?(\d{1,4})(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (!match) return null;
  const [, minus, mm, ss, frac] = match;
  const seconds = Number(ss);
  if (mm !== undefined && seconds >= 60) return null;
  const ms = (Number(mm ?? 0) * 60 + seconds) * 1000 + Number((frac ?? '').padEnd(3, '0'));
  if (!Number.isSafeInteger(ms)) return null;
  return minus ? -ms : ms;
}

// ── Edits ─────────────────────────────────────────────────────────────────────

function nextId(draft: LyricsDraft, taken: Set<string> = new Set(draft.lines.map(l => l.id))): [string, number] {
  let seq = draft.seq;
  let id: string;
  do { seq++; id = `${draft.trackId}-u${seq}`; } while (taken.has(id));
  return [id, seq];
}

export type DraftAction =
  | { type: 'text'; id: string; field: 'original' | 'translation'; value: string }
  | { type: 'time'; id: string; effectiveMs: number | null }
  | { type: 'nudge'; id: string; deltaMs: number }
  | { type: 'stamp'; id: string; startMs: number }
  | { type: 'insert'; afterId: string | null; brk?: boolean }
  | { type: 'remove'; id: string }
  | { type: 'kind'; kind: DraftKind }
  | { type: 'offset'; offsetMs: number }
  | { type: 'mergeOffset' }
  | { type: 'sortByTime' }
  | { type: 'language'; field: 'language' | 'translationLanguage'; value: string | null }
  | { type: 'locked'; locked: boolean }
  | { type: 'replace'; draft: LyricsDraft };

const round10 = (ms: number) => Math.round(ms / 10) * 10;

export function applyDraftAction(draft: LyricsDraft, action: DraftAction): LyricsDraft {
  const mapLine = (id: string, fn: (line: DraftLine) => DraftLine) =>
    ({ ...draft, lines: draft.lines.map(line => line.id === id ? fn(line) : line) });
  switch (action.type) {
    case 'text': return mapLine(action.id, line => ({ ...line, [action.field]: action.value }));
    case 'time': return mapLine(action.id, line => ({ ...line, startMs: action.effectiveMs === null ? null : action.effectiveMs - draft.offsetMs }));
    case 'nudge': return mapLine(action.id, line => line.startMs === null ? line : { ...line, startMs: line.startMs + action.deltaMs });
    case 'stamp': {
      const stamped = mapLine(action.id, line => ({ ...line, startMs: action.startMs }));
      return draft.kind === 'synced' ? stamped : { ...stamped, kind: 'synced' };
    }
    case 'insert': {
      const [id, seq] = nextId(draft);
      const at = action.afterId === null ? 0 : draft.lines.findIndex(l => l.id === action.afterId) + 1;
      let startMs: number | null = null;
      if (draft.kind === 'synced') {
        const before = draft.lines[at - 1]?.startMs ?? null, after = draft.lines[at]?.startMs ?? null;
        startMs = before !== null && after !== null ? round10(before + (after - before) / 2)
          : before !== null ? before + 2000 : after !== null ? after - 2000 : 0;
      }
      const line: DraftLine = { id, startMs, original: '', translation: '' };
      const lines = [...draft.lines.slice(0, at), line, ...draft.lines.slice(at)];
      // A new line in empty lyrics starts a plain text body unless timing exists.
      return { ...draft, seq, lines, kind: draft.kind === 'missing' ? 'plain' : draft.kind };
    }
    case 'remove': return { ...draft, lines: draft.lines.filter(line => line.id !== action.id) };
    case 'kind': {
      if (action.kind === draft.kind) return draft;
      if (action.kind === 'missing') return { ...draft, kind: 'missing', lines: [] };
      if (action.kind === 'plain') return { ...draft, kind: 'plain',
        lines: draft.lines.filter(l => l.original.trim()).map(l => ({ ...l, startMs: null })) };
      return { ...draft, kind: 'synced' };
    }
    case 'offset': return { ...draft, offsetMs: Math.round(action.offsetMs) };
    case 'mergeOffset': return { ...draft, offsetMs: 0,
      lines: draft.lines.map(l => l.startMs === null ? l : { ...l, startMs: l.startMs + draft.offsetMs }) };
    case 'sortByTime': {
      const timed = draft.lines.map((line, index) => ({ line, index }));
      timed.sort((a, b) => (a.line.startMs ?? Infinity) - (b.line.startMs ?? Infinity) || a.index - b.index);
      return { ...draft, lines: timed.map(t => t.line) };
    }
    case 'language': return { ...draft, [action.field]: action.value };
    case 'locked': return { ...draft, locked: action.locked };
    case 'replace': return action.draft;
  }
}

/** Typing into one field coalesces into one undo step; everything else is its own step. */
export function coalesceKey(action: DraftAction): string | null {
  if (action.type === 'text') return `text:${action.id}:${action.field}`;
  if (action.type === 'offset') return 'offset';
  return null;
}

export interface DraftHistory { past: LyricsDraft[]; present: LyricsDraft; future: LyricsDraft[]; lastKey: string | null }
export type HistoryAction = DraftAction | { type: 'undo' } | { type: 'redo' } | { type: 'reset'; draft: LyricsDraft };
const LIMIT = 100;

export function historyReducer(state: DraftHistory, action: HistoryAction): DraftHistory {
  if (action.type === 'reset') return { past: [], present: action.draft, future: [], lastKey: null };
  if (action.type === 'undo') {
    if (!state.past.length) return state;
    return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future], lastKey: null };
  }
  if (action.type === 'redo') {
    if (!state.future.length) return state;
    return { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1), lastKey: null };
  }
  const next = applyDraftAction(state.present, action);
  if (next === state.present) return state;
  const key = coalesceKey(action);
  if (key && key === state.lastKey) return { ...state, present: next, future: [] };
  return { past: [...state.past, state.present].slice(-LIMIT), present: next, future: [], lastKey: key };
}

// ── Imports into the draft ───────────────────────────────────────────────────

export interface ImportOutcome {
  draft: LyricsDraft;
  applied: boolean;
  message: string;
  warnings: string[];
  /** The translation could not be paired by time; the user may align it line by line. */
  canAlignByLine: boolean;
}

function freshLines(draft: LyricsDraft, lines: readonly LyricLine[]): [DraftLine[], number] {
  const taken = new Set<string>();
  let seq = draft.seq;
  const out = lines.map(line => {
    const [id, next] = nextId({ ...draft, seq }, taken);
    seq = next; taken.add(id);
    return { id, startMs: line.startMs, original: line.original, translation: line.translation ?? '' };
  });
  return [out, seq];
}
const asLyricLines = (lines: readonly DraftLine[]): LyricLine[] =>
  lines.map(l => ({ id: l.id, startMs: l.startMs, original: l.original, ...(l.translation ? { translation: l.translation } : {}) }));

/**
 * Applies a pending import to the *current* draft (so edits made while the import ran are kept).
 * original: replaces the text and timing; existing translations are re-paired by time when possible.
 * translation: paired onto the current originals with the shared attachTranslation (never by row).
 * bilingual: replaces text, timing and translations.
 */
export function applyImport(draft: LyricsDraft, pending: LyricsPendingImport): ImportOutcome {
  const warnings = [...pending.warnings];
  if (pending.content === 'translation') {
    const originals = draft.lines.filter(l => l.original.trim());
    if (draft.kind === 'missing' || !originals.length) {
      return { draft, applied: false, canAlignByLine: false, warnings,
        message: '草稿还没有原文，译文没有导入。请先输入或导入原文。' };
    }
    const cleared = draft.lines.map(l => ({ ...l, translation: '' }));
    const paired = attachTranslation(asLyricLines(cleared), pending.lines);
    warnings.push(...paired.warnings);
    const lines = cleared.map((line, i) => ({ ...line, translation: paired.lines[i].translation ?? '' }));
    const count = lines.filter(l => l.translation.trim()).length;
    const untimed = draft.kind !== 'synced' || pending.kind !== 'synced';
    if (!count) {
      return { draft, applied: false, canAlignByLine: untimed, warnings,
        message: untimed ? '原文或译文没有时间，无法按时间配对。可以确认后按行对齐。' : '没有可以按时间配对的译文行，草稿未改动。' };
    }
    return { draft: { ...draft, lines, translationLanguage: pending.language ?? draft.translationLanguage },
      applied: true, canAlignByLine: false, warnings, message: `已按时间配对 ${count} 行译文。` };
  }
  const [lines, seq] = freshLines(draft, pending.lines);
  let next: LyricsDraft = { ...draft, seq, kind: pending.kind, lines, language: pending.language ?? draft.language };
  if (pending.content === 'bilingual') {
    const count = lines.filter(l => l.translation.trim()).length;
    return { draft: next, applied: true, canAlignByLine: false, warnings,
      message: `已导入双语歌词：${lines.length} 行，其中 ${count} 行带译文。` };
  }
  // original: try to keep the translations the draft already had.
  const oldTranslations = draft.lines.filter(l => l.original.trim() && l.translation.trim())
    .map(l => ({ id: l.id, startMs: l.startMs, original: l.translation }));
  const keptAt = new Set<number>();
  if (oldTranslations.length) {
    if (pending.kind === 'synced' && draft.kind === 'synced') {
      const paired = attachTranslation(asLyricLines(lines), oldTranslations);
      next = { ...next, lines: lines.map((l, i) => ({ ...l, translation: paired.lines[i].translation ?? '' })) };
      if (paired.warnings.length) warnings.push('原有译文：' + paired.warnings.join(' '));
      // Only for the message below: pair the same old translations onto the new lines *without* their
      // incoming translations. Pairing goes by time alone, so these are exactly the lines the rule
      // above gave the draft's translation — even where its text happens to equal the import's.
      const own = attachTranslation(asLyricLines(lines.map(l => ({ ...l, translation: '' }))), oldTranslations);
      own.lines.forEach((l, i) => { if (l.translation?.trim()) keptAt.add(i); });
    } else {
      warnings.push('原有译文无法按时间对应到新原文，已移除；可以重新导入译文。');
    }
  }
  // Say where the translations in the result came from (the rule above decides; this only reports it).
  let fromImport = 0, kept = 0, replaced = 0;
  next.lines.forEach((line, i) => {
    const text = line.translation.trim();
    if (!text) return;
    if (!keptAt.has(i)) { fromImport++; return; }
    kept++;
    const incoming = lines[i].translation.trim();
    if (incoming && incoming !== text) replaced++;   // the import's own, set aside for the draft's
  });
  if (replaced) warnings.push(`有 ${replaced} 行导入时也带着译文，按规则保留了草稿里原有的译文。`);
  const translated = fromImport + kept;
  const detail = !translated ? '' : `，其中 ${translated} 行带译文` +
    (fromImport && kept ? `（导入的 ${fromImport} 行，原有的 ${kept} 行）` : kept ? '（都是草稿里原有的译文）' : '');
  return { draft: next, applied: true, canAlignByLine: false, warnings, message: `已导入原文：${lines.length} 行${detail}。` };
}

/** Explicit, user-confirmed fallback: pair non-empty translation rows with non-empty originals in order. */
export function alignTranslationByLine(draft: LyricsDraft, translation: readonly LyricLine[]): { draft: LyricsDraft; warnings: string[] } {
  const rows = translation.map(l => l.original).filter(text => text.trim());
  const targets = draft.lines.filter(l => l.original.trim());
  const warnings: string[] = [];
  if (rows.length !== targets.length) warnings.push(`译文 ${rows.length} 行，原文 ${targets.length} 行，行数不一致，请逐行核对。`);
  let i = 0;
  const lines = draft.lines.map(line => line.original.trim() ? { ...line, translation: rows[i++] ?? '' } : { ...line, translation: '' });
  return { draft: { ...draft, lines }, warnings };
}

// ── Comparing a draft with the latest saved document ─────────────────────────

export type CompareStatus = 'same' | 'changed' | 'onlyDraft' | 'onlyLatest';
export interface CompareRow {
  key: string;
  latest?: DraftLine;
  draft?: DraftLine;
  /** Heard times (startMs + that version's offset). */
  latestTime: number | null;
  draftTime: number | null;
  status: CompareStatus;
  /** Which parts differ, for a paired row. */
  changed: { time: boolean; original: boolean; translation: boolean };
}
export interface CompareSummary { field: string; latest: string; draft: string }

/**
 * Pairs the draft with the latest saved version line by line and lists the differences. Lines pair
 * by id first (both sides came from the same document), then by timeline position, then by
 * identical text. A time counts as changed only when it differs both on the timeline and as heard,
 * so an offset change or "merge offset" alone shows up once, in the summary, not on every line.
 * Nothing is merged: the user decides afterwards.
 */
export function compareDrafts(latest: LyricsDraft, draft: LyricsDraft): { rows: CompareRow[]; summary: CompareSummary[] } {
  const summary: CompareSummary[] = [];
  const label = { synced: '同步歌词', plain: '纯文本', missing: '无歌词' };
  const push = (field: string, a: string, b: string) => { if (a !== b) summary.push({ field, latest: a, draft: b }); };
  push('类型', label[latest.kind], label[draft.kind]);
  push('偏移', formatOffsetMs(latest.offsetMs), formatOffsetMs(draft.offsetMs));
  push('原文语言', latest.language ?? '未标注', draft.language ?? '未标注');
  push('译文语言', latest.translationLanguage ?? '未标注', draft.translationLanguage ?? '未标注');
  push('锁定', latest.locked ? '锁定' : '未锁定', draft.locked ? '锁定' : '未锁定');

  const A = latest.lines, B = draft.lines;
  const pairOf = new Map<number, number>();   // draft index → latest index
  const usedA = new Set<number>();
  const match = (test: (a: DraftLine, b: DraftLine) => boolean) => B.forEach((b, j) => {
    if (pairOf.has(j)) return;
    const i = A.findIndex((a, k) => !usedA.has(k) && test(a, b));
    if (i >= 0) { pairOf.set(j, i); usedA.add(i); }
  });
  match((a, b) => a.id === b.id);
  match((a, b) => a.startMs !== null && a.startMs === b.startMs);
  match((a, b) => a.original.trim() !== '' && a.original === b.original);

  const rows: CompareRow[] = [];
  const heard = (d: LyricsDraft, l?: DraftLine) => l && l.startMs !== null && d.kind === 'synced' ? l.startMs + d.offsetMs : null;
  const row = (a: DraftLine | undefined, b: DraftLine | undefined) => {
    const latestTime = heard(latest, a), draftTime = heard(draft, b);
    const changed = {
      time: !!a && !!b && a.startMs !== b.startMs && latestTime !== draftTime,
      original: !!a && !!b && a.original !== b.original,
      translation: !!a && !!b && a.translation !== b.translation,
    };
    const status: CompareStatus = !b ? 'onlyLatest' : !a ? 'onlyDraft' : changed.time || changed.original || changed.translation ? 'changed' : 'same';
    rows.push({ key: `${a?.id ?? '-'}|${b?.id ?? '-'}|${rows.length}`, latest: a, draft: b, latestTime, draftTime, status, changed });
  };
  let next = 0;
  const flushLatest = (upTo: number) => {
    for (; next < upTo; next++) if (!usedA.has(next)) row(A[next], undefined);
  };
  B.forEach((b, j) => {
    const i = pairOf.get(j);
    if (i === undefined) { row(undefined, b); return; }
    if (i >= next) { flushLatest(i); next = i + 1; }
    row(A[i], b);
  });
  flushLatest(A.length);
  return { rows, summary };
}
function formatOffsetMs(ms: number) {
  if (!ms) return '0.0 秒';
  return `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(1)} 秒`;
}

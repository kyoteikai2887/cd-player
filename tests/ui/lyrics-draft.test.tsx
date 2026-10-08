import { describe, expect, test } from 'vitest';
import type { LyricsDocument, LyricsPendingImport } from '../../src/contracts/player.ts';
import { parseLyrics } from '../../src/core/lyrics.ts';
import {
  alignTranslationByLine, applyDraftAction, applyImport, compareDrafts, draftFromDocument, formatStamp,
  historyReducer, isDirty, parseStamp, toEdit, validateDraft,
} from '../../src/ui/lib/lyricsDraft.ts';
import type { DraftHistory, LyricsDraft } from '../../src/ui/lib/lyricsDraft.ts';

const doc = (text: string, patch: Partial<LyricsDocument> = {}): LyricsDocument =>
  ({ ...parseLyrics(text, 't1', { duplicateTimestampMode: 'bilingual' }), revision: 4, locked: false, ...patch });
const SYNCED = '[00:10.00]一行目\n[00:10.00]第一行\n[00:20.00]二行目\n[00:20.00]第二行\n[00:30.00]三行目';
const pending = (content: LyricsPendingImport['content'], text: string): LyricsPendingImport => {
  const parsed = parseLyrics(text, 't1', { duplicateTimestampMode: content === 'bilingual' ? 'bilingual' : 'merge' });
  return { id: 'imp-1', content, kind: parsed.kind as 'synced' | 'plain', lines: parsed.lines, language: parsed.language, warnings: [] };
};

describe('lyrics draft: document round trip and dirty state', () => {
  test('a fresh draft writes back exactly the saved document and is not dirty', () => {
    const base = doc(SYNCED, { offsetMs: 300, language: 'ja', translationLanguage: 'zh-Hans' });
    const draft = draftFromDocument(base);
    expect(isDirty(draft, base)).toBe(false);
    expect(toEdit(draft)).toEqual({ kind: 'synced', language: 'ja', translationLanguage: 'zh-Hans', offsetMs: 300, locked: false,
      lines: base.lines.map(l => ({ id: l.id, startMs: l.startMs, original: l.original, ...(l.translation ? { translation: l.translation } : {}) })) });
    expect(isDirty(applyDraftAction(draft, { type: 'locked', locked: true }), base)).toBe(true);
  });
  test('instrumental and spoken marks keep their old lines; the draft shows what saving would write', () => {
    const marked = { ...doc(SYNCED), kind: 'instrumental' as const };
    expect(draftFromDocument(marked).kind).toBe('synced');
    expect(draftFromDocument({ ...marked, lines: [] }).kind).toBe('missing');
  });
});

describe('lyrics draft: time is edited as the listener hears it', () => {
  const base = doc(SYNCED, { offsetMs: 500 });
  const draft = draftFromDocument(base);
  const first = draft.lines[0];
  test('the editor edits effective time; saving keeps startMs = effective − offset', () => {
    const edited = applyDraftAction(draft, { type: 'time', id: first.id, effectiveMs: 9000 });
    expect(toEdit(edited).lines[0].startMs).toBe(8500);
  });
  test('negative times are valid', () => {
    const edited = applyDraftAction(draft, { type: 'time', id: first.id, effectiveMs: -1200 });
    expect(toEdit(edited).lines[0].startMs).toBe(-1700);
    expect(validateDraft(edited)).toEqual([]);
  });
  test('merging the offset into the timeline leaves every effective time unchanged', () => {
    const merged = applyDraftAction(draft, { type: 'mergeOffset' });
    expect(merged.offsetMs).toBe(0);
    expect(merged.lines.map(l => l.startMs)).toEqual(draft.lines.map(l => l.startMs! + 500));
  });
  test('out-of-order times are flagged on the line and fixed by sorting', () => {
    const swapped = applyDraftAction(draft, { type: 'time', id: draft.lines[2].id, effectiveMs: 5000 });
    expect(validateDraft(swapped).map(i => i.code)).toContain('order');
    expect(validateDraft(applyDraftAction(swapped, { type: 'sortByTime' }))).toEqual([]);
  });
  test('stamp text: m:ss.cc in and out, including negative values', () => {
    expect(formatStamp(83450)).toBe('1:23.45');
    expect(formatStamp(-1200)).toBe('−0:01.20');
    expect(parseStamp('1:23.45')).toBe(83450);
    expect(parseStamp('−0:01.2')).toBe(-1200);
    expect(parseStamp('-0:01.20')).toBe(-1200);
    expect(parseStamp('83.4')).toBe(83400);
    expect(parseStamp('1:75')).toBeNull();
    expect(parseStamp('abc')).toBeNull();
  });
});

describe('lyrics draft: lines, breaks and tap timing', () => {
  test('a new synced line lands between its neighbours; a break is an empty timed line', () => {
    const draft = draftFromDocument(doc(SYNCED));
    const inserted = applyDraftAction(draft, { type: 'insert', afterId: draft.lines[0].id });
    expect(inserted.lines[1].startMs).toBe(15000);
    expect(new Set(inserted.lines.map(l => l.id)).size).toBe(inserted.lines.length);
    // An empty original with a time is a valid break; with a translation it is not.
    expect(validateDraft(inserted)).toEqual([]);
    const orphan = applyDraftAction(inserted, { type: 'text', id: inserted.lines[1].id, field: 'translation', value: '孤立' });
    expect(validateDraft(orphan).map(i => i.code)).toEqual(['orphanTranslation']);
  });
  test('tapping a plain draft turns it into synced lyrics, line by line', () => {
    const plain = draftFromDocument(doc('一行目\n二行目'));
    expect(plain.kind).toBe('plain');
    const one = applyDraftAction(plain, { type: 'stamp', id: plain.lines[0].id, startMs: 1000 });
    expect(one.kind).toBe('synced');
    expect(validateDraft(one).map(i => i.code)).toContain('timestamp');   // second line still untimed
    const two = applyDraftAction(one, { type: 'stamp', id: plain.lines[1].id, startMs: 4000 });
    expect(validateDraft(two)).toEqual([]);
  });
  test('clearing is kind missing with no lines; plain drops times and blank lines', () => {
    const draft = draftFromDocument(doc(SYNCED + '\n[00:40.00]'));
    expect(toEdit(applyDraftAction(draft, { type: 'kind', kind: 'missing' }))).toMatchObject({ kind: 'missing', lines: [] });
    const plain = applyDraftAction(draft, { type: 'kind', kind: 'plain' });
    expect(plain.lines.every(l => l.startMs === null && l.original.trim())).toBe(true);
  });
  test('typing into one field is one undo step; undo and redo restore exactly', () => {
    const draft = draftFromDocument(doc(SYNCED));
    let h: DraftHistory = { past: [], present: draft, future: [], lastKey: null };
    for (const value of ['一', '一行', '一行目!']) h = historyReducer(h, { type: 'text', id: draft.lines[0].id, field: 'original', value });
    h = historyReducer(h, { type: 'nudge', id: draft.lines[0].id, deltaMs: 100 });
    expect(h.past.length).toBe(2);
    h = historyReducer(h, { type: 'undo' });
    expect(h.present.lines[0].startMs).toBe(10000);
    h = historyReducer(h, { type: 'undo' });
    expect(h.present).toBe(draft);
    h = historyReducer(h, { type: 'redo' });
    expect(h.present.lines[0].original).toBe('一行目!');
  });
});

describe('lyrics draft: imports go into the current draft', () => {
  test('a translation pairs by time with the shared rule, keeping edits made while it was imported', () => {
    const base = draftFromDocument(doc('[00:10.00]一行目\n[00:20.00]二行目\n[00:30.00]三行目'));
    const edited = applyDraftAction(base, { type: 'text', id: base.lines[1].id, field: 'original', value: '二行目（修正）' });
    const outcome = applyImport(edited, pending('translation', '[00:10.05]第一行\n[00:20.00]第二行\n[00:45.00]多余的一行'));
    expect(outcome.applied).toBe(true);
    expect(outcome.draft.lines.map(l => l.translation)).toEqual(['第一行', '第二行', '']);
    expect(outcome.draft.lines[1].original).toBe('二行目（修正）');
    expect(outcome.warnings.join()).toMatch(/1 行译文无法安全配对/);
  });
  test('untimed translations are never paired by row automatically; aligning by line is an explicit step', () => {
    const base = draftFromDocument(doc('一行目\n二行目\n三行目'));
    const outcome = applyImport(base, pending('translation', '第一行\n第二行'));
    expect(outcome.applied).toBe(false);
    expect(outcome.canAlignByLine).toBe(true);
    const aligned = alignTranslationByLine(base, pending('translation', '第一行\n第二行').lines);
    expect(aligned.draft.lines.map(l => l.translation)).toEqual(['第一行', '第二行', '']);
    expect(aligned.warnings.join()).toMatch(/行数不一致/);
  });
  test('an original import replaces text and timing, re-pairs old translations and keeps IDs unique', () => {
    const base = draftFromDocument(doc(SYNCED));
    const outcome = applyImport(base, pending('original', '[00:10.00]新一行目\n[00:20.02]新二行目'));
    expect(outcome.draft.lines.map(l => [l.original, l.translation])).toEqual([['新一行目', '第一行'], ['新二行目', '第二行']]);
    const ids = outcome.draft.lines.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some(id => base.lines.some(l => l.id === id))).toBe(false);
  });
  test('a bilingual import replaces the whole body', () => {
    const outcome = applyImport(draftFromDocument(doc('古い')), pending('bilingual', '[00:01.00]新しい\n[00:01.00]新的'));
    expect(outcome.draft.kind).toBe('synced');
    expect(outcome.draft.lines.map(l => [l.original, l.translation])).toEqual([['新しい', '新的']]);
  });
  test('a translation into empty lyrics is refused without touching the draft', () => {
    const empty = draftFromDocument(doc(''));
    const outcome = applyImport(empty, pending('translation', '[00:01.00]译文'));
    expect(outcome.applied).toBe(false);
    expect(outcome.draft).toBe(empty);
  });
});

describe('lyrics draft: comparing with the latest saved version', () => {
  test('rows pair line by line and show what differs, without merging', () => {
    const latest: LyricsDraft = draftFromDocument(doc(SYNCED));
    const mine = applyDraftAction(applyDraftAction(latest, { type: 'text', id: latest.lines[1].id, field: 'original', value: '二行目!' }),
      { type: 'offset', offsetMs: 200 });
    const { rows, summary } = compareDrafts(latest, mine);
    // An offset change is reported once, not as a time change on every line.
    expect(summary.map(s => s.field)).toEqual(['偏移']);
    expect(rows.map(r => r.status)).toEqual(['same', 'changed', 'same']);
    expect(rows[1].changed).toEqual({ time: false, original: true, translation: false });
    // Merging a saved offset into the timeline keeps what is heard: no time changes either.
    const withOffset = applyDraftAction(latest, { type: 'offset', offsetMs: 300 });
    const merged = compareDrafts(withOffset, applyDraftAction(withOffset, { type: 'mergeOffset' }));
    expect(merged.summary.map(s => s.field)).toEqual(['偏移']);
    expect(merged.rows.map(r => r.status)).toEqual(['same', 'same', 'same']);
  });
  test('added, removed and retimed lines keep their place in order', () => {
    const latest: LyricsDraft = draftFromDocument(doc(SYNCED));
    let mine = applyDraftAction(latest, { type: 'remove', id: latest.lines[0].id });
    mine = applyDraftAction(mine, { type: 'insert', afterId: mine.lines[1].id });
    mine = applyDraftAction(mine, { type: 'time', id: mine.lines[0].id, effectiveMs: 2500 });
    const { rows } = compareDrafts(latest, mine);
    expect(rows.map(r => r.status)).toEqual(['onlyLatest', 'changed', 'same', 'onlyDraft']);
    expect(rows[1].changed.time).toBe(true);
    expect(rows[1].latestTime).not.toBe(rows[1].draftTime);
  });
  test('a re-imported version with new ids still pairs by time or identical text', () => {
    const latest: LyricsDraft = draftFromDocument(doc(SYNCED));
    const reimported = { ...latest, lines: latest.lines.map((l, i) => ({ ...l, id: 'x' + i })) };
    expect(compareDrafts(latest, reimported).rows.map(r => r.status)).toEqual(['same', 'same', 'same']);
  });
});

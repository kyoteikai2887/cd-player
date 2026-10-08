import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLyrics, activeLyricIndex, nextLyricBoundary, attachTranslation,
  serializeLyrics, validateLyricsEdit } from '../../src/core/lyrics.ts';
import type { LyricsEdit, LyricLine } from '../../src/contracts/player.ts';

const edit = (text: string, offsetMs = 0): LyricsEdit => {
  const doc = parseLyrics(text, 'test', { duplicateTimestampMode: 'bilingual' });
  return { kind: doc.kind as LyricsEdit['kind'], language: doc.language, translationLanguage: doc.translationLanguage,
    lines: doc.lines, locked: true, offsetMs };
};
test('file offset is folded even after timestamps; negative start survives', () => {
  const doc = parseLyrics('[00:00.100]first\n[00:10.000]second\n[offset:+300]', 'x');
  assert.deepEqual(doc.lines.map(l => l.startMs), [-200, 9700]);
  assert.equal(doc.offsetMs, 0); assert.equal(doc.language, null);
  assert.equal(parseLyrics('[00:01]a\n[00:01]b', 'x', { duplicateTimestampMode: 'bilingual' }).translationLanguage, null);
});
test('blank boundary clears highlight and next boundary includes breaks', () => {
  const doc = parseLyrics('[00:01]one\n[00:02]\n[00:03]two', 'x');
  assert.equal(activeLyricIndex(doc.lines, 900, 200), -1);
  assert.equal(activeLyricIndex(doc.lines, 1200, 200), 0);
  assert.equal(nextLyricBoundary(doc.lines, 1200, 200), 2200);
  assert.equal(activeLyricIndex(doc.lines, 2200, 200), -1);
  assert.equal(nextLyricBoundary(doc.lines, 2200, 200), 3200);
  assert.equal(nextLyricBoundary(doc.lines, 3200, 200), null);
});
test('plain lyrics never synchronize', () => {
  const doc = parseLyrics('first\nsecond', 'x');
  assert.equal(activeLyricIndex(doc.lines, 10000), -1);
  assert.equal(nextLyricBoundary(doc.lines, 0), null);
});
test('LRC export/readback preserves effective negative times, breaks and translation', () => {
  const original = edit('[offset:+400]\n[00:00.100]a\n[00:00.100]甲\n[00:01.000]\n[00:02.000]b\n[00:02.000]乙', -200);
  const serialized = serializeLyrics(original);
  const reread = parseLyrics(serialized, 'again', { duplicateTimestampMode: 'bilingual' });
  assert.deepEqual(reread.lines.map(l => [l.startMs, l.original, l.translation]),
    original.lines.map(l => [l.startMs! + original.offsetMs, l.original, l.translation]));
  assert.equal(reread.offsetMs, 0);
});
test('mutual-nearest matching avoids greedy theft; inputs remain unchanged', () => {
  const originals: LyricLine[] = [{ id: 'a', startMs: 1000, original: 'a' }, { id: 'b', startMs: 1100, original: 'b' }];
  const translations: LyricLine[] = [{ id: 't', startMs: 1080, original: '乙' }];
  const paired = attachTranslation(originals, translations);
  assert.equal(paired.lines[0].translation, undefined); assert.equal(paired.lines[1].translation, '乙');
  assert.equal(originals[1].translation, undefined);
});
test('ties and untimed translations remain unpaired with warnings', () => {
  const originals = [{ id: 'a', startMs: 1000, original: 'a' }];
  const ties = attachTranslation(originals, [{ id: 't', startMs: 900, original: '甲' }, { id: 'u', startMs: 1100, original: '乙' }]);
  assert.equal(ties.lines[0].translation, undefined); assert.ok(ties.warnings.length);
  assert.ok(attachTranslation(originals, [{ id: 't', startMs: null, original: '甲' }]).warnings.length);
});
test('editor validation detects duplicate IDs, times, sort order and missing content', () => {
  const draft = edit('[00:01]a\n[00:02]b');
  draft.lines[1].id = draft.lines[0].id; draft.lines[1].startMs = 1000;
  assert.deepEqual(validateLyricsEdit(draft).map(i => i.code), ['duplicateId', 'duplicateTimestamp']);
  draft.lines[1].id = 'unique'; draft.lines[1].startMs = 500;
  assert.ok(validateLyricsEdit(draft).some(i => i.code === 'order'));
  assert.ok(validateLyricsEdit({ ...draft, kind: 'missing' }).some(i => i.code === 'missingNotEmpty'));
  assert.deepEqual(validateLyricsEdit({ ...draft, kind: 'missing', lines: [] }), []);
});
test('ambiguous multiline bilingual export fails instead of silently changing content', () => {
  const draft = edit('[00:01]a'); draft.lines[0].original = 'a\nb'; draft.lines[0].translation = '甲';
  assert.throws(() => serializeLyrics(draft));
  assert.equal(parseLyrics(serializeLyrics(draft, { includeTranslation: false }), 'x').lines[0].original, 'a\nb');
});

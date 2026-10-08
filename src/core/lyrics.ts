import type {
  LyricLine, LyricsDocument, LyricsEdit, LyricsParseOptions, LyricsPairingResult,
  LyricsSerializeOptions, LyricsValidationIssue, TranslationStatus,
} from '../contracts/player.ts';

/** Pure/browser-safe. A positive file offset advances; user offset delays. */
export function parseLyrics(text: string, trackId: string, options: LyricsParseOptions = {}): LyricsDocument {
  const document: LyricsDocument = {
    trackId, revision: 0, kind: 'missing', lookup: 'idle', lookupError: null,
    language: options.language ?? null, translationLanguage: options.translationLanguage ?? null,
    translationStatus: 'missing', source: { original: options.source ?? { kind: 'manual' } },
    locked: true, offsetMs: 0, lines: [], warnings: [],
  };
  const rows: { startMs: number; text: string }[] = [];
  const plain: string[] = [];
  let fileOffset = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    const offset = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (offset) {
      const value = Number(offset[1]);
      if (Number.isSafeInteger(value)) fileOffset = value;
      else document.warnings.push('文件 offset 超出有效范围，已忽略。');
      continue;
    }
    const language = line.match(/^\[lang:(.*?)\]$/i);
    if (language) { document.language ??= language[1].trim() || null; continue; }
    if (/^\[(?:ar|al|ti|au|by|re|ve|length|id):.*\]$/i.test(line)) continue;
    const tags = [...line.matchAll(/\[(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) { plain.push(line); continue; }
    const content = line.replace(/\[\d+:[0-5]?\d(?:[.:]\d{1,3})?\]/g, '').trim();
    for (const stamp of tags) {
      const startMs = Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 +
        Number((stamp[3] ?? '').padEnd(3, '0'));
      if (Number.isSafeInteger(startMs)) rows.push({ startMs, text: content });
      else document.warnings.push('时间戳超出有效范围，已忽略。');
    }
  }
  if (rows.length) {
    document.kind = 'synced';
    rows.sort((a, b) => a.startMs - b.startMs);
    const grouped = new Map<number, string[]>();
    for (const row of rows) {
      const normalized = row.startMs - fileOffset;
      if (!Number.isSafeInteger(normalized)) { document.warnings.push('归一化时间超出有效范围。'); continue; }
      grouped.set(normalized, [...(grouped.get(normalized) ?? []), row.text]);
    }
    document.lines = [...grouped].map(([startMs, values], index) => {
      const line: LyricLine = { id: trackId + '-line-' + index, startMs, original: values.join('\n') };
      if (options.duplicateTimestampMode === 'bilingual' && values.length > 1) {
        line.original = values[0];
        line.translation = values.slice(1).join('\n');
      }
      return line;
    });
    if (plain.length) document.warnings.push('未同步的文本行没有插入同步时间轴，请人工核对。');
    if (!document.lines.length) document.kind = 'missing';
  } else if (plain.length) {
    document.kind = 'plain';
    document.lines = plain.map((original, index) => ({ id: trackId + '-line-' + index, startMs: null, original }));
  }
  document.translationStatus = translationStatus(document.lines);
  if (document.translationStatus !== 'missing') {
    document.source.translation = { ...(options.source ?? { kind: 'manual' }) };
  }
  return document;
}

export function translationStatus(lines: readonly LyricLine[]): TranslationStatus {
  const nonempty = lines.filter(line => line.original.trim());
  const translated = nonempty.filter(line => line.translation?.trim()).length;
  return translated === 0 ? 'missing' : translated === nonempty.length ? 'available' : 'partial';
}

/** One-to-one mutual-nearest matching of normalized times. Does not mutate inputs. */
export function attachTranslation(
  draftLines: readonly LyricLine[], translationLines: readonly LyricLine[], toleranceMs = 100,
): LyricsPairingResult {
  const result = { lines: draftLines.map(line => ({ ...line })), warnings: [] as string[] };
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    result.warnings.push('配对容差必须是非负有限数值。'); return result;
  }
  const originals = draftLines.map((line, index) => ({ line, index })).filter(item => item.line.original.trim());
  const translations = translationLines.map((line, index) => ({ line, index })).filter(item => item.line.original.trim());
  if (originals.some(item => item.line.startMs === null) || translations.some(item => item.line.startMs === null)) {
    result.warnings.push('未同步译文需要用户明确进行人工配对。'); return result;
  }
  const edges = originals.flatMap(o => translations.map(t => ({
    oi: o.index, ti: t.index, distance: Math.abs(o.line.startMs! - t.line.startMs!),
  }))).filter(edge => edge.distance <= toleranceMs);
  const uniqueBest = (items: typeof edges) => {
    const ordered = [...items].sort((a, b) => a.distance - b.distance);
    return ordered.length && (ordered.length === 1 || ordered[0].distance < ordered[1].distance) ? ordered[0] : null;
  };
  const matched = new Set<number>();
  for (const original of originals) {
    const best = uniqueBest(edges.filter(edge => edge.oi === original.index));
    if (!best) continue;
    const reciprocal = uniqueBest(edges.filter(edge => edge.ti === best.ti));
    if (reciprocal?.oi !== original.index) continue;
    result.lines[original.index].translation = translationLines[best.ti].original;
    matched.add(best.ti);
  }
  const unmatched = translations.length - matched.size;
  if (unmatched) result.warnings.push(String(unmatched) + ' 行译文无法安全配对，请人工核对。');
  return result;
}

/** Input timeline is validated, sorted and has one grouped row per timestamp. */
export function activeLyricIndex(lines: readonly LyricLine[], renderPos: number, offsetMs = 0): number {
  if (!Number.isFinite(renderPos) || !Number.isFinite(offsetMs)) return -1;
  const target = renderPos - offsetMs;
  let low = 0, high = lines.length - 1, answer = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = lines[mid].startMs;
    if (start !== null && start <= target) { answer = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return answer >= 0 && lines[answer].original.trim() ? answer : -1;
}

export function nextLyricBoundary(lines: readonly LyricLine[], renderPos: number, offsetMs = 0): number | null {
  if (!Number.isFinite(renderPos) || !Number.isFinite(offsetMs)) return null;
  let low = 0, high = lines.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const start = lines[mid].startMs;
    if (start === null) return null;
    if (start + offsetMs <= renderPos) low = mid + 1;
    else high = mid;
  }
  const start = lines[low]?.startMs;
  return start === null || start === undefined ? null : start + offsetMs;
}

/** The editor and save handler call exactly the same validator. */
export function validateLyricsEdit(edit: LyricsEdit): LyricsValidationIssue[] {
  const issues: LyricsValidationIssue[] = [];
  const add = (code: LyricsValidationIssue['code'], message: string, lineId?: string) => issues.push({ code, message, ...(lineId ? { lineId } : {}) });
  if (!['synced', 'plain', 'missing'].includes(edit.kind)) add('kind', '不支持的歌词类型。');
  if (!Number.isSafeInteger(edit.offsetMs)) add('offset', '偏移必须是有效的整数毫秒。');
  for (const language of [edit.language, edit.translationLanguage]) {
    if (language !== null && (typeof language !== 'string' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language))) add('language', '语言应为有效语言标记或留空。');
  }
  if (!Array.isArray(edit.lines)) { add('lines', '歌词行必须是列表。'); return issues; }
  if (edit.kind === 'missing' && edit.lines.length) add('missingNotEmpty', '清空歌词时行列表必须为空。');
  const ids = new Set<string>();
  let previous: number | null = null;
  for (const line of edit.lines) {
    if (!line || typeof line !== 'object') { add('lines', '歌词行格式无效。'); continue; }
    if (typeof line.id !== 'string' || !line.id.trim()) add('lineId', '每行需要唯一编号。');
    else if (ids.has(line.id)) add('duplicateId', '行编号重复。', line.id);
    ids.add(line.id);
    if (typeof line.original !== 'string' || (line.translation !== undefined && typeof line.translation !== 'string')) {
      add('text', '原文和译文必须是文本。', line.id); continue;
    }
    if (!line.original.trim() && line.translation?.trim()) add('orphanTranslation', '空白原文不能单独带有译文。', line.id);
    if (edit.kind === 'plain' && line.startMs !== null) add('plainTimestamp', '普通文本的时间必须为空。', line.id);
    if (edit.kind === 'synced') {
      if (line.startMs === null || !Number.isSafeInteger(line.startMs) || !Number.isSafeInteger(line.startMs + edit.offsetMs)) {
        add('timestamp', '同步行需要有效的整数毫秒时间。', line.id); continue;
      }
      if (previous !== null && line.startMs < previous) add('order', '歌词时间必须升序排列。', line.id);
      if (previous !== null && line.startMs === previous) add('duplicateTimestamp', '同一时间的内容请合并为一个原文/译文组。', line.id);
      previous = line.startMs;
    }
  }
  if (edit.kind !== 'missing' && !edit.lines.some(line => typeof line?.original === 'string' && line.original.trim())) {
    add('lines', '没有正文时请选择清空歌词。');
  }
  return issues;
}

/** Throws for invalid edits or ambiguous multiline bilingual LRC; no side effects. */
export function serializeLyrics(edit: LyricsEdit, options: LyricsSerializeOptions = {}): string {
  const issues = validateLyricsEdit(edit);
  if (issues.length) throw new Error(issues[0].message);
  if (edit.kind === 'missing') return '';
  const includeTranslation = options.includeTranslation ?? true;
  if (edit.kind === 'plain') return edit.lines.flatMap(line =>
    includeTranslation && line.translation ? [line.original, line.translation] : [line.original]).join('\n');
  if (includeTranslation && edit.lines.some(line => line.original.includes('\n') && line.translation?.trim())) {
    throw new Error('多行原文加译文无法无歧义写入双语 LRC，请选择仅原文导出。');
  }
  const effective = edit.lines.map(line => line.startMs! + edit.offsetMs);
  const shift = Math.max(0, -Math.min(...effective));
  const output: string[] = shift ? ['[offset:+' + shift + ']'] : [];
  if (edit.language) output.push('[lang:' + edit.language + ']');
  edit.lines.forEach((line, index) => {
    const ms = effective[index] + shift;
    if (!Number.isSafeInteger(ms)) throw new Error('导出时间超出有效范围。');
    const tag = '[' + String(Math.floor(ms / 60000)).padStart(2, '0') + ':' +
      String(Math.floor(ms / 1000) % 60).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0') + ']';
    for (const row of line.original.split('\n')) output.push(tag + row);
    if (includeTranslation && line.translation) for (const row of line.translation.split('\n')) output.push(tag + row);
  });
  return output.join('\n');
}

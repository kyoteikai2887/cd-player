import type { LyricsKind, TranslationStatus, VersionKind } from '../../contracts/player.ts';

const KANA = /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]/;

/**
 * Display-only language hint for the `lang` attribute (glyph shaping and fonts).
 * Trusted metadata first, then obvious kana, then the album's language; otherwise undefined.
 * Never written back to data.
 */
export function langHint(text: string | null | undefined, metadata?: string | null, inherited?: string | null): string | undefined {
  if (metadata) return metadata;
  if (text && KANA.test(text)) return 'ja';
  return inherited ?? undefined;
}

/** NFKC + lower case + katakana folded to hiragana, so 'ソラ', 'そら', 'ｿﾗ' match each other. */
export function normalizeForSearch(value: string): string {
  const nfkc = value.normalize('NFKC').toLocaleLowerCase();
  let out = '';
  for (const char of nfkc) {
    const code = char.codePointAt(0)!;
    out += code >= 0x30A1 && code <= 0x30F6 ? String.fromCodePoint(code - 0x60) : char;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function matchesQuery(haystack: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const target = normalizeForSearch(haystack);
  return normalizedQuery.split(' ').every(part => target.includes(part));
}

export const VERSION_LABEL: Record<VersionKind, string> = {
  full: 'Full', short: 'Short', live: 'Live', instrumental: 'Instrumental',
  offVocal: 'Off vocal', remix: 'Remix', other: '其他版本',
};

/** Prefer the verbatim label; fall back to a short name for the kind. 'full' alone needs no badge. */
export function versionBadge(kind: VersionKind | null, label: string | null): string | null {
  if (label && label.trim()) return label.trim();
  if (!kind || kind === 'full') return null;
  return VERSION_LABEL[kind];
}

export interface LyricsStatusInfo { label: string; tone: 'rich' | 'plain' | 'quiet' | 'none' }

/** One-line description of a track's lyrics state for the track list. */
export function lyricsStatus(kind: LyricsKind | undefined, translation: TranslationStatus | undefined): LyricsStatusInfo {
  switch (kind) {
    case 'synced':
      if (translation === 'available') return { label: '同步歌词，含中文翻译', tone: 'rich' };
      if (translation === 'partial') return { label: '同步歌词，部分翻译', tone: 'rich' };
      return { label: '同步歌词，仅原文', tone: 'rich' };
    case 'plain': return { label: translation && translation !== 'missing' ? '未同步歌词，含翻译' : '未同步歌词', tone: 'plain' };
    case 'instrumental': return { label: '纯音乐', tone: 'quiet' };
    case 'spoken': return { label: '念白', tone: 'quiet' };
    default: return { label: '暂无歌词', tone: 'none' };
  }
}

/** Count with a Chinese measure word: (3, '首') → '3 首'. */
export const count = (n: number, unit: string) => `${n} ${unit}`;

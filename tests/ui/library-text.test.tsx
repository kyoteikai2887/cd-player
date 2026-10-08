import { describe, expect, test } from 'vitest';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { groupByArtist, groupByDisc, groupByWork, indexLibrary, searchLibrary, sortAlbums } from '../../src/ui/lib/library.ts';
import { langHint, lyricsStatus, normalizeForSearch, versionBadge } from '../../src/ui/lib/text.ts';

describe('display-only language hints (never written back)', () => {
  test('metadata wins, then kana, then the album language; kanji alone is not guessed', () => {
    expect(langHint('窓辺の青', 'ja', null)).toBe('ja');
    expect(langHint('窓辺の青', null, null)).toBe('ja');
    expect(langHint('星海航路', null, null)).toBeUndefined();
    expect(langHint('星海航路', null, 'ja')).toBe('ja');
    expect(langHint('蓝色天空', 'zh-Hans', 'ja')).toBe('zh-Hans');
  });
});

describe('search normalisation', () => {
  test('NFKC, case and katakana/hiragana folding', () => {
    expect(normalizeForSearch('ソーダ')).toBe(normalizeForSearch('そーだ'));
    expect(normalizeForSearch('ｿｰﾀﾞ')).toBe(normalizeForSearch('ソーダ'));
    expect(normalizeForSearch('ＤＥＭＯ-001')).toBe('demo-001');
  });
  test('finds CV names, catalog numbers and track titles', () => {
    const { library } = createDemoData();
    const index = indexLibrary(library);
    expect(searchLibrary(library, index, '水城').albums.map(a => a.id)).toContain('album-spring');
    expect(searchLibrary(library, index, 'demo-2077').albums.map(a => a.id)).toEqual(['album-starsea']);
    expect(searchLibrary(library, index, 'そーだ').tracks.length).toBeGreaterThan(0);
    expect(searchLibrary(library, index, 'まぼろし')).toEqual({ albums: [], tracks: [] });
  });
});

describe('grouping keeps authoritative order', () => {
  test('discs follow trackIds and carry disc titles', () => {
    const { library } = createDemoData();
    const index = indexLibrary(library);
    const sea = index.albumsById.get('album-starsea')!;
    const discs = groupByDisc(sea, index);
    expect(discs.map(d => [d.number, d.title, d.tracks.length])).toEqual([[1, '航海編', 3], [2, '帰港編', 2]]);
  });
  test('works use the saved workTitle only; albums without one go last', () => {
    const { library } = createDemoData();
    const groups = groupByWork(library.albums);
    expect(groups[groups.length - 1].title).toBeNull();
    const soda = groups.find(g => g.title === '放課後ソーダ部')!;
    expect(soda.albums.map(a => a.id).sort()).toEqual(['album-soda', 'album-spring']);
  });
  test('artists group by structured names; an album can appear under several', () => {
    const { library } = createDemoData();
    const groups = groupByArtist(library.albums);
    const yui = groups.find(g => g.title === '月野ユイ')!;
    expect(yui.albums.map(a => a.id)).toContain('album-radio');
  });
  test('sorting by recently added is stable and newest first', () => {
    const { library } = createDemoData();
    const sorted = sortAlbums(library.albums, 'added');
    for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1].addedAt).toBeGreaterThanOrEqual(sorted[i].addedAt);
  });
});

describe('labels', () => {
  test('verbatim version labels win; Full needs no badge', () => {
    expect(versionBadge('short', 'TV size')).toBe('TV size');
    expect(versionBadge('full', null)).toBeNull();
    expect(versionBadge('offVocal', null)).toBe('Off vocal');
  });
  test('lyrics status separates missing from instrumental and spoken', () => {
    expect(lyricsStatus('missing', 'missing').tone).toBe('none');
    expect(lyricsStatus('instrumental', 'missing').label).toBe('纯音乐');
    expect(lyricsStatus('spoken', 'missing').label).toBe('念白');
    expect(lyricsStatus('synced', 'partial').label).toBe('同步歌词，部分翻译');
  });
});

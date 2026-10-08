/**
 * Lyric candidates (Claude, R2.3; contract 0.4.0 lyricsReview), against the DemoBridge.
 * A broad search the user asked for: previews until they choose; adoption is three ids and a
 * destination; refusals keep everything and ask for a new search; the snapshot closes the sheet.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionResult, PlayerBridge, Track, UIAction } from '../../src/contracts/player.ts';
import { parseLyrics } from '../../src/core/lyrics.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import type { MockOptions } from '../../src/mock/createMockBridge.ts';
import type { LyricSearchRecord } from '../../src/local/online/candidates.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import type { UIBoot } from '../../src/ui/lib/env.ts';
import { adoptPath, deltaLong, deltaShort, sharedWarnings, textDiff } from '../../src/ui/lib/lyricsReview.ts';
import { applyImport, draftFromDocument } from '../../src/ui/lib/lyricsDraft.ts';

afterEach(cleanup);

function Live({ bridge, log, boot, intercept }: {
  bridge: PlayerBridge; log: UIAction[]; boot: UIBoot; intercept?: (action: UIAction) => ActionResult | null;
}) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const onAction = useCallback((action: UIAction): Promise<ActionResult> => {
    log.push(action);
    const answer = intercept?.(action);
    return answer ? Promise.resolve(answer) : bridge.dispatch(action);
  }, [bridge, log, intercept]);
  return (
    <UIBootContext.Provider value={boot}>
      <PlayerUI snapshot={snapshot} surface="main" onAction={onAction} />
    </UIBootContext.Provider>
  );
}

const nowPlaying: UIBoot = { route: { name: 'nowPlaying' }, nowPlayingTab: 'lyrics' };
function setup({ options = {}, boot = nowPlaying, intercept }: {
  options?: MockOptions; boot?: UIBoot; intercept?: (action: UIAction) => ActionResult | null;
} = {}) {
  const session = createMockSession({ autoTick: false, taskDelayMs: 0, scenario: 'missing', ...options });
  const bridge = session.connect('main'), elsewhere = session.connect('mini');
  const log: UIAction[] = [];
  render(<Live bridge={bridge} log={log} boot={boot} intercept={intercept} />);
  const core = async (action: UIAction) => { let result!: ActionResult; await act(async () => { result = await elsewhere.dispatch(action); }); return result; };
  const snap = () => bridge.getSnapshot();
  const sent = <T extends UIAction['type']>(type: T) => log.filter((a): a is Extract<UIAction, { type: T }> => a.type === type);
  return { session, core, snap, log, sent };
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const sheet = () => screen.findByRole('dialog', { name: '歌词候选' });
const radios = (dialog: HTMLElement) => within(dialog).getAllByRole('radio');
/** Opens the lyrics menu and asks for candidates. */
async function openFromMenu() {
  fireEvent.click(screen.getByRole('button', { name: '歌词操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '搜索歌词候选…' }));
  return sheet();
}

/** Records for one track: the full version, a TV Size, a plain one without a duration. */
const records = (track: Track, extra: Partial<LyricSearchRecord>[] = []): LyricSearchRecord[] => [
  { provider: '虚构歌词库', recordId: 'full', title: track.title, artistCredit: track.artistCredit, albumTitle: '白い軌道 — Character Songs',
    durationMs: track.durationMs + 1000, document: parseLyrics('[00:00]最初の一行\n[00:10]二行目の言葉\n[00:20]三行目の景色', track.id) },
  { provider: '虚构歌词库', recordId: 'tv', title: track.title + ' (TV Size)', artistCredit: track.artistCredit, albumTitle: 'TV Edition',
    durationMs: 89000, document: parseLyrics('[00:00]短い版の一行\n[00:06]短い版の二行目', track.id) },
  { provider: '虚构歌词库', recordId: 'plain', title: track.title, artistCredit: track.artistCredit + ', 星野レナ', albumTitle: '白い軌道 — Character Songs',
    durationMs: null, document: parseLyrics('時間のない一行\n時間のない二行目', track.id) },
  ...extra.map((r, i) => ({ ...records(track)[0], recordId: 'extra-' + i, ...r })),
];

describe('lyric candidates', () => {
  test('additional sources and a partial-service warning use the existing selection UI without saving', async () => {
    const warning = 'QQ 音乐的部分查询未完成；其他可用候选仍可预览。';
    const { session, snap, sent } = setup({ options: { searchLyrics: async track => ['LRCLIB', 'QQ 音乐', '网易云音乐', '酷狗音乐'].map((provider, i) => ({
      ...records(track)[0], provider, recordId: String(i), warnings: [warning],
    })) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(4));
      for (const provider of ['LRCLIB', 'QQ 音乐', '网易云音乐', '酷狗音乐']) expect(dialog.textContent).toContain(provider);
      expect(dialog.textContent).toContain(warning);
      fireEvent.click(radios(dialog)[2]);
      expect((within(dialog).getByRole('button', { name: '使用这份歌词' }) as HTMLButtonElement).disabled).toBe(false);
      expect(snap().lyrics?.kind).toBe('missing'); expect(sent('applyLyricsCandidate')).toHaveLength(0);
    } finally { session.destroy(); }
  });
  test('IME confirmation cannot submit or close the review; a later deliberate submit still works', async () => {
    const { session, sent } = setup({ options: { searchLyrics: async track => records(track) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      const input = within(dialog).getByRole('textbox', { name: '曲名' });
      const form = within(dialog).getByRole('search', { name: '搜索歌词候选' });
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: '日本語の曲名' } });
      fireEvent.submit(form);
      fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
      await settle();
      expect(sent('searchLyricsCandidates')).toHaveLength(1);
      expect(screen.getByRole('dialog', { name: '歌词候选' })).toBe(dialog);
      fireEvent.compositionEnd(input, { data: '日本語の曲名' });
      expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false);
      fireEvent.submit(form);
      await settle();
      expect(sent('searchLyricsCandidates')).toHaveLength(2);
      expect(sent('searchLyricsCandidates').at(-1)?.query?.title).toBe('日本語の曲名');
    } finally { session.destroy(); }
  });

  test('a strict lookup that finds nothing offers other versions; searching keeps the page as it was', async () => {
    let release!: (value: LyricSearchRecord[]) => void;
    const { session, sent, snap } = setup({ options: {
      lookup: async () => null,
      searchLyrics: track => new Promise(resolve => { release = () => resolve(records(track)); }),
    } });
    try {
      fireEvent.click(await screen.findByRole('button', { name: /查找歌词/ }));
      const other = await screen.findByRole('button', { name: /搜索其他版本/ });
      expect(other.className).toContain('cdp-btn--primary');
      fireEvent.click(other);
      const dialog = await sheet();
      await waitFor(() => expect(within(dialog).getByRole('status').textContent).toContain('正在搜索歌词候选'));
      // The search terms are what the core searched; changing them would not touch the track.
      expect((within(dialog).getByRole('textbox', { name: /曲名/ }) as HTMLInputElement).value).toBe('次のページへ');
      expect((within(dialog).getByRole('textbox', { name: /歌手/ }) as HTMLInputElement).value).toBe('月野ユイ');
      expect(dialog.textContent).toContain('不会改动曲目资料');
      expect(sent('searchLyricsCandidates')).toEqual([{ type: 'searchLyricsCandidates', trackId: 'track-missing' }]);
      expect(snap().lyrics?.kind).toBe('missing');                                 // nothing written while searching
      await act(async () => { release([]); await new Promise(r => setTimeout(r, 0)); });
    } finally { session.destroy(); }
  });

  test('candidates show kind, source, credit, album, duration and the core warnings as they are', async () => {
    const { session } = setup({ options: { searchLyrics: async track => records(track) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      const [first, tv, plain] = radios(dialog);
      expect(first.getAttribute('aria-checked')).toBe('true');
      expect(first.textContent).toContain('同步');
      expect(first.textContent).toContain('时长接近');                         // objective only
      expect(first.textContent).toContain('+1.0 秒');
      expect(tv.textContent).toContain('请核对');
      expect(tv.querySelector('mark')?.textContent).toBe('(TV Size)');         // the version mark is visible
      expect(tv.textContent).toContain('其他专辑');
      expect(plain.textContent).toContain('纯文本');
      expect(plain.textContent).toContain('署名不同');
      expect(plain.textContent).toContain('时长未知');
      expect(dialog.textContent).not.toMatch(/\d+\s*%|可信|已验证|自动验证/);   // no scores, no "verified"
      fireEvent.click(tv);
      const notes = within(dialog).getByRole('list', { name: '来源提示' });
      for (const w of ['曲名不同，请核对版本。', '来自其他专辑。', '时长相差超过 2 秒，请核对时间轴。', '版本标记不同，请先预览。']) expect(notes.textContent).toContain(w);
      expect(dialog.textContent).toContain('比本曲短 51.0 秒');
    } finally { session.destroy(); }
  });

  test('search terms: edited ones are sent, unchanged ones leave the core its own; the title is required', async () => {
    const { session, sent } = setup({ options: { searchLyrics: async track => records(track) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      const search = within(dialog).getByRole('button', { name: /^搜索$/ });
      fireEvent.click(search);
      await settle();
      expect(sent('searchLyricsCandidates').at(-1)).toEqual({ type: 'searchLyricsCandidates', trackId: 'track-missing' });
      const title = within(dialog).getByRole('textbox', { name: /曲名/ }), artist = within(dialog).getByRole('textbox', { name: /歌手/ });
      fireEvent.change(title, { target: { value: '  ' } });
      fireEvent.click(search);
      expect(sent('searchLyricsCandidates')).toHaveLength(2);
      expect(dialog.textContent).toContain('请填写曲名');
      fireEvent.change(title, { target: { value: '次のページへ (Full)' } });
      fireEvent.change(artist, { target: { value: '' } });
      fireEvent.click(search);
      await settle();
      expect(sent('searchLyricsCandidates').at(-1)).toEqual({ type: 'searchLyricsCandidates', trackId: 'track-missing',
        query: { title: '次のページへ (Full)', artist: '' } });
    } finally { session.destroy(); }
  });

  test('no results and a failed search are shown in place; the lyrics stay as they were', async () => {
    let mode: 'none' | 'fail' = 'none';
    const { session, sent, snap } = setup({ options: { searchLyrics: async () => { if (mode === 'fail') throw new Error('offline'); return []; } } });
    try {
      const dialog = await openFromMenu();
      expect(await within(dialog).findByText('没有找到候选')).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: /使用这份歌词/ })).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: /只按曲名搜索/ }));
      await settle();
      expect(sent('searchLyricsCandidates').at(-1)).toEqual({ type: 'searchLyricsCandidates', trackId: 'track-missing', query: { title: '次のページへ', artist: '' } });
      mode = 'fail';
      fireEvent.click(within(dialog).getByRole('button', { name: /^搜索$/ }));
      expect(await within(dialog).findByText('搜索没有完成')).toBeTruthy();
      expect(dialog.textContent).toContain('不代表没有这首的歌词');
      expect(within(dialog).getByRole('button', { name: /重试/ })).toBeTruthy();
      expect(snap().lyrics?.kind).toBe('missing');
      expect(snap().notices.filter(n => n.id !== 'demo')).toEqual([]);              // no Notice on top of it
    } finally { session.destroy(); }
  });

  test('closing sends closeLyricsReview; a result that arrives later does not bring it back', async () => {
    let release!: () => void;
    const { session, sent, snap } = setup({ options: {
      searchLyrics: track => new Promise(resolve => { release = () => resolve(records(track)); }),
    } });
    try {
      const dialog = await openFromMenu();
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
      expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull();
      await settle();
      expect(sent('closeLyricsReview')).toHaveLength(1);
      await act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
      expect(snap().lyricsReview).toBeNull();
      expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull();
      expect(sent('applyLyricsCandidate')).toEqual([]);
    } finally { session.destroy(); }
  });

  test('at most twelve candidates, chosen with the arrow keys', async () => {
    const { session } = setup({ options: { searchLyrics: async track => records(track, Array.from({ length: 11 }, (_, i) => ({ durationMs: track.durationMs + i * 100 }))) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(12));
      expect(dialog.textContent).toContain('12 份候选');
      const list = within(dialog).getByRole('radiogroup', { name: '歌词候选' });
      radios(dialog)[0].focus();
      fireEvent.keyDown(radios(dialog)[0], { key: 'ArrowDown' });
      expect(radios(dialog)[1].getAttribute('aria-checked')).toBe('true');
      expect(document.activeElement).toBe(radios(dialog)[1]);                      // focus moves with the choice
      fireEvent.keyDown(list, { key: 'End' });
      expect(radios(dialog)[11].getAttribute('aria-checked')).toBe('true');
      expect(radios(dialog).filter(r => r.tabIndex === 0)).toHaveLength(1);       // one stop in the tab order
    } finally { session.destroy(); }
  });

  test('a synced candidate follows the playing track by the shared clock; the page keeps its own lyrics', async () => {
    const { session, core, snap } = setup({ options: { searchLyrics: async track => records(track) } });
    try {
      await core({ type: 'seek', positionMs: 12000 });
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      const follow = within(dialog).getByRole('button', { name: /跟随播放/ });
      expect(follow.getAttribute('aria-pressed')).toBe('true');
      const lines = within(dialog).getByRole('region', { name: '候选歌词（跟随播放）' });
      await waitFor(() => expect(lines.querySelector('[aria-current="true"]')?.textContent).toContain('二行目の言葉'));
      expect(lines.textContent).toContain('0:10');
      fireEvent.click(follow);
      expect(within(dialog).getByRole('region', { name: '候选歌词' }).querySelector('[aria-current]')).toBeNull();
      expect(snap().lyrics?.kind).toBe('missing');                                 // preview only
      expect(snap().lyrics?.offsetMs).toBe(0);
      fireEvent.click(radios(dialog)[2]);
      const plain = within(dialog).getByRole('region', { name: '候选歌词' });
      expect(dialog.textContent).toContain('没有时间，不会跟随播放');
      expect(plain.textContent).toContain('時間のない一行');
      expect(plain.textContent).not.toMatch(/\d:\d\d/);
      expect(within(dialog).queryByRole('button', { name: /跟随播放/ })).toBeNull();
    } finally { session.destroy(); }
  });

  test('missing lyrics are filled from the chosen candidate; the snapshot closes the sheet', async () => {
    const { session, sent, snap } = setup({ options: { searchLyrics: async track => records(track) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      const review = snap().lyricsReview!;
      expect(dialog.textContent).toContain('保留你设的偏移');
      fireEvent.click(within(dialog).getByRole('button', { name: /使用这份歌词/ }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull());
      expect(sent('applyLyricsCandidate')).toEqual([{ type: 'applyLyricsCandidate', trackId: 'track-missing', reviewId: review.id,
        candidateId: review.candidates[0].id, destination: 'document' }]);
      expect(snap().lyrics?.kind).toBe('synced');
      expect(await screen.findByText('二行目の言葉')).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('existing lyrics go only through the editor draft, which nothing saves until the user does', async () => {
    const { session, sent, snap } = setup({ options: { scenario: 'plain', searchLyrics: async track => records(track) } });
    try {
      const before = snap().lyrics!;
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      expect(dialog.textContent).toContain('会先打开编辑器');
      expect(within(dialog).queryByRole('button', { name: /使用这份歌词/ })).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: /在编辑器中导入/ }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull());
      expect(sent('openLyricsEditor')).toHaveLength(1);
      expect(sent('applyLyricsCandidate').map(a => a.destination)).toEqual(['editorDraft']);
      expect(await screen.findByText(/已导入原文：3 行/)).toBeTruthy();
      expect(await screen.findByText('有未保存的修改')).toBeTruthy();
      expect(sent('saveLyrics')).toEqual([]);
      expect(snap().lyrics?.revision).toBe(before.revision);                       // the saved lyrics are untouched
    } finally { session.destroy(); }
  });

  test('from the editor: cancel keeps the draft; Ctrl+S and arrows in the sheet do not reach the editor', async () => {
    const { session, sent } = setup({ options: { scenario: 'plain', searchLyrics: async track => records(track) } });
    try {
      fireEvent.click(screen.getByRole('button', { name: '歌词操作' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: '编辑歌词' }));
      const add = await screen.findByRole('button', { name: /添加一行/ });
      fireEvent.click(add);
      await settle();
      expect(await screen.findByText('有未保存的修改')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '导入' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: '从在线候选导入…' }));
      const dialog = await sheet();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      expect(within(dialog).getByRole('button', { name: /导入到编辑草稿/ })).toBeTruthy();
      fireEvent.keyDown(within(dialog).getByRole('radiogroup'), { key: 'ArrowDown' });
      expect(radios(dialog)[1].getAttribute('aria-checked')).toBe('true');
      fireEvent.keyDown(dialog, { key: 's', ctrlKey: true });
      await settle();
      expect(sent('saveLyrics')).toEqual([]);
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull();
      await settle();
      expect(sent('closeLyricsReview')).toHaveLength(1);
      expect(sent('applyLyricsCandidate')).toEqual([]);
      expect(screen.getByText('有未保存的修改')).toBeTruthy();                      // the draft is still there
      expect(screen.getByRole('button', { name: /添加一行/ })).toBeTruthy();         // and so is the editor
    } finally { session.destroy(); }
  });

  test('adopting into an already dirty editor replaces only draft original and can be undone without saving', async () => {
    const { session, sent, snap } = setup({ options: { scenario: 'plain', searchLyrics: async track => records(track) } });
    try {
      const saved = snap().lyrics!;
      fireEvent.click(screen.getByRole('button', { name: '歌词操作' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: '编辑歌词' }));
      fireEvent.click(await screen.findByRole('button', { name: /添加一行/ }));
      const beforeRows = document.querySelectorAll('[data-line-id]').length;
      expect(await screen.findByText('有未保存的修改')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '导入' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: '从在线候选导入…' }));
      const dialog = await sheet();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      fireEvent.click(within(dialog).getByRole('button', { name: /导入到编辑草稿/ }));
      expect(await screen.findByText(/已导入原文：3 行/)).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull();
      expect(document.querySelectorAll('[data-line-id]')).toHaveLength(3);
      expect(sent('applyLyricsCandidate').at(-1)?.destination).toBe('editorDraft');
      expect(sent('saveLyrics')).toHaveLength(0);
      expect(snap().lyrics).toEqual(saved);
      expect(screen.getByText('有未保存的修改')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '撤销' }));
      expect(document.querySelectorAll('[data-line-id]')).toHaveLength(beforeRows);
      expect(snap().lyrics).toEqual(saved);
    } finally { session.destroy(); }
  });

  test('a conflict keeps everything and asks for a new search; the old candidates are not retried', async () => {
    const { session, core, sent, snap } = setup({ options: { searchLyrics: async track => records(track) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      const lyrics = snap().lyrics!;
      await core({ type: 'setLyricsOffset', trackId: 'track-missing', baseRevision: lyrics.revision, offsetMs: 300 });   // changed elsewhere
      fireEvent.click(within(dialog).getByRole('button', { name: /使用这份歌词/ }));
      expect(await within(dialog).findByText(/这些候选已经过期/)).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: /使用这份歌词/ })).toBeNull();
      expect(sent('applyLyricsCandidate')).toHaveLength(1);
      expect(snap().lyrics?.kind).toBe('missing');
      fireEvent.click(within(dialog).getByRole('button', { name: /重新搜索/ }));
      await waitFor(() => expect(sent('searchLyricsCandidates')).toHaveLength(2));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: /使用这份歌词/ })).toBeTruthy());
      expect(sent('applyLyricsCandidate')).toHaveLength(1);
    } finally { session.destroy(); }
  });

  test('locked lyrics: no search from the menu, and a locked refusal says how to unlock', async () => {
    const first = setup({ options: { scenario: 'locked' } });
    try {
      fireEvent.click(screen.getByRole('button', { name: '歌词操作' }));
      const item = await screen.findByRole('menuitem', { name: '搜索歌词候选…' }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      expect(item.title).toContain('解锁并保存');
    } finally { first.session.destroy(); cleanup(); }
    const intercept = (action: UIAction): ActionResult | null => action.type === 'applyLyricsCandidate'
      ? { ok: false, code: 'locked', message: '歌词已锁定。' } : null;
    const { session } = setup({ intercept, options: { searchLyrics: async track => records(track) } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      fireEvent.click(within(dialog).getByRole('button', { name: /使用这份歌词/ }));
      expect(await within(dialog).findByText(/在编辑器里解锁并保存/)).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: /打开编辑器/ })).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: /重新搜索|使用这份歌词/ })).toBeNull();   // a new search would be refused too
    } finally { session.destroy(); }
  });

  test('the sheet follows the snapshot when the review is consumed elsewhere or the track is removed', async () => {
    const { session, core } = setup({ options: { searchLyrics: async track => records(track) } });
    try {
      let dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      await core({ type: 'closeLyricsReview' });                                   // another window closed it
      expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull();
      dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(3));
      const library = session.connect('main').getSnapshot().library;
      await core({ type: 'removeAlbum', albumId: 'album-white', baseLibraryRevision: library.revision });
      expect(screen.queryByRole('dialog', { name: '歌词候选' })).toBeNull();
    } finally { session.destroy(); }
  });
});

/** A synced record that came with a translation for some lines (paired by time in the core). */
function withTranslation(track: Track, provider: string, recordId: string, translations: (string | null)[], warnings: string[] = []): LyricSearchRecord {
  const document = parseLyrics('[00:00]最初の一行\n[00:10]二行目の言葉\n[00:20]三行目の景色', track.id,
    { source: { kind: 'provider', name: provider, recordId } });
  document.lines = document.lines.map((line, i) => translations[i] ? { ...line, translation: translations[i]! } : line);
  return { provider, recordId, title: track.title, artistCredit: track.artistCredit, albumTitle: '白い軌道 — Character Songs',
    durationMs: track.durationMs, document, warnings };
}

describe('candidate translations (core.19 sources)', () => {
  test('a translation a source sent can be shown under the original; there is no switch without one', async () => {
    const { session, snap } = setup({ options: { searchLyrics: async track => [
      withTranslation(track, '网易云音乐', 'a', ['第一行', '第二行的话', null]),
      { ...records(track)[0], provider: 'LRCLIB', recordId: 'b', durationMs: track.durationMs + 600 },
    ] } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(2));
      const [first, second] = radios(dialog);
      expect(first.textContent).toContain('带译文');
      expect(second.textContent).not.toContain('带译文');
      expect(dialog.textContent).toContain('译文 2 行');
      expect(dialog.textContent).toContain('附带的译文');                           // what adopting brings along
      const view = within(dialog).getByRole('group', { name: '候选的显示方式' });
      const [original, both] = within(view).getAllByRole('button');
      expect(original.getAttribute('aria-pressed')).toBe('true');                  // original first
      expect(dialog.textContent).not.toContain('第二行的话');
      fireEvent.click(both);
      expect(within(dialog).getByRole('region', { name: /候选歌词/ }).textContent).toContain('第二行的话');
      expect(within(dialog).getByRole('region', { name: /候选歌词/ }).querySelectorAll('[class*="translation"]')).toHaveLength(2);   // only what was sent
      fireEvent.click(second);
      expect(within(dialog).queryByRole('group', { name: '候选的显示方式' })).toBeNull();
      expect(dialog.textContent).not.toContain('第二行的话');
      fireEvent.click(first);                                                       // the choice is kept while browsing
      expect(within(dialog).getByRole('region', { name: /候选歌词/ }).textContent).toContain('第二行的话');
      expect(snap().lyrics?.kind).toBe('missing');
    } finally { session.destroy(); }
  });

  test('a note every candidate carries is said once above the list; notes about one candidate stay with it', async () => {
    const shared = 'QQ 音乐的部分查询未完成；其他可用候选仍可预览。';
    const { session } = setup({ options: { searchLyrics: async track => [
      withTranslation(track, '网易云音乐', 'a', [null, null, null], [shared]),
      { ...withTranslation(track, '酷狗音乐', 'b', [null, null, null], [shared]), artistCredit: '別の歌手' },
    ] } });
    try {
      const dialog = await openFromMenu();
      await waitFor(() => expect(radios(dialog)).toHaveLength(2));
      expect(dialog.textContent!.split(shared)).toHaveLength(2);                    // exactly once
      expect(within(dialog).getByRole('list', { name: '每份候选都有的提示' }).textContent).toContain(shared);
      fireEvent.click(radios(dialog)[1]);
      expect(within(dialog).getByRole('list', { name: '来源提示' }).textContent).toContain('歌手署名不同');
      expect(dialog.textContent!.split(shared)).toHaveLength(2);
    } finally { session.destroy(); }
  });

  test('importing a translated candidate into the draft shows its translation at once, unsaved', async () => {
    const { session, sent } = setup({ options: { scenario: 'plain', searchLyrics: async track => [withTranslation(track, '网易云音乐', 'a', ['第一行', '第二行的话', '第三行'])] } });
    try {
      fireEvent.click(screen.getByRole('button', { name: '歌词操作' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: '编辑歌词' }));
      const column = await screen.findByRole('button', { name: '译文列' });
      expect(column.getAttribute('aria-pressed')).toBe('false');                    // plain text, no translation yet
      fireEvent.click(screen.getByRole('button', { name: '导入' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: '从在线候选导入…' }));
      const dialog = await sheet();
      await waitFor(() => expect(radios(dialog)).toHaveLength(1));
      fireEvent.click(within(dialog).getByRole('button', { name: /导入到编辑草稿/ }));
      expect(await screen.findByText(/已导入原文：3 行，其中 3 行带译文。/)).toBeTruthy();
      expect(screen.getByRole('button', { name: '译文列' }).getAttribute('aria-pressed')).toBe('true');
      const fields = [...document.querySelectorAll('textarea')].map(t => t.value);
      expect(fields).toContain('第二行的话');                                         // in the translation column of the draft
      expect(sent('saveLyrics')).toEqual([]);
      expect(screen.getByText('有未保存的修改')).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('a failure message that already says it is not a missing song is not repeated', async () => {
    const { session } = setup({ intercept: undefined, options: { searchLyrics: async () => { throw new Error('x'); } } });
    try {
      const dialog = await openFromMenu();
      expect(await within(dialog).findByText('搜索没有完成')).toBeTruthy();
      expect(dialog.textContent!.split('不代表')).toHaveLength(2);
    } finally { session.destroy(); }
  });
});

describe('lyric candidate helpers', () => {
  test('importing an original reports where the translations in the result came from', () => {
    const old = { ...parseLyrics('[00:00]旧い一行\n[00:10]旧い二行目', 't'), kind: 'synced' as const };
    old.lines = old.lines.map((l, i) => ({ ...l, translation: i === 0 ? '原有译文' : '' }));
    const draft = draftFromDocument(old);
    const lines = parseLyrics('[00:00]新しい一行\n[00:10]新しい二行目\n[00:20]三行目', 't').lines
      .map((l, i) => i === 0 ? { ...l, translation: '导入译文一' } : i === 1 ? { ...l, translation: '导入译文二' } : l);
    const outcome = applyImport(draft, { id: 'p', content: 'original', kind: 'synced', lines, language: 'ja', warnings: [] });
    expect(outcome.draft.lines.map(l => l.translation)).toEqual(['原有译文', '导入译文二', '']);   // the rule is unchanged
    expect(outcome.message).toBe('已导入原文：3 行，其中 2 行带译文（导入的 1 行，原有的 1 行）。');
    expect(outcome.warnings.join(' ')).toContain('有 1 行导入时也带着译文，按规则保留了草稿里原有的译文。');
    const plain = applyImport(draftFromDocument({ ...parseLyrics('', 't'), kind: 'missing' }),
      { id: 'q', content: 'original', kind: 'synced', lines: lines.map(l => ({ ...l, translation: undefined })), language: 'ja', warnings: [] });
    expect(plain.message).toBe('已导入原文：3 行。');                                // no translation, same words as before
  });
  test('a kept translation that reads the same as the imported one is still counted as the draft’s', () => {
    const old = { ...parseLyrics('[00:00]旧い一行\n[00:10]旧い二行目\n[00:25]離れた行', 't'), kind: 'synced' as const };
    old.lines = old.lines.map((l, i) => ({ ...l, translation: i === 0 ? '同一句译文' : i === 2 ? '时间对不上' : '' }));
    const draft = draftFromDocument(old);
    const lines = parseLyrics('[00:00]新しい一行\n[00:10]新しい二行目\n[00:20]三行目', 't').lines
      .map((l, i) => ({ ...l, translation: ['同一句译文', '只有导入有', '时间对不上'][i] }));
    const outcome = applyImport(draft, { id: 'p', content: 'original', kind: 'synced', lines, language: 'ja', warnings: [] });
    // The data follow the rule as before: a time-matched old translation wins, otherwise the import's.
    expect(outcome.draft.lines.map(l => l.translation)).toEqual(['同一句译文', '只有导入有', '时间对不上']);
    // Line 1 is the draft's (paired by time), even though its text equals the import's; line 3 has the
    // same words as an old translation but no time match, so it is the import's.
    expect(outcome.message).toBe('已导入原文：3 行，其中 3 行带译文（导入的 2 行，原有的 1 行）。');
    expect(outcome.warnings.join(' ')).not.toContain('按规则保留了草稿里原有的译文');   // nothing was set aside
    expect(outcome.warnings.join(' ')).toContain('原有译文：1 行译文无法安全配对');
    const allSame = applyImport(draft, { id: 'q', content: 'original', kind: 'synced',
      lines: lines.slice(0, 1), language: 'ja', warnings: [] });
    expect(allSame.message).toBe('已导入原文：1 行，其中 1 行带译文（都是草稿里原有的译文）。');
  });
  test('notes shared by every candidate are lifted only when there are two or more', () => {
    const c = (warnings: string[]) => ({ warnings }) as unknown as Parameters<typeof sharedWarnings>[0][number];
    expect(sharedWarnings([c(['a', 'b']), c(['b', 'a', 'c'])])).toEqual(['a', 'b']);
    expect(sharedWarnings([c(['a'])])).toEqual([]);
    expect(sharedWarnings([c(['a']), c([])])).toEqual([]);
  });

  test('the differing part of a title is found without a list of known marks', () => {
    expect(textDiff('ENDROLL', 'ENDROLL -Short Ver.-')).toMatchObject({ same: false, before: 'ENDROLL ', extra: '-Short Ver.-', after: '' });
    expect(textDiff('次のページへ', '次のページへ (TV Size)').extra).toBe('(TV Size)');
    expect(textDiff('ＬＡＳＴ', 'last').same).toBe(true);                             // width and case are not differences
    expect(textDiff('ENDROLL -Extra-', 'ENDROLL')).toMatchObject({ same: false, extra: '', missing: '-Extra-' });
  });
  test('durations read the same way everywhere', () => {
    expect(deltaShort(1000)).toBe('+1.0 秒');
    expect(deltaShort(-91000)).toBe('−1:31');
    expect(deltaShort(null)).toBe('时长未知');
    expect(deltaLong(-90000)).toBe('比本曲短 1 分 30 秒');
    expect(deltaLong(0)).toBe('与本曲时长相同');
  });
  test('adoption goes straight in only for missing lyrics; otherwise through the editor draft', () => {
    const doc = (kind: 'missing' | 'synced' | 'instrumental') => ({ ...parseLyrics('', 't'), kind, locked: false });
    expect(adoptPath('t', null, doc('missing'))).toBe('document');
    expect(adoptPath('t', null, doc('synced'))).toBe('openEditor');
    expect(adoptPath('t', null, doc('instrumental'))).toBe('openEditor');
    expect(adoptPath('t', { trackId: 't', status: 'ready', document: doc('missing'), error: null, pendingImport: null }, null)).toBe('editorDraft');
    expect(adoptPath('t', null, null)).toBe('openEditor');                          // unknown: the safe way
  });
});

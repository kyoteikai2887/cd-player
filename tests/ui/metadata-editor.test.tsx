/**
 * Album and track metadata editing (Claude, R2): the pure draft model, then the editor against the
 * DemoBridge. Only changed fields are sent, with the revision the draft started from.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionResult, PlayerBridge, UIAction } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import type { UIBoot } from '../../src/ui/lib/env.ts';
import {
  albumForm, albumIssues, albumValues, compareFields, diffPatch, patchIsValid, pickAlbumFields, pickTrackFields, trackForm, trackIssues, trackValues,
} from '../../src/ui/lib/metadataDraft.ts';

afterEach(cleanup);

describe('metadata draft model', () => {
  const { library } = createDemoData();
  const album = library.albums.find(a => a.id === 'album-blue')!;
  const track = library.tracks.find(t => t.id === 'track-blue')!;

  test('empty optional text becomes null; required fields are never sent empty', () => {
    const form = { ...albumForm(album), label: '  ', workTitle: '', title: '  ' };
    expect(albumIssues(form).map(i => i.field)).toEqual(['title']);
    const values = albumValues({ ...form, title: '蒼い窓辺' }, album.discs.map(d => d.number));
    expect(values.label).toBeNull();
    expect(values.workTitle).toBeNull();
    const patch = diffPatch(values, pickAlbumFields(album));
    expect(Object.keys(patch).sort()).toEqual(['label', 'title', 'workTitle']);
    expect(patchIsValid(patch, true)).toBe(true);
  });

  test('numbers stay as typed until valid; an unreadable year is never sent', () => {
    const form = { ...albumForm(album), releaseYear: '２０２６年' };
    expect(albumIssues(form)[0]).toMatchObject({ field: 'releaseYear', blocking: true });
    const patch = diffPatch(albumValues(form, [1]), pickAlbumFields(album));
    expect(patchIsValid(patch, true)).toBe(false);
    expect(albumValues({ ...form, releaseYear: '' }, [1]).releaseYear).toBeNull();
    const t = { ...trackForm(track), discNumber: '0', trackNumber: '2' };
    expect(trackIssues(t).map(i => i.field)).toEqual(['discNumber']);
  });

  test('several artists and a CV credit are kept as given; duplicates and blanks drop out', () => {
    const form = { ...trackForm(track), artists: ['空野ミオ', ' 月野ユイ ', '', '空野ミオ'], artistCredit: '空野ミオ (CV.月野ユイ) ' };
    const values = trackValues(form);
    expect(values.artists).toEqual(['空野ミオ', '月野ユイ']);
    expect(values.artistCredit).toBe('空野ミオ (CV.月野ユイ)');
    expect(diffPatch(values, pickTrackFields(track))).toEqual({});
  });

  test('a clash of disc and track number is a warning, not a blocker', () => {
    const issues = trackIssues({ ...trackForm(track), trackNumber: '2' }, [{ id: 'track-tv', disc: 1, track: 2, title: '窓辺の青' }], 'track-blue');
    expect(issues).toEqual([{ field: 'trackNumber', message: '和“窓辺の青”的碟号、曲号相同。', blocking: false }]);
  });

  test('comparison lists what changed elsewhere, in the draft, or both', () => {
    const base = pickAlbumFields(album);
    const latest = { ...base, label: '別レーベル', releaseYear: 2025 };
    const draft = { ...base, label: '自主制作', catalogNumber: 'X-1' };
    const rows = compareFields(base, latest, draft, { label: '厂牌', releaseYear: '发行年份', catalogNumber: '品番' });
    expect(rows.map(r => [r.field, r.theirs, r.mine])).toEqual([['releaseYear', true, false], ['catalogNumber', false, true], ['label', true, true]]);
  });
});

type Override = (action: UIAction) => ActionResult | null;
function Live({ bridge, log, boot, override }: { bridge: PlayerBridge; log: UIAction[]; boot: UIBoot; override?: Override }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const onAction = useCallback(async (action: UIAction): Promise<ActionResult> => {
    log.push(action);
    return override?.(action) ?? bridge.dispatch(action);
  }, [bridge, log, override]);
  return <UIBootContext.Provider value={boot}><PlayerUI snapshot={snapshot} surface="main" onAction={onAction} /></UIBootContext.Provider>;
}
function setup(albumId = 'album-blue', override?: Override) {
  const session = createMockSession({ autoTick: false, taskDelayMs: 0 });
  const bridge = session.connect('main'), elsewhere = session.connect('mini');
  const log: UIAction[] = [];
  render(<Live bridge={bridge} log={log} boot={{ route: { name: 'album', albumId } }} override={override} />);
  const core = async (action: UIAction) => { let result!: ActionResult; await act(async () => { result = await elsewhere.dispatch(action); }); return result; };
  const reports = () => log.filter((a): a is Extract<UIAction, { type: 'reportUnsavedChanges' }> => a.type === 'reportUnsavedChanges').map(a => a.dirty);
  const album = () => bridge.getSnapshot().library.albums.find(a => a.id === albumId)!;
  const track = (id: string) => bridge.getSnapshot().library.tracks.find(t => t.id === id)!;
  return { session, log, core, reports, album, track };
}
const openAlbumEditor = async () => {
  fireEvent.click(screen.getByRole('button', { name: '更多专辑操作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '编辑专辑资料…' }));
  return screen.findByRole('dialog', { name: '资料编辑' });
};
const input = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const type = (name: string, value: string) => fireEvent.change(input(name), { target: { value } });
const click = (name: string | RegExp, role = 'button') => fireEvent.click(screen.getByRole(role, { name }));
const updates = (log: UIAction[]) => log.filter(a => a.type === 'updateAlbum' || a.type === 'updateTrack') as Extract<UIAction, { type: 'updateAlbum' | 'updateTrack' }>[];

describe('metadata editor', () => {
  test('saves only the changed fields with the starting revision; saved fields become protected', async () => {
    const { session, log, reports, album } = setup();
    try {
      await openAlbumEditor();
      const start = album().revision;
      type('厂牌', '');                      // optional → not set
      type('品番', 'DEMO-001A');
      await waitFor(() => expect(reports()).toEqual([true]));
      click(/^保存/);
      await waitFor(() => expect(reports()).toEqual([true, false]));
      expect(updates(log)).toEqual([{ type: 'updateAlbum', albumId: 'album-blue', baseRevision: start, patch: { catalogNumber: 'DEMO-001A', label: null } }]);
      expect(album()).toMatchObject({ revision: start + 1, label: null, catalogNumber: 'DEMO-001A' });
      expect(['label', 'catalogNumber'].every(f => album().userEditedFields.includes(f as never))).toBe(true);
      const field = input('品番').closest('[data-field]') as HTMLElement;
      expect(within(field).getByText('手动')).toBeTruthy();       // protected from automatic lookups now
      expect(screen.getByText('已保存')).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('a required field left empty is marked in place and nothing is sent', async () => {
    const { session, log } = setup();
    try {
      await openAlbumEditor();
      type('专辑名', '   ');
      expect(screen.getByText('专辑名不能为空。')).toBeTruthy();
      click(/^保存/);
      await new Promise(r => setTimeout(r, 30));
      expect(updates(log)).toHaveLength(0);
      expect(screen.getByText('有必填或格式不对的地方，先改好再保存。')).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('a track takes several artists and a CV credit; numbers and version are edited per track', async () => {
    const { session, log, track } = setup();
    try {
      await openAlbumEditor();
      fireEvent.click(within(screen.getByRole('navigation', { name: '要编辑的条目' })).getByRole('button', { name: /窓辺の青.*TV size/ }));
      const start = track('track-tv').revision;
      fireEvent.change(input('添加歌手'), { target: { value: '星野レナ' } });
      fireEvent.keyDown(input('添加歌手'), { key: 'Enter' });
      click('移除 空野ミオ');
      type('署名', '月野ユイ、星野レナ (CV.星野レナ)');
      type('版本说明', 'TV size ver.');
      click(/^保存/);
      await waitFor(() => expect(track('track-tv').revision).toBe(start + 1));
      expect(updates(log)[0]).toEqual({ type: 'updateTrack', trackId: 'track-tv', baseRevision: start,
        patch: { artists: ['月野ユイ', '星野レナ'], artistCredit: '月野ユイ、星野レナ (CV.星野レナ)', versionLabel: 'TV size ver.' } });
    } finally { session.destroy(); }
  });

  test('closing with unsaved changes asks; discarding sends nothing', async () => {
    const { session, log, reports } = setup();
    try {
      await openAlbumEditor();
      type('作品', '蒼い窓辺 第二期');
      click('关闭资料编辑');
      expect(screen.getByRole('alertdialog', { name: '未保存的修改' })).toBeTruthy();
      click('放弃修改');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '资料编辑' })).toBeNull());
      expect(updates(log)).toHaveLength(0);
      await waitFor(() => expect(reports()).toEqual([true, false]));
    } finally { session.destroy(); }
  });

  test('a conflict keeps the draft; compare marks both sides; overwrite sends against the latest and conflicts again if it moved', async () => {
    const { session, log, core, album } = setup();
    try {
      await openAlbumEditor();
      const start = album().revision;
      type('厂牌', '架空レコード（自主制作）');
      await core({ type: 'updateAlbum', albumId: 'album-blue', baseRevision: start, patch: { label: '架空レコード東京', releaseYear: 2025 } });
      expect(await screen.findByText('1 项与最新版本冲突')).toBeTruthy();
      expect(input('厂牌').value).toBe('架空レコード（自主制作）');
      click(/^保存/);
      await screen.findByText('有 1 项与最新版本冲突，没有保存；请逐项比较后决定。');
      expect(updates(log)).toHaveLength(0);

      click(/比较/);
      const table = screen.getByRole('table');
      expect(within(table).getByText('双方都改')).toBeTruthy();
      expect(within(table).getByText('别处改的')).toBeTruthy();
      click('返回编辑');

      // Overwrite is confirmed against the version on screen; another save lands before it is sent.
      click('用我的修改覆盖…');
      await core({ type: 'updateAlbum', albumId: 'album-blue', baseRevision: start + 1, patch: { catalogNumber: 'DEMO-009' } });
      fireEvent.click(screen.getByRole('button', { name: '覆盖' }));
      await waitFor(() => expect(updates(log)).toHaveLength(1));
      expect(updates(log)[0]).toEqual({ type: 'updateAlbum', albumId: 'album-blue', baseRevision: start + 1, patch: { label: '架空レコード（自主制作）' } });
      await screen.findByText('1 项与最新版本冲突');                 // second conflict: the draft is still there
      expect(input('厂牌').value).toBe('架空レコード（自主制作）');
      expect(album().label).toBe('架空レコード東京');
      click('用我的修改覆盖…');
      fireEvent.click(screen.getByRole('button', { name: '覆盖' }));
      await waitFor(() => expect(album().label).toBe('架空レコード（自主制作）'));
      // Only the user's field was written; the other side's changes stand.
      expect(updates(log)[1]).toEqual({ type: 'updateAlbum', albumId: 'album-blue', baseRevision: start + 2, patch: { label: '架空レコード（自主制作）' } });
      expect(album()).toMatchObject({ releaseYear: 2025, catalogNumber: 'DEMO-009' });
      await waitFor(() => expect(screen.queryByText('1 项与最新版本冲突')).toBeNull());
      expect(screen.getByText('已是最新')).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('loading the latest replaces just that entry after confirming', async () => {
    const { session, core, album } = setup();
    try {
      await openAlbumEditor();
      type('厂牌', '草稿レーベル');
      await core({ type: 'updateAlbum', albumId: 'album-blue', baseRevision: album().revision, patch: { label: '別レーベル' } });
      await screen.findByText('1 项与最新版本冲突');
      click('载入最新…');
      expect(input('厂牌').value).toBe('草稿レーベル');
      click('载入最新');
      await waitFor(() => expect(input('厂牌').value).toBe('別レーベル'));
      expect(screen.getByText('已是最新')).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('a new cover is saved at once and does not turn the album draft into a conflict', async () => {
    const { session, log, album } = setup();
    try {
      await openAlbumEditor();
      type('品番', 'DEMO-777');
      const start = album().revision;
      click('更换封面…');
      await waitFor(() => expect(album().revision).toBe(start + 1));
      expect(log.find(a => a.type === 'pickCoverImage')).toEqual({ type: 'pickCoverImage', albumId: 'album-blue', baseRevision: start });
      expect(screen.queryByText('1 项与最新版本冲突')).toBeNull();
      click(/^保存/);
      await waitFor(() => expect(album().catalogNumber).toBe('DEMO-777'));
      expect(updates(log)[0]).toMatchObject({ baseRevision: start + 1 });
    } finally { session.destroy(); }
  });

  test('cancelling the cover picker shows nothing; a real failure shows once, in place', async () => {
    let answer: ActionResult = { ok: true, status: 'cancelled' };
    const { session, album } = setup('album-blue', action => action.type === 'pickCoverImage' ? answer : null);
    try {
      await openAlbumEditor();
      const before = album().revision;
      click('更换封面…');
      await new Promise(r => setTimeout(r, 30));
      expect(screen.queryByRole('alert')).toBeNull();
      answer = { ok: false, code: 'unavailable', message: '暂时无法打开图片选择。' };
      click('更换封面…');
      expect((await screen.findAllByRole('alert')).map((a: HTMLElement) => a.textContent)).toEqual(['暂时无法打开图片选择。']);
      expect(album().revision).toBe(before);
    } finally { session.destroy(); }
  });

  test('unsaved work is one surface total: closing one editor does not clear another', async () => {
    const { session, core, reports } = setup();
    try {
      await openAlbumEditor();
      type('作品', '未保存の作品名');
      await core({ type: 'openLyricsEditor', trackId: 'track-blue' });
      await screen.findByRole('dialog', { name: '歌词编辑' });
      fireEvent.change(screen.getByRole('textbox', { name: '第 1 行原文' }), { target: { value: '歌詞の草稿' } });
      click('关闭歌词编辑');
      click('放弃修改');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '歌词编辑' })).toBeNull());
      expect(reports()).toEqual([true]);
      click('关闭资料编辑');
      click('放弃修改');
      await waitFor(() => expect(reports()).toEqual([true, false]));
    } finally { session.destroy(); }
  });
});

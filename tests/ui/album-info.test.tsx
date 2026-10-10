/**
 * Album information (Claude, V1.1): the album page no longer carries a standing row of technical
 * state; metadata status, protected fields and the rip summary are one menu item away, exactly as
 * the snapshot has them. Lookup progress, errors and missing files stay on the page.
 */
import React from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionResult, Album, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import { ACCURATE_RIP, METADATA_STATUS } from '../../src/ui/views/AlbumInfoSheet.tsx';

afterEach(cleanup);

const ALBUM = 'album-starsea';
function base(): UISnapshot {
  const session = createMockSession({ autoTick: false });
  try { return session.connect('main').getSnapshot(); } finally { session.destroy(); }
}
const withAlbum = (snapshot: UISnapshot, patch: Partial<Album>): UISnapshot => ({ ...snapshot,
  library: { ...snapshot.library, albums: snapshot.library.albums.map(a => (a.id === ALBUM ? { ...a, ...patch } : a)) } });

function view(snapshot: UISnapshot, onAction: (a: UIAction) => Promise<ActionResult> = async () => ({ ok: true, status: 'applied' })) {
  const boot = { route: { name: 'album' as const, albumId: ALBUM } };
  const ui = (s: UISnapshot) => <UIBootContext.Provider value={boot}><PlayerUI snapshot={s} surface="main" onAction={onAction} /></UIBootContext.Provider>;
  const v = render(ui(snapshot));
  return { ...v, rerender: (s: UISnapshot) => v.rerender(ui(s)) };
}
const page = () => screen.getByRole('article');
async function openInfo() {
  const more = screen.getByRole('button', { name: '更多专辑操作' });
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole('menuitem', { name: '专辑信息…' }));
  return { more, sheet: await screen.findByRole('dialog', { name: '专辑信息' }) };
}

describe('album page', () => {
  test('no standing status row: no metadata badge, lock count or rip marks under the actions', () => {
    view(withAlbum(base(), { metadataStatus: 'unmatched', userEditedFields: ['title'], rip: { hasLog: true, hasCue: false, accurateRip: 'unknown' } }));
    const header = page().querySelector('header')!;
    expect(header).not.toBeNull();
    for (const word of ['资料未匹配', '资料不完整', '抓轨日志', 'AccurateRip 未核验', 'CUE']) expect(within(header).queryByText(word)).toBeNull();
    // The entry points stay.
    fireEvent.click(screen.getByRole('button', { name: '更多专辑操作' }));
    for (const name of ['专辑信息…', '查找专辑资料', '更换封面…', '编辑专辑资料…']) expect(screen.getByRole('menuitem', { name })).toBeTruthy();
  });

  test('a lookup of this album shows its progress on the page; another album\'s does not', () => {
    const task = { id: 't', kind: 'metadata' as const, status: 'running' as const, label: '查找专辑资料', progress: 0.4, cancellable: true };
    const v = view({ ...base(), tasks: [{ ...task, albumId: ALBUM }] });
    const status = within(page()).getByRole('status');
    expect(status.textContent).toContain('正在查找专辑资料');
    expect(status.textContent).toContain('40%');
    v.rerender({ ...base(), tasks: [{ ...task, albumId: 'album-blue' }] });
    expect(within(page()).queryByRole('status')).toBeNull();
  });

  test('a failed lookup is still reported in place, and missing files still warn under the tracks', async () => {
    const snapshot = base();
    const tracks = snapshot.library.tracks.map(t => (t.albumId === ALBUM && t.trackNumber === 1 ? { ...t, available: false } : t));
    view({ ...snapshot, library: { ...snapshot.library, tracks } },
      async () => ({ ok: false, code: 'unavailable', message: '资料服务暂时无法访问。' }));
    fireEvent.click(screen.getByRole('button', { name: '更多专辑操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '查找专辑资料' }));
    expect((await within(page()).findByRole('alert')).textContent).toContain('资料服务暂时无法访问。');
    expect(within(page()).getByText(/有曲目的文件暂时找不到/)).toBeTruthy();
    expect(within(page()).getAllByText('文件不可用').length).toBeGreaterThan(0);
  });
});

describe('album information sheet', () => {
  test('opens from the menu, shows the snapshot as it is, and gives focus back to the menu button on close', async () => {
    view(withAlbum(base(), { metadataStatus: 'partial', userEditedFields: ['title', 'cover'],
      rip: { hasLog: true, hasCue: false, accurateRip: 'notVerified', discs: [{ number: 1, hasLog: true, hasCue: false, discId: 'id-1' }, { number: 2, hasLog: false, hasCue: false }] } }));
    const { more, sheet } = await openInfo();
    expect(within(sheet).getByText(METADATA_STATUS.partial.label)).toBeTruthy();
    expect(within(sheet).getByText('2 项')).toBeTruthy();
    expect(within(sheet).getByText(/标题、封面。自动查找资料不会覆盖这些项/)).toBeTruthy();
    expect(within(sheet).getByText('未通过')).toBeTruthy();
    expect(within(sheet).queryByText('未核验')).toBeNull();
    expect(within(sheet).getByRole('table')).toBeTruthy();
    expect(within(sheet).getByText('id-1')).toBeTruthy();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  test('the four AccurateRip states keep their own words; a log alone is not a pass', async () => {
    const labels = new Set<string>();
    for (const state of ['verified', 'partial', 'notVerified', 'unknown'] as const) {
      view(withAlbum(base(), { rip: { hasLog: true, hasCue: true, accurateRip: state } }));
      const { sheet } = await openInfo();
      const row = sheet.querySelector(`[data-accuraterip="${state}"]`)!;
      expect(row).not.toBeNull();
      expect(row.textContent).toContain(ACCURATE_RIP[state].label);
      labels.add(ACCURATE_RIP[state].label);
      if (state === 'unknown') expect(row.textContent).toContain('有抓轨日志也不代表核验通过');
      cleanup();
    }
    expect(labels.size).toBe(4);
    expect(ACCURATE_RIP.unknown.label).toBe('未核验');
    expect(ACCURATE_RIP.notVerified.label).toBe('未通过');
  });

  test('no rip on file, nothing protected: it says so plainly', async () => {
    view(withAlbum(base(), { rip: undefined, userEditedFields: [], metadataStatus: 'matched' }));
    const { sheet } = await openInfo();
    expect(within(sheet).getByText(METADATA_STATUS.matched.label)).toBeTruthy();
    expect(within(sheet).getByText('这张专辑旁边没有找到抓轨日志或 CUE。')).toBeTruthy();
    expect(within(sheet).getByText('自动查找资料时，所有项目都可以更新。')).toBeTruthy();
  });

  test('its actions are the page\'s own: lookup runs lookupMetadata, edit opens the editor; reading changes nothing', async () => {
    const sent: UIAction[] = [];
    const snapshot = withAlbum(base(), { metadataStatus: 'unmatched', userEditedFields: ['label'] });
    view(snapshot, async a => { sent.push(a); return { ok: true, status: 'applied' }; });
    let { sheet } = await openInfo();
    expect(sent).toEqual([]);                                     // opening the sheet sends nothing
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '查找专辑资料' })); });
    expect(sent).toEqual([{ type: 'lookupMetadata', albumId: ALBUM }]);
    expect(screen.queryByRole('dialog', { name: '专辑信息' })).toBeNull();
    ({ sheet } = await openInfo());
    fireEvent.click(within(sheet).getByRole('button', { name: '编辑专辑资料…' }));
    expect(await screen.findByRole('region', { name: '专辑资料' })).toBeTruthy();   // the metadata editor
    expect(screen.queryByRole('dialog', { name: '专辑信息' })).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

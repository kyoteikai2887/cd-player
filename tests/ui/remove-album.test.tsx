/**
 * Removing an album from the collection (Claude, R2.2; contract 0.3.0 removeAlbum), against the
 * DemoBridge. The revision on screen when the dialog opens guards the removal; a conflict shows
 * the latest content and waits for a new confirmation; drafts are given up only on success.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionResult, PlayerBridge, UIAction } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import type { MockOptions } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import type { UIBoot } from '../../src/ui/lib/env.ts';

afterEach(cleanup);

function Live({ bridge, log, boot = {}, intercept }: {
  bridge: PlayerBridge; log: UIAction[]; boot?: UIBoot; intercept?: (action: UIAction) => ActionResult | null;
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
function Mini({ bridge }: { bridge: PlayerBridge }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  return <PlayerUI snapshot={snapshot} surface="mini" onAction={action => bridge.dispatch(action)} />;
}

function setup({ options = {}, albumId, intercept, withMini = false }: {
  options?: MockOptions; albumId?: string; intercept?: (action: UIAction) => ActionResult | null; withMini?: boolean;
} = {}) {
  const session = createMockSession({ autoTick: false, taskDelayMs: 0, ...options });
  const bridge = session.connect('main'), elsewhere = session.connect('mini');
  const log: UIAction[] = [];
  const boot: UIBoot = albumId ? { route: { name: 'album', albumId } } : {};
  render(<>
    <Live bridge={bridge} log={log} boot={boot} intercept={intercept} />
    {withMini && <Mini bridge={elsewhere} />}
  </>);
  const core = async (action: UIAction) => { let result!: ActionResult; await act(async () => { result = await elsewhere.dispatch(action); }); return result; };
  const snap = () => bridge.getSnapshot();
  const removals = () => log.filter((a): a is Extract<UIAction, { type: 'removeAlbum' }> => a.type === 'removeAlbum');
  const reports = () => log.filter((a): a is Extract<UIAction, { type: 'reportUnsavedChanges' }> => a.type === 'reportUnsavedChanges').map(a => a.dirty);
  return { session, core, snap, log, removals, reports };
}
/** Opens the album page's menu and asks to remove; returns the confirmation dialog. */
async function askToRemove() {
  fireEvent.click(screen.getByRole('button', { name: '更多专辑操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '从收藏移除…' }));
  return screen.findByRole('alertdialog');
}
const confirmIn = (dialog: HTMLElement, name: string | RegExp = '从收藏移除') => fireEvent.click(within(dialog).getByRole('button', { name }));
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

describe('remove from collection', () => {
  test('the album menu offers it; cancel and Escape send nothing and keep the album', async () => {
    const { session, removals, snap } = setup({ albumId: 'album-white' });
    try {
      const dialog = await askToRemove();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(within(dialog).getByText('白い軌道 — Character Songs')).toBeTruthy();
      expect(dialog.textContent).toContain('3 首');
      expect(dialog.textContent).toContain('都留在原处');
      expect(dialog.textContent).toContain('自动备份');
      expect(document.activeElement?.textContent).toBe('取消');                 // the safe choice has focus
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      const again = await askToRemove();
      fireEvent.keyDown(again, { key: 'Escape' });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(removals()).toEqual([]);
      expect(snap().library.albums.some(a => a.id === 'album-white')).toBe(true);
    } finally { session.destroy(); }
  });

  test('confirming sends the revision seen when the dialog opened; the page returns to the shelf', async () => {
    const { session, removals, snap } = setup({ albumId: 'album-white' });
    try {
      const opened = snap().library.revision;
      const albums = snap().library.albums.length;
      confirmIn(await askToRemove());
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(removals()).toEqual([{ type: 'removeAlbum', albumId: 'album-white', baseLibraryRevision: opened }]);
      expect(snap().library.albums.some(a => a.id === 'album-white')).toBe(false);
      expect(await screen.findByRole('heading', { name: 'CD 收藏' })).toBeTruthy();       // back on the shelf
      const summary = screen.getByRole('list', { name: '收藏统计' });
      expect(summary.textContent).toContain(`${albums - 1}张专辑`);
    } finally { session.destroy(); }
  });

  test('a save made while confirming is a conflict: the latest is shown and nothing is retried', async () => {
    const { session, core, removals, snap } = setup({ albumId: 'album-white' });
    try {
      const opened = snap().library.revision;
      const dialog = await askToRemove();
      const album = snap().library.albums.find(a => a.id === 'album-white')!;
      await core({ type: 'updateAlbum', albumId: 'album-white', baseRevision: album.revision, patch: { title: '白い軌道 — 改訂版' } });
      const changed = snap().library.revision;
      expect(changed).not.toBe(opened);
      confirmIn(dialog);
      await screen.findByText(/请再确认一次/);
      expect(within(dialog).getByText('白い軌道 — 改訂版')).toBeTruthy();             // the latest content
      await settle();
      expect(removals()).toEqual([{ type: 'removeAlbum', albumId: 'album-white', baseLibraryRevision: opened }]);
      confirmIn(dialog, '再次确认移除');
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(removals().map(r => r.baseLibraryRevision)).toEqual([opened, changed]);
      expect(snap().library.albums.some(a => a.id === 'album-white')).toBe(false);
    } finally { session.destroy(); }
  });

  test('removing the album that plays stops it; the queue keeps the other albums, the mini goes idle', async () => {
    const { session, core, snap } = setup({ albumId: 'album-blue', withMini: true });
    try {
      await core({ type: 'playAlbum', albumId: 'album-blue' });
      await core({ type: 'enqueue', trackIds: ['track-plain', 'track-missing'], position: 'end' });
      const others = snap().player.queue.filter(e => e.trackId === 'track-plain' || e.trackId === 'track-missing').map(e => e.id);
      const dialog = await askToRemove();
      expect(dialog.textContent).toContain('确认后播放会停止');
      expect(dialog.textContent).toContain('队列里有它的 2 首');
      confirmIn(dialog);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      const player = snap().player;
      expect(player.status).toBe('idle');
      expect(player.currentTrackId).toBeNull();
      expect(player.queue.map(e => e.id)).toEqual(others);                          // ids and order kept
      expect(screen.getByText('还没有在播放')).toBeTruthy();                           // the mini follows
    } finally { session.destroy(); }
  });

  test('removing another album keeps playback and drops its queue entries, repeats included', async () => {
    const { session, core, snap } = setup({ albumId: 'album-white' });
    try {
      await core({ type: 'playAlbum', albumId: 'album-blue' });
      await core({ type: 'enqueue', trackIds: ['track-plain', 'track-plain', 'track-missing'], position: 'end' });
      const before = snap().player;
      const dialog = await askToRemove();
      expect(dialog.textContent).toContain('队列里有它的 3 首');
      expect(dialog.textContent).toContain('正在播放的不受影响');
      expect(dialog.textContent).not.toContain('播放会停止');
      confirmIn(dialog);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      const after = snap().player;
      expect(after.currentTrackId).toBe(before.currentTrackId);
      expect(after.status).toBe(before.status);
      expect(after.queue.map(e => e.trackId)).toEqual(['track-blue', 'track-tv', 'track-piano']);
    } finally { session.destroy(); }
  });

  test('removing the last album shows the empty collection', async () => {
    const { session, core, snap } = setup({ albumId: 'album-white' });
    try {
      for (const album of snap().library.albums.filter(a => a.id !== 'album-white')) {
        expect((await core({ type: 'removeAlbum', albumId: album.id, baseLibraryRevision: snap().library.revision })).ok).toBe(true);
      }
      confirmIn(await askToRemove());
      expect(await screen.findByRole('heading', { name: '把抓好的 CD 放进来' })).toBeTruthy();
      expect(snap().library.albums).toEqual([]);
    } finally { session.destroy(); }
  });

  test('an album whose files are missing can be removed, and the dialog says only records go', async () => {
    const { session, snap } = setup({ albumId: 'album-blue', options: { scenario: 'unavailable' } });
    try {
      const dialog = await askToRemove();
      expect(dialog.textContent).toContain('文件现在找不到');
      confirmIn(dialog);
      await waitFor(() => expect(snap().library.albums.some(a => a.id === 'album-blue')).toBe(false));
    } finally { session.destroy(); }
  });

  test('drafts about the album are named and given up only when it goes; other drafts stay', async () => {
    const { session, core, reports } = setup({ albumId: 'album-blue' });
    const type = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
    try {
      // A lyrics draft for each album, both set aside by the core (switch, then close from elsewhere).
      await core({ type: 'openLyricsEditor', trackId: 'track-blue' });
      await screen.findByRole('dialog', { name: '歌词编辑' });
      type('第 1 行原文', '青の草稿');
      await core({ type: 'openLyricsEditor', trackId: 'track-plain' });
      await screen.findByRole('heading', { name: '白い軌道' });
      type('第 1 行原文', '白の草稿');
      await core({ type: 'closeLyricsEditor' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '歌词编辑' })).toBeNull());
      expect(reports()).toEqual([true]);

      // Cancel keeps everything.
      let dialog = await askToRemove();
      expect(dialog.textContent).toContain('「窓辺の青」的歌词');
      expect(dialog.textContent).not.toContain('白い軌道');
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      dialog = await askToRemove();
      confirmIn(dialog);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await settle();
      expect(reports()).toEqual([true]);                                           // the other draft still counts

      // Removing the other album gives up the last draft: the surface is clean again.
      fireEvent.click(screen.getAllByRole('button', { name: /^白い軌道 — Character Songs/ })[0]);
      await screen.findByRole('button', { name: '返回CD 收藏' });
      dialog = await askToRemove();
      expect(dialog.textContent).toContain('「白い軌道」的歌词');
      confirmIn(dialog);
      await waitFor(() => expect(reports()).toEqual([true, false]));
    } finally { session.destroy(); }
  });

  test('removed elsewhere while confirming: the dialog says so, closes to the shelf and tells the shelf', async () => {
    const { session, core, snap, removals } = setup({ albumId: 'album-white' });
    try {
      const dialog = await askToRemove();
      await core({ type: 'removeAlbum', albumId: 'album-white', baseLibraryRevision: snap().library.revision });
      expect(within(dialog).getByText(/已经从收藏里移除了/)).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: '从收藏移除' })).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(await screen.findByText('这张专辑已经不在收藏里了。')).toBeTruthy();
      expect(removals()).toEqual([]);
    } finally { session.destroy(); }
  });

  test('a failure stays in the dialog, keeps the album and can be retried or cancelled', async () => {
    let fail = true;
    const intercept = (action: UIAction): ActionResult | null => action.type === 'removeAlbum' && fail
      ? { ok: false, code: 'io', message: '备份没有写入成功，收藏没有改动。' } : null;
    const { session, snap, removals } = setup({ albumId: 'album-white', intercept });
    try {
      const dialog = await askToRemove();
      confirmIn(dialog);
      expect((await within(dialog).findByRole('alert')).textContent).toContain('备份没有写入成功');
      expect(screen.getByRole('alertdialog')).toBe(dialog);
      expect(snap().library.albums.some(a => a.id === 'album-white')).toBe(true);
      fail = false;
      confirmIn(dialog);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(removals()).toHaveLength(2);
      expect(snap().library.albums.some(a => a.id === 'album-white')).toBe(false);
    } finally { session.destroy(); }
  });
});

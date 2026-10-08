/**
 * Queue reordering and mini window interactions (Claude, R2), against the DemoBridge.
 * Rows are keyed by queue entry id; the snapshot order is the truth after every move.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionResult, PlayerBridge, UISnapshot, UIAction } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';

afterEach(cleanup);

function Live({ bridge, log, surface = 'main' }: { bridge: PlayerBridge; log: UIAction[]; surface?: 'main' | 'mini' }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const onAction = useCallback((action: UIAction): Promise<ActionResult> => { log.push(action); return bridge.dispatch(action); }, [bridge, log]);
  return (
    <UIBootContext.Provider value={surface === 'main' ? { route: { name: 'nowPlaying' }, nowPlayingTab: 'queue' } : {}}>
      <PlayerUI snapshot={snapshot} surface={surface} onAction={onAction} />
    </UIBootContext.Provider>
  );
}
async function setup() {
  const session = createMockSession({ autoTick: false });
  const bridge = session.connect('main'), elsewhere = session.connect('mini');
  const log: UIAction[] = [];
  const core = async (action: UIAction) => { let result!: ActionResult; await act(async () => { result = await elsewhere.dispatch(action); }); return result; };
  await core({ type: 'playAlbum', albumId: 'album-soda', startTrackId: 'track-soda-promise' });
  await core({ type: 'enqueue', trackIds: ['track-soda-promise'], position: 'end' });   // the same track again
  render(<Live bridge={bridge} log={log} />);
  const player = () => bridge.getSnapshot().player;
  const shown = () => [...document.querySelectorAll<HTMLElement>('[data-entry-id]')].map(li => li.dataset.entryId);
  return { session, bridge, log, core, player, shown };
}
const row = (entryId: string) => document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)!;
const grip = (entryId: string) => row(entryId).querySelector<HTMLButtonElement>('[data-grip]')!;
const moves = (log: UIAction[]) => log.filter(a => a.type === 'moveQueueEntry');

describe('queue', () => {
  test('the same track twice is two independent entries; removing one keeps the other', async () => {
    const { session, player, shown, log } = await setup();
    try {
      const queue = player().queue;
      const twins = queue.filter(e => e.trackId === 'track-soda-promise');
      expect(twins).toHaveLength(2);
      expect(shown()).toEqual(queue.map(e => e.id));
      // The later copy is not the playing one, so it can be removed by itself.
      const copy = twins.find(e => e.id !== player().currentEntryId)!;
      fireEvent.click(within(row(copy.id)).getByRole('button', { name: /^更多：/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: '从队列移除' }));
      await waitFor(() => expect(player().queue.some(e => e.id === copy.id)).toBe(false));
      expect(player().queue.filter(e => e.trackId === 'track-soda-promise')).toHaveLength(1);
      expect(log.find(a => a.type === 'removeFromQueue')).toEqual({ type: 'removeFromQueue', entryId: copy.id });
    } finally { session.destroy(); }
  });

  test('dragging the grip moves the entry by id to the drop index; the snapshot order is then shown', async () => {
    const { session, player, shown, log } = await setup();
    try {
      const ids = player().queue.map(e => e.id);
      // Layout for the drag maths (jsdom has none): 50px per row.
      document.querySelectorAll<HTMLElement>('[data-entry-id]').forEach((li, i) => {
        li.getBoundingClientRect = () => ({ top: i * 50, bottom: i * 50 + 48, height: 48, left: 0, right: 400, width: 400, x: 0, y: i * 50, toJSON() { return this; } }) as DOMRect;
      });
      const handle = grip(ids[0]);
      fireEvent.pointerDown(handle, { button: 0, buttons: 1, clientY: 24, pointerId: 7 });
      fireEvent.pointerMove(handle, { buttons: 1, clientY: 24 + 60, pointerId: 7 });
      fireEvent.pointerMove(handle, { buttons: 1, clientY: 24 + 112, pointerId: 7 });
      fireEvent.pointerUp(handle, { button: 0, clientY: 24 + 112, pointerId: 7 });
      await waitFor(() => expect(moves(log)).toEqual([{ type: 'moveQueueEntry', entryId: ids[0], toIndex: 2 }]));
      await waitFor(() => expect(shown()).toEqual(player().queue.map(e => e.id)));
      expect(shown().slice(0, 3)).toEqual([ids[1], ids[2], ids[0]]);
    } finally { session.destroy(); }
  });

  test('keyboard: arrows on the grip and Alt+arrows on a row move one step; focus stays with the entry', async () => {
    const { session, player, log } = await setup();
    try {
      const ids = player().queue.map(e => e.id);
      grip(ids[1]).focus();
      fireEvent.keyDown(grip(ids[1]), { key: 'ArrowDown' });
      await waitFor(() => expect(player().queue[2].id).toBe(ids[1]));
      expect(document.activeElement).toBe(grip(ids[1]));
      fireEvent.keyDown(within(row(ids[3])).getByRole('button', { name: /^播放 / }), { key: 'ArrowUp', altKey: true });
      await waitFor(() => expect(player().queue[2].id).toBe(ids[3]));
      expect(moves(log)).toEqual([
        { type: 'moveQueueEntry', entryId: ids[1], toIndex: 2 },
        { type: 'moveQueueEntry', entryId: ids[3], toIndex: 2 },
      ]);
    } finally { session.destroy(); }
  });

  test('moving the playing entry keeps it playing where it was', async () => {
    const { session, player, core } = await setup();
    try {
      await core({ type: 'seek', positionMs: 42000 });
      const before = player();
      grip(before.currentEntryId!).focus();
      fireEvent.keyDown(grip(before.currentEntryId!), { key: 'End' });
      await waitFor(() => expect(player().queue.at(-1)!.id).toBe(before.currentEntryId));
      const after = player();
      expect(after).toMatchObject({ currentEntryId: before.currentEntryId, currentTrackId: before.currentTrackId, status: before.status, positionMs: 42000 });
      expect(after.currentQueueIndex).toBe(after.queue.length - 1);
    } finally { session.destroy(); }
  });

  test('“play next” puts an entry right after the current one, from either side', async () => {
    const { session, player } = await setup();
    try {
      const last = player().queue.at(-1)!;
      fireEvent.click(within(row(last.id)).getByRole('button', { name: /^更多：/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: '下一首播放' }));
      await waitFor(() => expect(player().queue[player().currentQueueIndex + 1].id).toBe(last.id));
      const first = player().queue[0];
      fireEvent.click(within(row(first.id)).getByRole('button', { name: /^更多：/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: '下一首播放' }));
      await waitFor(() => expect(player().queue[player().currentQueueIndex + 1].id).toBe(first.id));
    } finally { session.destroy(); }
  });

  test('with shuffle on, the shown order is the shuffled snapshot and moves use it', async () => {
    const { session, player, shown, core } = await setup();
    try {
      await core({ type: 'setShuffle', shuffle: true });
      await core({ type: 'setRepeat', repeat: 'all' });
      await waitFor(() => expect(shown()).toEqual(player().queue.map(e => e.id)));
      const status = screen.getByRole('list', { name: '队列状态' });
      expect(within(status).getByText('随机顺序')).toBeTruthy();
      expect(within(status).getByText('全部循环')).toBeTruthy();
      const target = player().queue.at(-1)!;
      grip(target.id).focus();
      fireEvent.keyDown(grip(target.id), { key: 'Home' });
      await waitFor(() => expect(player().queue[0].id).toBe(target.id));
      expect(shown()).toEqual(player().queue.map(e => e.id));
    } finally { session.destroy(); }
  });

  test('after the queue ends, play starts again from the top', async () => {
    const { session, player, core, log } = await setup();
    try {
      const last = player().queue.at(-1)!;
      await core({ type: 'playQueueEntry', entryId: last.id });
      await act(async () => { session.advanceBy(player().durationMs + 10); });
      expect(player()).toMatchObject({ status: 'paused', currentEntryId: last.id });
      expect(await screen.findByText('队列已经播完。')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: '从头播放' })[0]);
      await waitFor(() => expect(player()).toMatchObject({ status: 'playing', currentQueueIndex: 0 }));
      expect(log.at(-1)).toEqual({ type: 'playQueueEntry', entryId: player().queue[0].id });
    } finally { session.destroy(); }
  });
});

describe('mini window', () => {
  function miniSnapshot(base: UISnapshot, patch: Partial<UISnapshot['settings']> = {}): UISnapshot {
    return { ...base, settings: { ...base.settings, ...patch },
      host: { ...base.host, shell: 'tauri', windowMode: 'mini', capabilities: { ...base.host.capabilities, windowDragging: true, transparentWindow: true } } };
  }
  async function mini(patch: Partial<UISnapshot['settings']> = {}) {
    const session = createMockSession({ autoTick: false });
    const bridge = session.connect('mini');
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' }); });
    const log: UIAction[] = [];
    const onAction = async (action: UIAction): Promise<ActionResult> => { log.push(action); return { ok: true, status: 'applied' }; };
    const view = render(<PlayerUI snapshot={miniSnapshot(bridge.getSnapshot(), patch)} surface="mini" onAction={onAction} />);
    return { session, log, view };
  }

  test('a drag starts only past 4px with the primary button, never from buttons or the progress line', async () => {
    const { session, log } = await mini();
    try {
      const title = screen.getByText('窓辺の青');
      const drags = () => log.filter(a => a.type === 'beginWindowDrag').length;
      fireEvent.pointerDown(title, { button: 0, buttons: 1, clientX: 100, clientY: 40 });
      fireEvent.pointerMove(title, { buttons: 1, clientX: 103, clientY: 40 });
      expect(drags()).toBe(0);                                   // 3px: still a click
      fireEvent.pointerMove(title, { buttons: 1, clientX: 106, clientY: 40 });
      fireEvent.pointerMove(title, { buttons: 1, clientX: 120, clientY: 44 });
      expect(drags()).toBe(1);                                   // once per press
      fireEvent.pointerUp(title, { button: 0 });
      fireEvent.pointerDown(title, { button: 2, buttons: 2, clientX: 100, clientY: 40 });
      fireEvent.pointerMove(title, { buttons: 2, clientX: 130, clientY: 40 });
      fireEvent.pointerDown(title, { button: 0, buttons: 1, clientX: 100, clientY: 40 });
      fireEvent.pointerMove(title, { buttons: 0, clientX: 130, clientY: 40 });   // button released outside
      const progress = document.querySelector('[data-surface="mini"] [data-no-drag]')!;
      fireEvent.pointerDown(progress, { button: 0, buttons: 1, clientX: 100, clientY: 90 });
      fireEvent.pointerMove(progress, { buttons: 1, clientX: 140, clientY: 90 });
      const play = screen.getByRole('button', { name: '暂停' });
      fireEvent.pointerDown(play, { button: 0, buttons: 1, clientX: 300, clientY: 40 });
      fireEvent.pointerMove(play, { buttons: 1, clientX: 340, clientY: 40 });
      expect(drags()).toBe(1);
    } finally { session.destroy(); }
  });

  test('× hides to the tray, expand returns to the full window', async () => {
    const { session, log } = await mini();
    try {
      fireEvent.click(screen.getByRole('button', { name: '收起到托盘' }));
      fireEvent.click(screen.getByRole('button', { name: '展开' }));
      await waitFor(() => expect(log.map(a => a.type)).toEqual(['hideToTray', 'setWindowMode']));
      expect(log[1]).toEqual({ type: 'setWindowMode', mode: 'full' });
    } finally { session.destroy(); }
  });

  test('the lyric strip needs synced lyrics and the setting; text scale is capped at 1.1', async () => {
    const off = await mini({ fontScale: 1.3 });
    try {
      const root = document.querySelector<HTMLElement>('[data-surface="mini"]')!;
      expect(root.style.getPropertyValue('--fs')).toBe('1.1');
      expect(root.querySelector('[data-lyrics="true"]')).toBeNull();
    } finally { off.session.destroy(); cleanup(); }
    const on = await mini({ miniShowLyrics: true });
    try {
      expect(document.querySelector('[data-surface="mini"] [data-lyrics="true"]')).not.toBeNull();
    } finally { on.session.destroy(); }
  });
});

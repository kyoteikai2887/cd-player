/**
 * The R2.1 shelf (Claude): the stage at the top of the library, the icon-first top bar, and the
 * mini window's frame under a native material. Runs against the DemoBridge.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ActionResult, Album, HostInfo, PlayerBridge, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { formatRunningTime, spotlightAlbum } from '../../src/ui/views/Spotlight.tsx';

afterEach(cleanup);

function Live({ bridge, log }: { bridge: PlayerBridge; log: UIAction[] }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const onAction = useCallback((action: UIAction): Promise<ActionResult> => { log.push(action); return bridge.dispatch(action); }, [bridge, log]);
  return <PlayerUI snapshot={snapshot} surface="main" onAction={onAction} />;
}
async function setup(play?: string) {
  const session = createMockSession({ autoTick: false });
  const bridge = session.connect('main');
  if (play) await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: play }); });
  const log: UIAction[] = [];
  render(<Live bridge={bridge} log={log} />);
  const album = (id: string) => bridge.getSnapshot().library.albums.find(a => a.id === id)!;
  return { session, bridge, log, album };
}

describe('stage helpers', () => {
  test('running time reads like a CD insert', () => {
    expect(formatRunningTime(0)).toBe('0:00');
    expect(formatRunningTime(816_000)).toBe('13:36');
    expect(formatRunningTime(5_333_400)).toBe('1:28:53');
    expect(formatRunningTime(-5)).toBe('0:00');
    expect(formatRunningTime(Number.NaN)).toBe('0:00');
  });

  test('the album in the player takes the stage; otherwise the newest arrival', () => {
    const a = { id: 'a', addedAt: 1 } as Album, b = { id: 'b', addedAt: 3 } as Album, c = { id: 'c', addedAt: 2 } as Album;
    expect(spotlightAlbum([a, b, c], null)).toEqual({ album: b, inPlayer: false });
    expect(spotlightAlbum([a, b, c], c)).toEqual({ album: c, inPlayer: true });
    expect(spotlightAlbum([], null)).toBeNull();
  });
});

describe('stage', () => {
  test('with nothing loaded the newest arrival is on stage, and plays from there', async () => {
    const { session, bridge, log } = await setup();
    try {
      const newest = spotlightAlbum(bridge.getSnapshot().library.albums, null)!.album;
      const stage = screen.getByRole('region', { name: '最新加入的专辑' });
      expect(within(stage).getByRole('heading', { name: newest.title })).toBeTruthy();
      expect(within(stage).getByText('新入架')).toBeTruthy();
      fireEvent.click(within(stage).getByRole('button', { name: `播放 ${newest.title}` }));
      const playing = await screen.findByRole('region', { name: '播放器里的专辑' });
      expect(log.find(a => a.type === 'playAlbum')).toEqual({ type: 'playAlbum', albumId: newest.id, shuffle: false });
      expect(within(playing).getByRole('heading', { name: newest.title })).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('the album in the player is on stage, its facts readable without the icons', async () => {
    const { session, album } = await setup('album-soda');
    try {
      const soda = album('album-soda');
      const stage = screen.getByRole('region', { name: '播放器里的专辑' });
      expect(within(stage).getByRole('heading', { name: soda.title })).toBeTruthy();
      const facts = within(stage).getAllByRole('listitem').map(li => li.textContent);
      expect(facts).toContain(`${soda.trackIds.length}首曲目`);
      expect(facts.some(text => /^\d+:\d\d(:\d\d)?总时长$/.test(text ?? ''))).toBe(true);
      // R2.2: the text sits on frost; its tones are set on the stage, derived for any cover.
      expect(stage.style.getPropertyValue('--frost-field')).toMatch(/%$/);
      expect(stage.style.getPropertyValue('--ink-2')).toMatch(/^#[0-9A-F]{6}$/);
      expect(stage.querySelector('.cdp-frost')).not.toBeNull();
      // The player capsule is frost that lets a little of the shelf through.
      const capsule = screen.getByRole('region', { name: '播放控制' });
      expect(capsule.classList.contains('glass--frost-see')).toBe(true);
      expect(capsule.style.getPropertyValue('--frost-see-filter')).toMatch(/^blur\(/);
      // Icon-only actions carry their names (and tooltips).
      for (const name of ['随机播放这张专辑', '打开专辑', '打开正在播放']) {
        const button = within(stage).getByRole('button', { name });
        expect(button.getAttribute('title')).toBeTruthy();
      }
    } finally { session.destroy(); }
  });

  test('the stage shuffles the album it shows and opens it', async () => {
    const { session, log, album } = await setup('album-soda');
    try {
      const stage = screen.getByRole('region', { name: '播放器里的专辑' });
      fireEvent.click(within(stage).getByRole('button', { name: '随机播放这张专辑' }));
      await act(async () => { await Promise.resolve(); });
      expect(log.filter(a => a.type === 'playAlbum').at(-1)).toEqual({ type: 'playAlbum', albumId: 'album-soda', shuffle: true });
      fireEvent.click(within(stage).getByRole('button', { name: `打开专辑：${album('album-soda').title}` }));
      expect(await screen.findByRole('button', { name: '返回CD 收藏' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: '播放器里的专辑' })).toBeNull();
    } finally { session.destroy(); }
  });
});

describe('top bar', () => {
  test('the record is the brand: the name stays for screen readers, the record leads home', async () => {
    const { session, bridge } = await setup();
    try {
      const heading = screen.getByRole('heading', { name: 'CD 收藏' });
      expect(heading.tagName).toBe('H1');
      expect(heading.classList.contains('sr-only')).toBe(true);
      const newest = spotlightAlbum(bridge.getSnapshot().library.albums, null)!.album;
      fireEvent.click(screen.getByRole('button', { name: `打开专辑：${newest.title}` }));
      fireEvent.click(await screen.findByRole('button', { name: '返回CD 收藏' }));
      expect(await screen.findByRole('heading', { name: 'CD 收藏' })).toBeTruthy();
    } finally { session.destroy(); }
  });

  test('browsing tabs are icons with names, tooltips and a pressed state', async () => {
    const { session } = await setup();
    try {
      const nav = screen.getByRole('navigation', { name: '浏览方式' });
      const tabs = within(nav).getAllByRole('button');
      expect(tabs.map(tab => tab.getAttribute('aria-label'))).toEqual(['专辑', '作品', '艺术家']);
      expect(tabs.map(tab => tab.getAttribute('title'))).toEqual(['专辑', '作品', '艺术家']);
      expect(tabs.map(tab => tab.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
      fireEvent.click(within(nav).getByRole('button', { name: '作品' }));
      expect(within(nav).getByRole('button', { name: '作品' }).getAttribute('aria-pressed')).toBe('true');
      expect(within(nav).getByRole('button', { name: '专辑' }).getAttribute('aria-pressed')).toBe('false');
    } finally { session.destroy(); }
  });

  test('sorting is a menu behind one icon button that names the current order', async () => {
    const { session } = await setup();
    try {
      const sort = screen.getByRole('button', { name: /^排序：/ });
      const before = sort.getAttribute('aria-label');
      fireEvent.click(sort);
      const items = await screen.findAllByRole('menuitem');
      const other = items.find(item => !before!.endsWith(item.textContent!.trim()))!;
      const label = other.textContent!.trim();
      fireEvent.click(other);
      expect(screen.getByRole('button', { name: `排序：${label}` })).toBeTruthy();
    } finally { session.destroy(); }
  });
});

describe('icons over words', () => {
  /** Text a sighted user reads on the control: not aria-hidden parts, not screen-reader-only words. */
  const words = (el: Element): string => [...el.childNodes].map(node =>
    node.nodeType === 3 ? node.textContent ?? ''
      : node instanceof Element && node.getAttribute('aria-hidden') !== 'true' && !node.classList.contains('sr-only') ? words(node) : '').join('').trim();
  const iconOnlyWithoutHelp = () => [...document.querySelectorAll('[data-surface="main"] button')]
    .filter(button => !words(button) && !(button.getAttribute('aria-label') && button.getAttribute('title')))
    .map(button => button.getAttribute('aria-label') ?? button.outerHTML.slice(0, 80));

  test('every icon-only control on the shelf and the album page has a name and a tooltip', async () => {
    const { session, album } = await setup('album-soda');
    try {
      expect(iconOnlyWithoutHelp()).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: `打开专辑：${album('album-soda').title}` }));
      await screen.findByRole('button', { name: '返回CD 收藏' });
      expect(iconOnlyWithoutHelp()).toEqual([]);
    } finally { session.destroy(); }
  });
});

describe('mini frame', () => {
  async function mini(host: Partial<HostInfo>, transparentWindow: boolean) {
    const session = createMockSession({ autoTick: false });
    const bridge = session.connect('mini');
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
    const base = bridge.getSnapshot();
    const snapshot: UISnapshot = { ...base, host: { ...base.host, windowMode: 'mini', ...host,
      capabilities: { ...base.host.capabilities, transparentWindow } } };
    render(<PlayerUI snapshot={snapshot} surface="mini" onAction={async () => ({ ok: true, status: 'applied' })} />);
    const card = document.querySelector<HTMLElement>('[data-surface="mini"] [data-material]')!;
    return { session, frame: card.parentElement!, card };
  }

  test('over a native material the card fills the window and takes its corners', async () => {
    const { session, frame, card } = await mini({ shell: 'tauri', backdrop: 'acrylic', nativeCornerRadius: 8 }, true);
    try {
      expect(frame.dataset.frame).toBe('material');
      expect(frame.dataset.radius).toBe('8');
      expect(card.dataset.material).toBe('native');
    } finally { session.destroy(); }
  });

  test('without a material a transparent window keeps its margin and a near-opaque card', async () => {
    const { session, frame, card } = await mini({ shell: 'tauri', backdrop: 'none', nativeCornerRadius: 0 }, true);
    try {
      expect(frame.dataset.frame).toBe('transparent');
      expect(card.dataset.material).toBe('solid');
    } finally { session.destroy(); }
  });
});

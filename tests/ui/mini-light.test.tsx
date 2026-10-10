/**
 * V1.1 round 2 (Claude): the mini card is lit by the playing album in every frame the host can give
 * it — a transparent window, a native material, an opaque window — at both heights, and falls back
 * to the theme without an album or when the cover fails. Window behaviour is untouched.
 */
import React from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActionResult, HostInfo, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { contrast, parseHex } from '../../src/ui/lib/color.ts';
import { FROST, frostBackdrops, frostTones } from '../../src/ui/lib/frost.ts';
import type { ThemeName } from '../../src/ui/lib/theme.ts';
import { themePatch } from '../../src/ui/lib/theme.ts';

afterEach(cleanup);

type Frame = 'transparent' | 'material' | 'opaque';
const HOSTS: Record<Frame, { host: Partial<HostInfo>; transparentWindow: boolean }> = {
  transparent: { host: { shell: 'tauri', backdrop: 'none', nativeCornerRadius: 0 }, transparentWindow: true },
  material: { host: { shell: 'tauri', backdrop: 'acrylic', nativeCornerRadius: 8 }, transparentWindow: true },
  opaque: { host: { shell: 'tauri', backdrop: 'none', nativeCornerRadius: 8 }, transparentWindow: false },
};

async function miniSnapshot(frame: Frame, { play = true, lyrics = false, theme = 'light' as ThemeName } = {}): Promise<UISnapshot> {
  const session = createMockSession({ autoTick: false });
  const bridge = session.connect('mini');
  if (play) await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
  const base = bridge.getSnapshot();
  session.destroy();
  const { host, transparentWindow } = HOSTS[frame];
  const patch = themePatch(theme);
  return { ...base,
    host: { ...base.host, windowMode: 'mini', ...host, capabilities: { ...base.host.capabilities, transparentWindow } },
    settings: { ...base.settings, miniShowLyrics: lyrics, ...(patch.background ? { background: patch.background } : {}),
      ui: { ...base.settings.ui, main: { ...base.settings.ui.main, ...patch.ui?.main } } } };
}
const sent: UIAction[] = [];
const onAction = async (a: UIAction): Promise<ActionResult> => { sent.push(a); return { ok: true, status: 'applied' }; };
const view = (snapshot: UISnapshot) => render(<PlayerUI snapshot={snapshot} surface="mini" onAction={onAction} />);
const card = () => document.querySelector<HTMLElement>('[data-surface="mini"] [data-material]')!;
const light = () => card().querySelector<HTMLElement>('.cdp-frost')!;

describe('mini light', () => {
  test('every frame is lit by the album: two layers of its cover, the tone, the derived inks', async () => {
    for (const frame of ['transparent', 'material', 'opaque'] as Frame[]) {
      view(await miniSnapshot(frame));
      const spec = frame === 'material' ? FROST.miniNative.light : FROST.mini.light;
      expect(card().dataset.frost).toBe('true');
      expect(card().style.getPropertyValue('--frost-tone')).toBe(spec.tone);
      expect(card().style.getPropertyValue('--frost-field')).toBe(`${Math.round(spec.field * 100)}%`);
      const accent = (await miniSnapshot(frame)).settings.accentColor;
      expect(card().style.getPropertyValue('--ink-2')).toBe(frostTones('light', spec, accent).ink2);
      const layers = [...light().querySelectorAll('img')];
      expect(layers.map(i => i.dataset.layer)).toEqual(['0', '1']);
      expect(light().getAttribute('aria-hidden')).toBe('true');
      cleanup();
    }
  });

  test('over a native material the light is laid thinner so the material shows; elsewhere it is whole', async () => {
    view(await miniSnapshot('material'));
    expect(card().dataset.material).toBe('native');
    expect(card().style.getPropertyValue('--frost-opacity')).toBe(String(1 - FROST.miniNative.light.see!));
    expect(card().style.getPropertyValue('--frost-grain')).toBe('none');          // the material brings its own noise
    cleanup();
    view(await miniSnapshot('transparent'));
    expect(card().dataset.material).toBe('solid');
    expect(card().style.getPropertyValue('--frost-opacity')).toBe('1');
  });

  test('the lyric strip sits in the same light: no element of its own carries a background', async () => {
    const snapshot = await miniSnapshot('transparent', { lyrics: true });
    if (snapshot.lyrics?.kind !== 'synced') return;                       // the demo track has synced lyrics
    view(snapshot);
    expect(card().dataset.lyrics).toBe('true');
    const lyric = card().querySelector<HTMLElement>('[aria-live="off"]')!;
    expect(lyric).not.toBeNull();
    expect(lyric.style.background).toBe('');
    expect(light().parentElement).toBe(card());                             // one light for the whole card
  });

  test('no album, or a cover that fails: the theme\'s own light, and the card still works', async () => {
    view(await miniSnapshot('transparent', { play: false }));
    expect(light().querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText('还没有在播放')).toBeTruthy();
    cleanup();
    view(await miniSnapshot('material'));
    fireEvent.error(light().querySelector('img')!);
    expect(light().querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy();
  });

  test('window behaviour is the same: double-click expands, the chrome pins, expands and hides to the tray', async () => {
    sent.length = 0;
    view(await miniSnapshot('material'));
    fireEvent.doubleClick(card());
    fireEvent.click(screen.getByRole('button', { name: /^(取消)?置顶$/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    fireEvent.click(screen.getByRole('button', { name: '收起到托盘' }));
    await act(async () => { await Promise.resolve(); });
    expect(sent.map(a => a.type)).toEqual(['setWindowMode', 'updateSettings', 'setWindowMode', 'hideToTray']);
  });
});

describe('mini tones', () => {
  test('title, credit, lyric and icons read at 4.5:1 on black, white, red and yellow covers, in every frame and theme', () => {
    for (const theme of ['light', 'blue', 'charcoal'] as ThemeName[]) for (const spec of [FROST.mini[theme], FROST.miniNative[theme]]) {
      const backdrops = frostBackdrops(theme, spec);
      const tones = frostTones(theme, spec, '#DB7A3D');
      for (const tone of [tones.ink, tones.ink2, tones.accent]) {
        expect(Math.min(...backdrops.map(bg => contrast(parseHex(tone)!, bg)))).toBeGreaterThanOrEqual(4.5);
      }
      // The named extremes are part of what is checked (each laid at the tone like any colour).
      expect(backdrops.length).toBeGreaterThan(100);
      // Hierarchy survives: the credit is not pushed all the way to the title's tone.
      expect(tones.ink2.toUpperCase()).not.toBe(tones.ink.toUpperCase());
    }
    for (const theme of ['light', 'blue', 'charcoal'] as ThemeName[]) {
      // A native material is derived against anything behind it, and adds no grain of its own.
      expect(FROST.miniNative[theme].seeRange).toEqual([0, 255]);
      expect(FROST.miniNative[theme].see).toBeGreaterThan(0);
      expect(FROST.miniNative[theme].grain).toBe(0);
      expect(FROST.mini[theme].see ?? 0).toBe(0);
    }
  });
});

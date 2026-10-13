/**
 * MV round (Claude): the player capsule is lit by the playing album from end to end, the way the
 * stage and the mini card already are — the cover's colour at the theme's tone over the whole bar,
 * its own light only round the thumbnail — and its text is still derived to read on any cover, over
 * whatever scrolls behind it. The stage and the mini card are untouched.
 */
import React, { useMemo, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { PlayerBridge, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { FROST, frostTones } from '../../src/ui/lib/frost.ts';

afterEach(cleanup);

/** Covers as inline images, so the light never depends on a file the test page cannot serve. */
const swatch = (fill: string) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60'><rect width='60' height='60' fill='${fill}'/></svg>`);
const COVERS: Record<string, string> = { 'album-blue': swatch('#2F80ED'), 'album-white': swatch('#F2F2EE') };
const inline = (snapshot: UISnapshot): UISnapshot => ({ ...snapshot, library: { ...snapshot.library, albums: snapshot.library.albums.map(a =>
  a.cover && COVERS[a.id] ? { ...a, cover: { ...a.cover, thumbUrl: COVERS[a.id], fullUrl: COVERS[a.id] } } : a) } });
function Live({ bridge }: { bridge: PlayerBridge }) {
  const raw = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const snapshot = useMemo(() => inline(raw), [raw]);
  return <PlayerUI snapshot={snapshot} surface="main" onAction={action => bridge.dispatch(action)} />;
}
const capsule = () => document.querySelector<HTMLElement>('[role="region"][aria-label="播放控制"]')!;
const light = () => capsule().querySelector<HTMLElement>('.cdp-frost')!;

describe('capsule light', () => {
  test('two layers of the playing cover, on the theme tone, with derived inks', async () => {
    const session = createMockSession({ autoTick: false });
    const bridge = session.connect('main');
    render(<Live bridge={bridge} />);
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
    const layers = [...light().querySelectorAll('img')];
    expect(layers.map(i => i.dataset.layer)).toEqual(['0', '1']);
    const cover = COVERS['album-blue'];
    expect(layers.every(i => i.getAttribute('src') === cover)).toBe(true);
    expect(light().getAttribute('aria-hidden')).toBe('true');
    const spec = FROST.capsule.light;
    expect(capsule().style.getPropertyValue('--frost-tone')).toBe(spec.tone);
    expect(capsule().style.getPropertyValue('--frost-field')).toBe(`${Math.round(spec.field * 100)}%`);
    expect(capsule().style.getPropertyValue('--ink-2')).toBe(frostTones('light', spec, bridge.getSnapshot().settings.accentColor).ink2);
    // Still lets a little of the shelf through.
    expect(capsule().classList.contains('glass--frost-see')).toBe(true);
    expect(capsule().style.getPropertyValue('--frost-opacity')).toBe(String(1 - spec.see!));
  });

  test('another album: the old cover is gone at once; no cover or a broken one: the theme light, nothing left over', async () => {
    const session = createMockSession({ autoTick: false });
    const bridge = session.connect('main');
    render(<Live bridge={bridge} />);
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
    const before = light().querySelector('img')!;
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-white' }); });
    const white = COVERS['album-white'];
    const now = [...light().querySelectorAll('img')];
    expect(now.map(i => i.getAttribute('src'))).toEqual([white, white]);
    expect(now.includes(before)).toBe(false);                  // a fresh element: the old pixels cannot linger
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-no-cover' }); });
    expect(light().querySelectorAll('img')).toHaveLength(0);
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
    expect(light().querySelectorAll('img')).toHaveLength(2);
    fireEvent.error(light().querySelector('img')!);
    expect(light().querySelectorAll('img')).toHaveLength(0);
    expect(capsule().querySelector('button[aria-label^="打开正在播放"]')).not.toBeNull();
  });
});

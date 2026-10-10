/**
 * V1.1 stage and wide windows (Claude): the stage's light comes in two layers of the same cover and
 * falls back to the theme when the image fails; the etching's cut follows the memorial switch; the
 * discs beside a wide shelf are decoration only and leave where they would crowd or confuse.
 */
import React from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import type { UIBoot } from '../../src/ui/lib/env.ts';
import { memorialPlatesPatch } from '../../src/ui/lib/memorial.ts';

afterEach(cleanup);

async function snapshotOf(play?: string, scenario?: 'empty'): Promise<UISnapshot> {
  const session = createMockSession({ autoTick: false, scenario });
  const bridge = session.connect('main');
  if (play) await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: play }); });
  const snapshot = bridge.getSnapshot();
  session.destroy();
  return snapshot;
}
const view = (snapshot: UISnapshot, boot: UIBoot = {}) =>
  render(<UIBootContext.Provider value={boot}><PlayerUI snapshot={snapshot} surface="main" onAction={async () => ({ ok: true, status: 'applied' })} /></UIBootContext.Provider>);
const stage = () => screen.getByRole('region', { name: '播放器里的专辑' });

describe('stage light', () => {
  test('two layers of the album\'s own cover, both dropped together if the image fails', async () => {
    view(await snapshotOf('album-blue'));
    const light = stage().querySelector('.cdp-frost')!;
    const layers = [...light.querySelectorAll('img')];
    expect(layers.map(i => i.dataset.layer)).toEqual(['0', '1']);
    expect(new Set(layers.map(i => i.getAttribute('src'))).size).toBe(1);
    expect(light.getAttribute('aria-hidden')).toBe('true');
    fireEvent.error(layers[0]);
    expect(light.querySelectorAll('img')).toHaveLength(0);       // the theme's own pools show instead
  });

  test('the stage carries its tone for the light, and the cut only with the etching', async () => {
    const snapshot = await snapshotOf('album-blue');
    const v = view(snapshot);
    expect(stage().style.getPropertyValue('--frost-tone')).toMatch(/^#[0-9A-F]{6}$/);
    expect(stage().dataset.etch).toBe('true');
    const off = { ...snapshot, settings: { ...snapshot.settings, ui: { ...snapshot.settings.ui, main: { ...snapshot.settings.ui.main, ...memorialPlatesPatch(false).ui!.main } } } };
    v.rerender(<UIBootContext.Provider value={{}}><PlayerUI snapshot={off} surface="main" onAction={async () => ({ ok: true, status: 'applied' })} /></UIBootContext.Provider>);
    expect(stage().dataset.etch).toBe('false');
    expect(stage().querySelector('[data-memorial]')).toBeNull();
  });
});

describe('wide shelf', () => {
  test('the discs at the sides are hidden from assistive technology and hold nothing to focus or click', async () => {
    const v = view(await snapshotOf('album-blue'));
    const sides = v.container.querySelector('[data-decor="sides"]')!;
    expect(sides).not.toBeNull();
    expect(sides.getAttribute('aria-hidden')).toBe('true');
    expect(sides.textContent).toBe('');
    expect(sides.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
  });

  test('not on an empty shelf, and not behind another page', async () => {
    const empty = view(await snapshotOf(undefined, 'empty'));
    expect(empty.container.querySelector('[data-decor="sides"]')).toBeNull();
    cleanup();
    const album = view(await snapshotOf(), { route: { name: 'album', albumId: 'album-blue' } });
    expect(album.container.querySelector('[data-decor="sides"]')).toBeNull();
  });
});

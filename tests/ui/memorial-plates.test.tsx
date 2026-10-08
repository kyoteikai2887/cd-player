/**
 * The memorial plates (Claude, core.27): the etching on the stage and the equipment plate in the
 * instrumental lyrics pane, and the switch that hides both (ui.main.memorialPlates).
 */
import React from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ActionResult, PlayerBridge, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import type { DemoScenario } from '../../src/mock/fixtures.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import type { UIBoot } from '../../src/ui/lib/env.ts';
import { MEMORIAL_PLATES_KEY, memorialPlatesPatch, showMemorialPlates } from '../../src/ui/lib/memorial.ts';
import { MATERIAL_THEME_KEY, themePatch } from '../../src/ui/lib/theme.ts';

afterEach(cleanup);

const withPlates = (snapshot: UISnapshot, value: unknown): UISnapshot => ({ ...snapshot, settings: { ...snapshot.settings,
  ui: { ...snapshot.settings.ui, main: { ...snapshot.settings.ui.main, [MEMORIAL_PLATES_KEY]: value as never } } } });

function view(snapshot: UISnapshot, boot: UIBoot = {}, onAction: (a: UIAction) => Promise<ActionResult> = async () => ({ ok: true, status: 'applied' })) {
  return render(<UIBootContext.Provider value={boot}><PlayerUI snapshot={snapshot} surface="main" onAction={onAction} /></UIBootContext.Provider>);
}
async function snapshotOf(scenario: DemoScenario, play?: string): Promise<{ snapshot: UISnapshot; done(): void }> {
  const session = createMockSession({ scenario, autoTick: false });
  const bridge: PlayerBridge = session.connect('main');
  if (play) await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: play }); });
  return { snapshot: bridge.getSnapshot(), done: () => session.destroy() };
}

describe('the setting', () => {
  test('absent shows the plates; only an explicit false hides them', () => {
    const base = { ui: { main: {}, mini: {} } } as unknown as Pick<UISnapshot['settings'], 'ui'>;
    expect(showMemorialPlates(base)).toBe(true);
    for (const [value, shown] of [[false, false], [true, true], [null, true], [0, true], ['no', true]] as const) {
      expect(showMemorialPlates({ ui: { ...base.ui, main: { [MEMORIAL_PLATES_KEY]: value } } } as never)).toBe(shown);
    }
    expect(memorialPlatesPatch(false)).toEqual({ ui: { main: { memorialPlates: false } } });
  });

  test('through the shared core the switch keeps the other ui.main keys', async () => {
    const session = createMockSession({ autoTick: false });
    const main = session.connect('main');
    try {
      await main.dispatch({ type: 'updateSettings', patch: themePatch('charcoal') });
      await main.dispatch({ type: 'updateSettings', patch: memorialPlatesPatch(false) });
      expect(main.getSnapshot().settings.ui.main).toMatchObject({ [MATERIAL_THEME_KEY]: 'charcoal', [MEMORIAL_PLATES_KEY]: false });
      await main.dispatch({ type: 'updateSettings', patch: memorialPlatesPatch(true) });
      expect(main.getSnapshot().settings.ui.main).toMatchObject({ [MATERIAL_THEME_KEY]: 'charcoal', [MEMORIAL_PLATES_KEY]: true });
    } finally { session.destroy(); }
  });

  test('the settings switch sends one local patch each way', async () => {
    const { snapshot, done } = await snapshotOf('default');
    const sent: UIAction[] = [];
    const onAction = async (a: UIAction): Promise<ActionResult> => { sent.push(a); return { ok: true, status: 'applied' }; };
    try {
      const v = view(snapshot, { overlay: 'settings' }, onAction);
      const sw = screen.getByRole('switch', { name: '纪念铭牌' });
      expect(sw.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(sw);
      v.rerender(<UIBootContext.Provider value={{ overlay: 'settings' }}><PlayerUI snapshot={withPlates(snapshot, false)} surface="main" onAction={onAction} /></UIBootContext.Provider>);
      const off = screen.getByRole('switch', { name: '纪念铭牌' });
      expect(off.getAttribute('aria-checked')).toBe('false');
      fireEvent.click(off);
      const patches = sent.filter((a): a is Extract<UIAction, { type: 'updateSettings' }> => a.type === 'updateSettings').map(a => a.patch);
      expect(patches).toEqual([memorialPlatesPatch(false), memorialPlatesPatch(true)]);
    } finally { done(); }
  });
});

describe('the stage etching', () => {
  test('sits in the stage, hidden from assistive technology, and goes with the switch', async () => {
    const { snapshot, done } = await snapshotOf('default', 'album-blue');
    try {
      const v = view(snapshot);
      const stage = screen.getByRole('region', { name: '播放器里的专辑' });
      const etch = stage.querySelector('[data-memorial="etch"]');
      expect(etch).not.toBeNull();
      expect(etch!.getAttribute('aria-hidden')).toBe('true');
      expect(etch!.textContent).toBe('');
      v.rerender(<UIBootContext.Provider value={{}}><PlayerUI snapshot={withPlates(snapshot, false)} surface="main" onAction={async () => ({ ok: true, status: 'applied' })} /></UIBootContext.Provider>);
      expect(screen.getByRole('region', { name: '播放器里的专辑' }).querySelector('[data-memorial]')).toBeNull();
    } finally { done(); }
  });
});

describe('the plate in the lyrics pane', () => {
  test('takes the icon\'s place for an instrumental track; the words stay', async () => {
    const { snapshot, done } = await snapshotOf('instrumental');
    try {
      const v = view(snapshot, { route: { name: 'nowPlaying' } });
      const plate = v.container.querySelector('[data-memorial="plate"]');
      expect(plate).not.toBeNull();
      expect(plate!.getAttribute('aria-hidden')).toBe('true');
      const quiet = plate!.parentElement!;
      expect(within(quiet).getByText('纯音乐')).toBeTruthy();
      expect(within(quiet).getByText('这首被标记为纯音乐，没有歌词。')).toBeTruthy();
      expect(quiet.querySelector('svg')).toBeNull();                       // no icon beside the plate
    } finally { done(); }
  });

  test('switched off, the instrumental state is the plain icon again', async () => {
    const { snapshot, done } = await snapshotOf('instrumental');
    try {
      const v = view(withPlates(snapshot, false), { route: { name: 'nowPlaying' } });
      expect(v.container.querySelector('[data-memorial]')).toBeNull();
      const title = screen.getAllByText('纯音乐').find(el => el.tagName === 'P')!;
      expect(title.parentElement!.querySelector('svg')).not.toBeNull();
    } finally { done(); }
  });

  test('spoken and missing lyrics never show it', async () => {
    for (const scenario of ['spoken', 'missing'] as DemoScenario[]) {
      const { snapshot, done } = await snapshotOf(scenario);
      try {
        const v = view(snapshot, { route: { name: 'nowPlaying' } });
        expect(v.container.querySelector('[data-memorial="plate"]')).toBeNull();
      } finally { cleanup(); done(); }
    }
  });
});

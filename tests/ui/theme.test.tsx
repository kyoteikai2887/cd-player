import React from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActionResult, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import { crystalVars } from '../../src/ui/lib/crystal.ts';
import { MATERIAL_THEME_KEY, resolveTheme, themePatch } from '../../src/ui/lib/theme.ts';

afterEach(cleanup);

const settings = (background: 'light' | 'blue', main: Record<string, string> = {}, mini: Record<string, string> = {}) =>
  ({ background, ui: { main, mini } });

describe('theme selection (settings.ui.main.materialTheme, no contract change)', () => {
  test('legacy settings without the key follow background', () => {
    expect(resolveTheme(settings('light'))).toBe('light');
    expect(resolveTheme(settings('blue'))).toBe('blue');
    expect(resolveTheme({ background: 'blue', ui: { main: undefined as never, mini: {} } })).toBe('blue');
  });
  test("'standard' follows background; 'charcoal' wins over either background", () => {
    expect(resolveTheme(settings('blue', { [MATERIAL_THEME_KEY]: 'standard' }))).toBe('blue');
    expect(resolveTheme(settings('light', { [MATERIAL_THEME_KEY]: 'charcoal' }))).toBe('charcoal');
    expect(resolveTheme(settings('blue', { [MATERIAL_THEME_KEY]: 'charcoal' }))).toBe('charcoal');
  });
  test('unknown values and a key stored under ui.mini are ignored', () => {
    expect(resolveTheme(settings('blue', { [MATERIAL_THEME_KEY]: 'neon' }))).toBe('blue');
    expect(resolveTheme(settings('light', {}, { [MATERIAL_THEME_KEY]: 'charcoal' }))).toBe('light');
  });
  test('one patch per choice: charcoal keeps background, paper/blue reset the key to standard', () => {
    expect(themePatch('charcoal')).toEqual({ ui: { main: { [MATERIAL_THEME_KEY]: 'charcoal' } } });
    expect(themePatch('light')).toEqual({ background: 'light', ui: { main: { [MATERIAL_THEME_KEY]: 'standard' } } });
    expect(themePatch('blue')).toEqual({ background: 'blue', ui: { main: { [MATERIAL_THEME_KEY]: 'standard' } } });
  });
});

describe('crystal controls follow the theme and the accent (core.23)', () => {
  test('the memorial look is charcoal with an orange accent; a colour the user picks drives the crystal the same way', async () => {
    const session = createMockSession({ autoTick: false });
    const main = session.connect('main');
    try {
      await main.dispatch({ type: 'updateSettings', patch: { ...themePatch('charcoal'), accentColor: '#DB7A3D' } });
      const view = render(<PlayerUI snapshot={main.getSnapshot()} surface="main" onAction={main.dispatch} />);
      const root = () => view.container.querySelector('.cdp') as HTMLElement;
      expect(root().getAttribute('data-theme')).toBe('charcoal');
      expect(root().style.getPropertyValue('--crystal-tint')).toBe('70%');
      expect(root().style.getPropertyValue('--crystal-glyph')).toBe('#F2F6FB');
      expect(root().style.getPropertyValue('--crystal-filter')).toBe(crystalVars('#DB7A3D', 'charcoal')['--crystal-filter']);
      await main.dispatch({ type: 'updateSettings', patch: { ...themePatch('light'), accentColor: '#2F80ED' } });
      view.rerender(<PlayerUI snapshot={main.getSnapshot()} surface="main" onAction={main.dispatch} />);
      const expected = crystalVars('#2F80ED', 'light');
      expect(root().style.getPropertyValue('--crystal-tint')).toBe(expected['--crystal-tint']);
      expect(root().style.getPropertyValue('--crystal-glyph')).toBe(expected['--crystal-glyph']);
    } finally { session.destroy(); }
  });
});

describe('main and mini always share one theme', () => {
  test('through the shared core, other ui.main keys survive and both surfaces switch together', async () => {
    const session = createMockSession({ autoTick: false });
    const main = session.connect('main'), mini = session.connect('mini');
    try {
      await main.dispatch({ type: 'updateSettings', patch: { background: 'blue', ui: { main: { sort: 'title', libraryTab: 'works' } } } });
      await main.dispatch({ type: 'updateSettings', patch: themePatch('charcoal') });
      const after = main.getSnapshot().settings;
      expect(after.background).toBe('blue');
      expect(after.ui.main).toEqual({ sort: 'title', libraryTab: 'works', [MATERIAL_THEME_KEY]: 'charcoal' });
      const view = render(<>
        <PlayerUI snapshot={main.getSnapshot()} surface="main" onAction={main.dispatch} />
        <PlayerUI snapshot={mini.getSnapshot()} surface="mini" onAction={mini.dispatch} />
      </>);
      const themes = () => [...view.container.querySelectorAll('.cdp')].map(el => el.getAttribute('data-theme'));
      expect(themes()).toEqual(['charcoal', 'charcoal']);
      await mini.dispatch({ type: 'updateSettings', patch: themePatch('blue') });
      view.rerender(<>
        <PlayerUI snapshot={main.getSnapshot()} surface="main" onAction={main.dispatch} />
        <PlayerUI snapshot={mini.getSnapshot()} surface="mini" onAction={mini.dispatch} />
      </>);
      expect(themes()).toEqual(['blue', 'blue']);
      expect(main.getSnapshot().settings.ui.main.sort).toBe('title');
    } finally { session.destroy(); }
  });

  test('the settings sheet sends exactly the agreed patch and nothing for the current theme', async () => {
    const session = createMockSession({ autoTick: false });
    const bridge = session.connect('main');
    const sent: UIAction[] = [];
    const onAction = async (action: UIAction): Promise<ActionResult> => { sent.push(action); return { ok: true, status: 'applied' }; };
    try {
      const snapshot: UISnapshot = bridge.getSnapshot();
      render(<UIBootContext.Provider value={{ overlay: 'settings' }}>
        <PlayerUI snapshot={snapshot} surface="main" onAction={onAction} />
      </UIBootContext.Provider>);
      fireEvent.click(screen.getByRole('button', { name: '纸白' }));
      expect(sent.filter(a => a.type === 'updateSettings')).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: '灰黑' }));
      fireEvent.click(screen.getByRole('button', { name: '阿根廷蓝' }));
      const patches = sent.filter((a): a is Extract<UIAction, { type: 'updateSettings' }> => a.type === 'updateSettings').map(a => a.patch);
      expect(patches).toEqual([themePatch('charcoal'), themePatch('blue')]);
    } finally { session.destroy(); }
  });
});

import React from 'react';
import { afterEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PlayerBridge } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import type { DemoScenario } from '../../src/mock/fixtures.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';

afterEach(cleanup);

/** Renders the now-playing view straight from a mock bridge snapshot (no auto clock). */
function nowPlaying(bridge: PlayerBridge) {
  const ui = () => (
    <UIBootContext.Provider value={{ route: { name: 'nowPlaying' } }}>
      <PlayerUI snapshot={bridge.getSnapshot()} surface="main" onAction={bridge.dispatch} />
    </UIBootContext.Provider>
  );
  const view = render(ui());
  return { ...view, refresh: () => view.rerender(ui()) };
}
function session(scenario: DemoScenario) {
  const s = createMockSession({ scenario, autoTick: false });
  return { s, bridge: s.connect('main') };
}

test('a timed blank line clears the highlight instead of keeping the previous line', async () => {
  const { s, bridge } = session('break');
  try {
    const view = nowPlaying(bridge);
    expect(view.container.querySelectorAll('[aria-current="true"]').length).toBe(1);
    await bridge.dispatch({ type: 'seek', positionMs: 2500 });
    view.refresh();
    expect(view.container.querySelectorAll('[aria-current="true"]').length).toBe(0);
    await bridge.dispatch({ type: 'seek', positionMs: 4200 });
    view.refresh();
    const current = view.container.querySelectorAll('[aria-current="true"]');
    expect(current.length).toBe(1);
    expect(current[0].textContent).toContain('新しい朝');
    // Bilingual mode without any translation keeps the original and says so once.
    expect(screen.getAllByText('暂无中文翻译，先显示原文').length).toBe(1);
  } finally { s.destroy(); }
});

test('instrumental, spoken and missing are distinct, calm states', () => {
  const cases: [DemoScenario, string][] = [['instrumental', '纯音乐'], ['spoken', '念白'], ['missing', '暂无歌词']];
  for (const [scenario, title] of cases) {
    const { s, bridge } = session(scenario);
    try {
      nowPlaying(bridge);
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
      if (scenario !== 'missing') expect(screen.queryByText('暂无歌词')).toBeNull();
    } finally { cleanup(); s.destroy(); }
  }
});

test('quick offset is disabled while the same track is open in the lyrics editor', async () => {
  const { s, bridge } = session('default');
  try {
    await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' });
    await bridge.dispatch({ type: 'togglePlayback' });
    const view = nowPlaying(bridge);
    expect((screen.getByRole('button', { name: '歌词延后 0.1 秒' }) as HTMLButtonElement).disabled).toBe(false);
    await bridge.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    view.refresh();
    expect((screen.getByRole('button', { name: '歌词延后 0.1 秒' }) as HTMLButtonElement).disabled).toBe(true);
  } finally { s.destroy(); }
});

test('the sung line is marked on the line itself; there is no separate box element behind it', async () => {
  const { s, bridge } = session('default');
  try {
    await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' });
    await bridge.dispatch({ type: 'seek', positionMs: 20000 });
    const view = nowPlaying(bridge);
    const current = view.container.querySelectorAll('li[aria-current="true"]');
    expect(current.length).toBe(1);
    expect(current[0].getAttribute('data-state')).toBe('active');
    // Every child of the synced list is a lyric line (or a blank break); nothing is layered behind them.
    const list = current[0].parentElement!;
    expect(list.previousElementSibling).toBeNull();
    expect([...list.children].every(li => li.tagName === 'LI')).toBe(true);
    // Clicking another line seeks to it and that line becomes the marked one.
    expect(current[0].textContent).toContain('小さな光を手にのせて');
    const next = list.querySelector('li[data-state="future"] button') as HTMLButtonElement;
    await act(async () => { fireEvent.click(next); await new Promise(resolve => setTimeout(resolve, 0)); });
    view.refresh();
    expect(next.closest('li')!.getAttribute('aria-current')).toBe('true');
    expect(view.container.querySelectorAll('li[aria-current="true"]').length).toBe(1);
  } finally { s.destroy(); }
});

/**
 * Lyrics editor against the DemoBridge (Claude, R2). The editor keeps its draft in UI state; these
 * tests drive it the way a user would and check what reaches the core and what stays a draft.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionResult, PlayerBridge, UIAction } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import type { MockOptions } from '../../src/mock/createMockBridge.ts';
import { App } from '../../src/app/App.tsx';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import type { UIBoot } from '../../src/ui/lib/env.ts';

afterEach(cleanup);

function Live({ bridge, log, boot = {} }: { bridge: PlayerBridge; log: UIAction[]; boot?: UIBoot }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const onAction = useCallback((action: UIAction): Promise<ActionResult> => { log.push(action); return bridge.dispatch(action); }, [bridge, log]);
  return <UIBootContext.Provider value={boot}><PlayerUI snapshot={snapshot} surface="main" onAction={onAction} /></UIBootContext.Provider>;
}

/** One simulated core, the main surface rendered live, and a second connection acting as "elsewhere". */
function setup(options: MockOptions = {}, boot?: UIBoot) {
  const session = createMockSession({ autoTick: false, taskDelayMs: 0, ...options });
  const bridge = session.connect('main'), elsewhere = session.connect('mini');
  const log: UIAction[] = [];
  render(<Live bridge={bridge} log={log} boot={boot} />);
  const core = async (action: UIAction) => { let result!: ActionResult; await act(async () => { result = await elsewhere.dispatch(action); }); return result; };
  const reports = () => log.filter((a): a is Extract<UIAction, { type: 'reportUnsavedChanges' }> => a.type === 'reportUnsavedChanges').map(a => a.dirty);
  const doc = (trackId: string) => {
    const s = bridge.getSnapshot();
    return s.lyricsEditor?.trackId === trackId && s.lyricsEditor.document ? s.lyricsEditor.document : null;
  };
  return { session, bridge, log, core, reports, doc };
}
const open = async (core: (a: UIAction) => Promise<ActionResult>, trackId: string) => {
  await core({ type: 'openLyricsEditor', trackId });
  return screen.findByRole('dialog', { name: '歌词编辑' });
};
const text = (name: string) => screen.getByRole('textbox', { name }) as HTMLTextAreaElement | HTMLInputElement;
const type = (name: string, value: string) => fireEvent.change(text(name), { target: { value } });
const setTime = (line: number, value: string) => {
  const field = text(`第 ${line} 行时间`);
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
};
const click = (name: string | RegExp, role = 'button') => fireEvent.click(screen.getByRole(role, { name }));

describe('lyrics editor: unsaved drafts', () => {
  test('editing reports unsaved work once; saving sends the base revision and settles it', async () => {
    const { session, log, core, reports, doc } = setup();
    try {
      await open(core, 'track-blue');
      const before = doc('track-blue')!;
      type('第 3 行原文', '今日のページをひらこう');
      type('第 3 行译文', '翻开属于今天的这一页');
      await waitFor(() => expect(reports()).toEqual([true]));
      expect(screen.getByText('有未保存的修改')).toBeTruthy();

      fireEvent.keyDown(screen.getByRole('dialog', { name: '歌词编辑' }), { key: 's', ctrlKey: true });
      await waitFor(() => expect(reports()).toEqual([true, false]));
      const save = log.find(a => a.type === 'saveLyrics') as Extract<UIAction, { type: 'saveLyrics' }>;
      expect(save.baseRevision).toBe(before.revision);
      const saved = doc('track-blue')!;
      expect(saved.revision).toBe(before.revision + 1);
      expect(saved.lines[2]).toMatchObject({ original: '今日のページをひらこう', translation: '翻开属于今天的这一页' });
      expect(text('第 3 行原文').value).toBe('今日のページをひらこう');
    } finally { session.destroy(); }
  });

  test('closing with changes asks first; discarding keeps the saved lyrics as they were', async () => {
    const { session, log, core, reports, doc } = setup();
    try {
      await open(core, 'track-blue');
      const before = doc('track-blue')!;
      type('第 1 行原文', '書きかけ');
      click('关闭歌词编辑');
      expect(screen.getByRole('alertdialog', { name: '未保存的修改' })).toBeTruthy();
      click('继续编辑');
      expect(text('第 1 行原文').value).toBe('書きかけ');
      click('关闭歌词编辑');
      click('放弃修改');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '歌词编辑' })).toBeNull());
      expect(log.some(a => a.type === 'saveLyrics')).toBe(false);
      await waitFor(() => expect(reports()).toEqual([true, false]));
      await open(core, 'track-blue');
      expect(text('第 1 行原文').value).toBe(before.lines[0].original);
    } finally { session.destroy(); }
  });

  test('playback samples, settings and a newer saved version never overwrite the draft', async () => {
    const { session, bridge, core } = setup();
    try {
      await core({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' });
      await open(core, 'track-blue');
      type('第 2 行原文', '手のひらの光');
      await act(async () => { session.advanceBy(4000); session.advanceBy(4000); });
      await core({ type: 'updateSettings', patch: { lyricsScale: 1.2 } });
      expect(text('第 2 行原文').value).toBe('手のひらの光');
      // Someone else saves a new offset; reopening publishes that newer document to the editor.
      const revision = bridge.getSnapshot().lyricsEditor!.document!.revision;
      await core({ type: 'setLyricsOffset', trackId: 'track-blue', baseRevision: revision, offsetMs: 400 });
      await core({ type: 'openLyricsEditor', trackId: 'track-blue' });
      expect(text('第 2 行原文').value).toBe('手のひらの光');
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText('与最新版本有冲突')).toBeTruthy();
    } finally { session.destroy(); }
  });
});

describe('lyrics editor: times, breaks and offset', () => {
  test('times are edited as heard; negative times and breaks are saved as such', async () => {
    const { session, core, doc } = setup();
    try {
      await open(core, 'track-blue');
      // Offset +0.3 s: the field shows startMs + offset and saves effective − offset.
      for (let i = 0; i < 3; i++) click('歌词整体延后 0.1 秒');
      expect(text('第 1 行时间').value).toBe('0:12.30');
      setTime(1, '-0:00.50');
      setTime(3, '0:26.00');
      type('第 2 行原文', '');                       // a timed empty line is a break
      type('第 2 行译文', '');
      const start = doc('track-blue')!.revision;
      click('保存');
      await waitFor(() => expect(doc('track-blue')!.revision).toBe(start + 1));
      const lines = doc('track-blue')!.lines;
      expect(doc('track-blue')!.offsetMs).toBe(300);
      expect(lines[0].startMs).toBe(-800);
      expect(lines[1]).toMatchObject({ startMs: 19500, original: '' });
      expect(lines[2].startMs).toBe(25700);
    } finally { session.destroy(); }
  });

  test('merging the offset keeps every heard time and sets the offset to zero', async () => {
    const { session, core } = setup();
    try {
      await open(core, 'track-blue');
      click('歌词整体提前 0.1 秒'); click('歌词整体提前 0.1 秒');
      expect(text('第 1 行时间').value).toBe('0:11.80');
      click(/合并到时间轴/);
      expect(text('第 1 行时间').value).toBe('0:11.80');
      expect(screen.queryByRole('button', { name: /合并到时间轴/ })).toBeNull();
    } finally { session.destroy(); }
  });

  test('a time out of order is marked on its line and blocks saving', async () => {
    const { session, log, core } = setup();
    try {
      const dialog = await open(core, 'track-blue');
      setTime(5, '0:30.00');
      const row = dialog.querySelector('[data-invalid="true"]');
      expect(row?.getAttribute('data-line-id')).toBeTruthy();
      expect(within(row as HTMLElement).getByText('歌词时间必须升序排列。')).toBeTruthy();
      click('保存');
      await new Promise(r => setTimeout(r, 30));
      expect(log.some(a => a.type === 'saveLyrics')).toBe(false);
    } finally { session.destroy(); }
  });
});

describe('lyrics editor: tap timing', () => {
  test('a tap records the heard position minus the offset and moves to the next line', async () => {
    const { session, core, bridge } = setup();
    try {
      await core({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' });
      await core({ type: 'togglePlayback' });
      await core({ type: 'seek', positionMs: 30000 });
      expect(bridge.getSnapshot().player.status).toBe('paused');
      const dialog = await open(core, 'track-blue');
      click('歌词整体延后 0.1 秒');
      click('打轴');
      click('从第 4 行开始打轴');
      click(/^打点/);
      expect(text('第 4 行时间').value).toBe('0:30.00');           // heard time
      expect(screen.getByRole('button', { name: '从第 5 行开始打轴' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.keyDown(dialog, { key: 'z', ctrlKey: true });
      expect(text('第 4 行时间').value).toBe('0:34.60');           // 34.50 + 0.1 offset, as before the tap
    } finally { session.destroy(); }
  });

  test('the “being sung” mark follows playback and clears when this track stops being the current one', async () => {
    const { session, core } = setup();
    try {
      await core({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' });
      await core({ type: 'togglePlayback' });
      await core({ type: 'seek', positionMs: 30000 });
      const dialog = await open(core, 'track-blue');
      await waitFor(() => expect(dialog.querySelectorAll('[data-playing="true"]')).toHaveLength(1));
      await core({ type: 'playAlbum', albumId: 'album-white', startTrackId: 'track-plain' });
      await waitFor(() => expect(dialog.querySelectorAll('[data-playing="true"]')).toHaveLength(0));
    } finally { session.destroy(); }
  });

  test('timing a track that is not playing asks to play it; opening never changes the track', async () => {
    const { session, log, core, bridge } = setup();
    try {
      await core({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' });
      await open(core, 'track-plain');
      expect(bridge.getSnapshot().player.currentTrackId).toBe('track-blue');
      click('同步');
      expect(screen.getByRole('button', { name: /^打点/ }).hasAttribute('disabled')).toBe(true);
      expect(log.some(a => a.type === 'playAlbum')).toBe(false);
      click(/^播放这首$/);
      await waitFor(() => expect(bridge.getSnapshot().player.currentTrackId).toBe('track-plain'));
      expect(log.find(a => a.type === 'playAlbum')).toMatchObject({ albumId: 'album-white', startTrackId: 'track-plain' });
    } finally { session.destroy(); }
  });
});

describe('lyrics editor: imports into the draft', () => {
  function deferredImports() {
    const waiting: ((text: string | null) => void)[] = [];
    const importText: MockOptions['importText'] = () => new Promise(resolve => { waiting.push(resolve); });
    return { importText, next: async (text: string | null) => { await waitFor(() => expect(waiting.length).toBeGreaterThan(0)); await act(async () => { waiting.shift()!(text); }); } };
  }
  const importMenu = (item: string) => { click('导入'); click(item, 'menuitem'); };

  test('a translation pairs with the draft as it is when the file arrives, with warnings; nothing is saved', async () => {
    const imports = deferredImports();
    const { session, core, log, doc } = setup({ importText: imports.importText });
    try {
      await open(core, 'track-blue');
      const revision = doc('track-blue')!.revision;
      importMenu('导入译文…');
      const request = log.find(a => a.type === 'importLyrics') as Extract<UIAction, { type: 'importLyrics' }>;
      expect(request).toMatchObject({ destination: 'editorDraft', baseRevision: revision, content: 'translation' });
      type('第 1 行原文', '窓の外の青い空');                       // the draft changes while the file is read
      await imports.next('[00:12.00]窗外的蓝天\n[00:19.55]手心里的光\n[00:40.00]多出来的一行');
      await waitFor(() => expect(text('第 1 行译文').value).toBe('窗外的蓝天'));
      expect(text('第 1 行原文').value).toBe('窓の外の青い空');
      expect(text('第 2 行译文').value).toBe('手心里的光');           // within the 0.1 s tolerance
      expect(text('第 3 行译文').value).toBe('');                      // old translations are replaced, not kept
      const note = screen.getByRole('alert');                          // paired with a warning
      expect(note.textContent).toContain('已按时间配对 2 行译文。');
      expect(note.textContent).toContain('1 行译文无法安全配对');
      expect(doc('track-blue')!.revision).toBe(revision);
      // The same pending import arriving again (any later snapshot) is not applied twice.
      type('第 1 行译文', '我改过的译文');
      await core({ type: 'updateSettings', patch: { lyricsScale: 1.1 } });
      expect(text('第 1 行译文').value).toBe('我改过的译文');
    } finally { session.destroy(); }
  });

  test('an original import replaces the body and keeps translations where times meet; bilingual replaces both', async () => {
    const imports = deferredImports();
    const { session, core } = setup({ importText: imports.importText });
    try {
      await open(core, 'track-blue');
      importMenu('导入原文…');
      await imports.next('[00:12.00]新しい一行目\n[00:20.00]新しい二行目');
      await waitFor(() => expect(text('第 1 行原文').value).toBe('新しい一行目'));
      expect(text('第 1 行译文').value).toBe('窗外是一片蓝色天空');
      expect(screen.queryByRole('textbox', { name: '第 3 行原文' })).toBeNull();

      importMenu('导入双语 LRC…');
      await imports.next('[00:05.00]ことば\n[00:05.00]话语');
      await waitFor(() => expect(text('第 1 行原文').value).toBe('ことば'));
      expect(text('第 1 行译文').value).toBe('话语');
      expect(screen.queryByRole('textbox', { name: '第 2 行原文' })).toBeNull();
    } finally { session.destroy(); }
  });

  test('untimed translation text is aligned by line only after an explicit confirmation', async () => {
    const imports = deferredImports();
    const { session, core } = setup({ importText: imports.importText });
    try {
      await open(core, 'track-plain');
      importMenu('导入译文…');
      await imports.next('找到了白色的路\n还没有名字的早晨\n慢慢走吧');
      await screen.findByText('原文或译文没有时间，无法按时间配对。可以确认后按行对齐。');
      expect(screen.queryByRole('textbox', { name: '第 1 行译文' })).toBeNull();
      click('按行对齐…');
      click('按行对齐');
      await waitFor(() => expect(text('第 1 行译文').value).toBe('找到了白色的路'));
      expect(text('第 3 行译文').value).toBe('慢慢走吧');
    } finally { session.destroy(); }
  });
});

describe('lyrics editor: conflicts', () => {
  test('a conflict keeps the draft; compare shows the difference; overwriting conflicts again until it is current', async () => {
    const { session, bridge, core, log, doc } = setup();
    try {
      await open(core, 'track-blue');
      const start = doc('track-blue')!.revision;
      type('第 3 行原文', '今日のページをひらこう');
      await core({ type: 'setLyricsOffset', trackId: 'track-blue', baseRevision: start, offsetMs: 200 });
      click('保存');
      await screen.findByText('与最新版本有冲突');
      expect(text('第 3 行原文').value).toBe('今日のページをひらこう');
      expect(screen.getAllByRole('alert')).toHaveLength(1);          // the bar, not a second error

      click(/比较/);
      const table = screen.getByRole('table');
      expect(within(table).getByText('今日のページを開こう')).toBeTruthy();
      expect(within(table).getByText('今日のページをひらこう')).toBeTruthy();
      expect(screen.getByText('偏移')).toBeTruthy();
      click('返回草稿');

      // Another save lands after the user has chosen the version to overwrite, but
      // before confirming. R2-1 now publishes that saved version immediately.
      click('用草稿覆盖…');
      await core({ type: 'setLyricsOffset', trackId: 'track-blue', baseRevision: start + 1, offsetMs: 400 });
      click('用草稿覆盖');
      await waitFor(() => expect(log.filter(a => a.type === 'saveLyrics')).toHaveLength(2));
      expect((log.filter(a => a.type === 'saveLyrics')[1] as Extract<UIAction, { type: 'saveLyrics' }>).baseRevision).toBe(start + 1);
      await waitFor(() => expect(bridge.getSnapshot().lyricsEditor!.document!.revision).toBe(start + 2));
      expect(text('第 3 行原文').value).toBe('今日のページをひらこう');   // second conflict: still the draft
      click('用草稿覆盖…');
      click('用草稿覆盖');
      await waitFor(() => expect(doc('track-blue')!.revision).toBe(start + 3));
      expect(doc('track-blue')!.lines[2].original).toBe('今日のページをひらこう');
      expect(screen.queryByText('与最新版本有冲突')).toBeNull();
    } finally { session.destroy(); }
  });

  test('loading the latest replaces the draft only after confirming', async () => {
    const { session, core, doc } = setup();
    try {
      await open(core, 'track-blue');
      type('第 1 行原文', '草稿');
      await core({ type: 'setLyricsOffset', trackId: 'track-blue', baseRevision: doc('track-blue')!.revision, offsetMs: 500 });
      click('保存');
      await screen.findByText('与最新版本有冲突');
      click('载入最新…');
      expect(text('第 1 行原文').value).toBe('草稿');
      click('载入最新');
      await waitFor(() => expect(text('第 1 行原文').value).toBe('窓の向こうに青い空'));
      expect(text('第 1 行时间').value).toBe('0:12.50');
      expect(screen.queryByText('与最新版本有冲突')).toBeNull();
    } finally { session.destroy(); }
  });
});

describe('lyrics editor: around the editor', () => {
  test('the quick offset in now playing is disabled while this track is being edited', async () => {
    const { session, core } = setup({}, { route: { name: 'nowPlaying' } });
    try {
      await core({ type: 'playAlbum', albumId: 'album-blue', startTrackId: 'track-blue' });
      const quick = await screen.findByRole('button', { name: '歌词延后 0.1 秒' });
      expect(quick.hasAttribute('disabled')).toBe(false);
      await open(core, 'track-blue');
      expect(screen.getByRole('button', { name: '歌词延后 0.1 秒' }).hasAttribute('disabled')).toBe(true);
      click('完成');
      await waitFor(() => expect(screen.getByRole('button', { name: '歌词延后 0.1 秒' }).hasAttribute('disabled')).toBe(false));
    } finally { session.destroy(); }
  });

  test('switching the editing target keeps the unsaved draft aside, still dirty, and offers it back', async () => {
    const { session, core, reports } = setup();
    try {
      await open(core, 'track-blue');
      type('第 1 行原文', '置いていかれた草稿');
      await core({ type: 'openLyricsEditor', trackId: 'track-plain' });
      await screen.findByRole('heading', { name: '白い軌道' });
      expect(screen.getByText('“窓辺の青”')).toBeTruthy();
      expect(reports()).toEqual([true]);
      click('切换过去');
      await screen.findByRole('heading', { name: '窓辺の青' });
      expect(text('第 1 行原文').value).toBe('置いていかれた草稿');
      expect(screen.getByText('有未保存的修改')).toBeTruthy();
      click('关闭歌词编辑');
      click('放弃修改');
      await waitFor(() => expect(reports()).toEqual([true, false]));
    } finally { session.destroy(); }
  });

  test('a set-aside draft can be dropped from the other editor', async () => {
    const { session, core, reports } = setup();
    try {
      await open(core, 'track-blue');
      type('第 1 行原文', '不要的草稿');
      await core({ type: 'openLyricsEditor', trackId: 'track-plain' });
      await screen.findByRole('heading', { name: '白い軌道' });
      click('放弃那份');
      await waitFor(() => expect(reports()).toEqual([true, false]));
      await core({ type: 'openLyricsEditor', trackId: 'track-blue' });
      await waitFor(() => expect(text('第 1 行原文').value).toBe('窓の向こうに青い空'));
    } finally { session.destroy(); }
  });

  test('a hidden main window keeps its draft, and quitting asks while it is unsaved', async () => {
    const session = createMockSession({ autoTick: false });
    const main = session.connect('main'), mini = session.connect('mini');
    try {
      const { container } = render(<App main={main} mini={mini} />);
      await act(async () => { await main.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' }); });
      await screen.findByRole('dialog', { name: '歌词编辑' });
      type('第 1 行原文', '隠れても残る');
      await act(async () => { await mini.dispatch({ type: 'setWindowMode', mode: 'mini' }); });
      await waitFor(() => expect(container.querySelector('[data-surface="main"]')?.hasAttribute('hidden')).toBe(true));
      expect(await session.requestExit(async () => false)).toBe(false);
      await act(async () => { await mini.dispatch({ type: 'setWindowMode', mode: 'full' }); });
      await waitFor(() => expect(container.querySelector('[data-surface="main"]')?.hasAttribute('hidden')).toBe(false));
      expect(text('第 1 行原文').value).toBe('隠れても残る');
      expect(await session.requestExit(async () => true)).toBe(true);
    } finally { session.destroy(); }
  });

  test('marking as instrumental goes through setNoLyrics and keeps the text for undoing the mark', async () => {
    const { session, core, log, doc } = setup();
    try {
      await open(core, 'track-blue');
      fireEvent.click(screen.getByRole('button', { name: '更多歌词操作' }));
      fireEvent.click(screen.getByRole('menuitem', { name: '标记为纯音乐' }));
      await screen.findByText('这首已标记为纯音乐。保存歌词会取消这个标记。');
      expect(log.find(a => a.type === 'setNoLyrics')).toMatchObject({ trackId: 'track-blue', kind: 'instrumental' });
      expect(doc('track-blue')!.kind).toBe('instrumental');
      expect(text('第 1 行原文').value).toBe('窓の向こうに青い空');
      click('取消标记');
      await waitFor(() => expect(doc('track-blue')!.kind).toBe('synced'));
      expect(log.some(a => a.type === 'saveLyrics')).toBe(false);
    } finally { session.destroy(); }
  });

  test('a cancelled file choice is quiet and leaves the draft alone', async () => {
    const { session, core } = setup({ importText: async () => null });
    try {
      await open(core, 'track-blue');
      type('第 1 行原文', '草稿のまま');
      click('导入');
      click('导入译文…', 'menuitem');
      await new Promise(r => setTimeout(r, 60));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(text('第 1 行原文').value).toBe('草稿のまま');
      expect(text('第 1 行译文').value).toBe('窗外是一片蓝色天空');
    } finally { session.destroy(); }
  });

  test('clearing is missing with no lines, not the instrumental mark', async () => {
    const { session, core, log, doc } = setup();
    try {
      await open(core, 'track-blue');
      click('更多歌词操作');
      click('清空歌词…', 'menuitem');
      click('清空');
      await screen.findByText('歌词已清空');
      click('保存');
      await waitFor(() => expect(doc('track-blue')!.kind).toBe('missing'));
      expect(doc('track-blue')!.lines).toHaveLength(0);
      expect(log.some(a => a.type === 'setNoLyrics')).toBe(false);
    } finally { session.destroy(); }
  });
});

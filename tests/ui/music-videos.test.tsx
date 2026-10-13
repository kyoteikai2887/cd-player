/**
 * MV round (Claude): music videos linked to an album and opened in PotPlayer (contract 0.5.0).
 * Against Codex's mock session (musicVideos / videoError), plus a controlled snapshot for the
 * file-picker tasks the real core runs in the background (started → done / cancelled).
 */
import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionResult, MusicVideo, PlayerBridge, TaskInfo, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import type { MockOptions } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import type { UIBoot } from '../../src/ui/lib/env.ts';
import { validateVideoTitle } from '../../src/ui/views/AlbumVideos.tsx';

afterEach(cleanup);

const ALBUM = 'album-blue';
const atAlbum: UIBoot = { route: { name: 'album', albumId: ALBUM } };

function Live({ bridge, log, boot, intercept }: {
  bridge: PlayerBridge; log: UIAction[]; boot: UIBoot; intercept?: (action: UIAction) => Promise<ActionResult> | null;
}) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const onAction = useCallback((action: UIAction): Promise<ActionResult> => {
    log.push(action);
    return intercept?.(action) ?? bridge.dispatch(action);
  }, [bridge, log, intercept]);
  return <UIBootContext.Provider value={boot}><PlayerUI snapshot={snapshot} surface="main" onAction={onAction} /></UIBootContext.Provider>;
}

function setup({ options = {}, boot = atAlbum, intercept }: {
  options?: MockOptions; boot?: UIBoot; intercept?: (action: UIAction, elsewhere: PlayerBridge) => Promise<ActionResult> | null;
} = {}) {
  const session = createMockSession({ autoTick: false, taskDelayMs: 0, ...options });
  const bridge = session.connect('main'), elsewhere = session.connect('mini');
  const log: UIAction[] = [];
  render(<Live bridge={bridge} log={log} boot={boot} intercept={intercept ? a => intercept(a, elsewhere) : undefined} />);
  const videos = () => bridge.getSnapshot().library.albums.find(a => a.id === ALBUM)!.musicVideos ?? [];
  const sent = <T extends UIAction['type']>(type: T) => log.filter((a): a is Extract<UIAction, { type: T }> => a.type === type);
  return { session, bridge, elsewhere, log, videos, sent };
}
const videoSection = () => [...document.querySelectorAll<HTMLElement>('section')].find(s => s.querySelector('h2')?.textContent?.includes('附带影像')) ?? null;
const rowOf = (title: string) => screen.getByRole('button', { name: `用 PotPlayer 播放：${title}` }).closest('li')!;
async function menu(title: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name: `更多：${title}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
/** After a frame: focus that follows a row going back to rest is moved in requestAnimationFrame. */
const frame = () => act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); await new Promise(r => setTimeout(r, 0)); });

describe('music videos on the album page', () => {
  test('no MV: no empty block; the entry is in “更多专辑操作”, and a link made shows up with what the core reports', async () => {
    const { sent, videos } = setup();
    expect(videoSection()).toBeNull();
    expect(screen.queryByText('附带影像')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多专辑操作' }));
    const item = await screen.findByRole('menuitem', { name: '关联 MV…' });
    expect(item.getAttribute('title')).toMatch(/不复制文件/);
    fireEvent.click(item);
    await flush();
    expect(sent('addMusicVideo')).toEqual([{ type: 'addMusicVideo', albumId: ALBUM }]);
    await waitFor(() => expect(videoSection()).not.toBeNull());
    expect(videos()).toHaveLength(1);
    // Only the title and the file name the core gives; no duration, size, thumbnail or "available".
    const row = rowOf('演示 MV');
    expect(row.textContent).toContain('演示 MV.mkv');
    expect(row.textContent).not.toMatch(/\d+:\d\d|MB|GB|可用|已验证/);
    expect(row.querySelector('img')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('更多专辑操作');
    expect(screen.getAllByRole('status').some(s => s.textContent === '已关联「演示 MV」')).toBe(true);
  });

  test('two MVs: a named list under the tracks, each row a native button that hands the file to PotPlayer', () => {
    setup({ options: { musicVideos: true } });
    const list = videoSection()!;
    expect(list.querySelector('h2')!.textContent).toContain('附带影像');
    expect(within(list).getAllByRole('button', { name: /^用 PotPlayer 播放：/ })).toHaveLength(2);
    expect(list.textContent).toContain('Music Video.mkv');
    expect(list.textContent).toContain('Special Movie.mkv');
    // Attached to the album, not to the tracks: no track count change, a fact in the header.
    expect(document.querySelector('[title="附带 MV"]')?.textContent).toBe('附带 MV2');
    const more = screen.getByRole('button', { name: '更多：Music Video' });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    // No wording anywhere suggests the video file itself is deleted.
    expect(document.body.textContent).not.toMatch(/删除文件|删除视频/);
  });

  test('play: only playMusicVideo is sent — the core pauses the music, the UI never pauses or resumes it', async () => {
    const { bridge, sent, log } = setup({ options: { musicVideos: true } });
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: ALBUM }); });
    expect(bridge.getSnapshot().player.status).toBe('playing');
    log.length = 0;
    fireEvent.click(screen.getByRole('button', { name: '用 PotPlayer 播放：Music Video' }));
    await flush();
    expect(log.map(a => a.type)).toEqual(['playMusicVideo']);
    expect(sent('playMusicVideo')[0]).toEqual({ type: 'playMusicVideo', albumId: ALBUM, videoId: 'demo-mv-1' });
    expect(bridge.getSnapshot().player.status).toBe('paused');
    expect(rowOf('Music Video').textContent).toContain('已交给 PotPlayer');
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(log.map(a => a.type)).toEqual(['playMusicVideo']);           // nothing resumes it
  });

  test('a missing file: the error stays on the row with “重新关联…”, the link is kept, nothing is paused', async () => {
    const { sent, videos, bridge } = setup({ options: { musicVideos: true, videoError: { code: 'fileMissing', message: '找不到 MKV 文件，请重新关联文件位置。' } } });
    await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: ALBUM }); });
    fireEvent.click(screen.getByRole('button', { name: '用 PotPlayer 播放：Music Video' }));
    await flush();
    const row = rowOf('Music Video');
    const alert = within(row).getByRole('alert');
    expect(alert.textContent).toContain('找不到 MKV 文件');
    expect(videos()).toHaveLength(2);
    expect(bridge.getSnapshot().player.status).toBe('playing');
    fireEvent.click(within(row).getByRole('button', { name: '重新关联…' }));
    await flush();
    expect(sent('relinkMusicVideo')).toEqual([{ type: 'relinkMusicVideo', albumId: ALBUM, videoId: 'demo-mv-1', baseRevision: 0 }]);
    // The relink failed too (videoError): still no optimistic change.
    expect(videos().map(v => v.fileName)).toEqual(['Music Video.mkv', 'Special Movie.mkv']);
  });

  test('no player: “PotPlayer 设置…” opens settings at the PotPlayer row; closing returns focus to it', async () => {
    setup({ options: { musicVideos: true, videoError: { code: 'notFound', message: '没有找到 PotPlayer。' } } });
    fireEvent.click(screen.getByRole('button', { name: '用 PotPlayer 播放：Music Video' }));
    await flush();
    const link = within(rowOf('Music Video')).getByRole('button', { name: 'PotPlayer 设置…' });
    link.focus();
    fireEvent.click(link);
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    const dialog = screen.getByRole('dialog', { name: '设置' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '自动查找' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull();
    expect(document.activeElement).toBe(link);
  });

  test('rename: in place, validated, trimmed, sent with the MV revision; Escape leaves it as it was', async () => {
    const { sent, videos } = setup({ options: { musicVideos: true } });
    await menu('Music Video', '改名…');
    const field = screen.getByRole('textbox', { name: 'MV 名称：Music Video' });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('名称不能为空');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(sent('renameMusicVideo')).toHaveLength(0);
    fireEvent.change(field, { target: { value: '  屋上の Music Video  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await flush();
    expect(sent('renameMusicVideo')).toEqual([{ type: 'renameMusicVideo', albumId: ALBUM, videoId: 'demo-mv-1', baseRevision: 0, title: '屋上の Music Video' }]);
    expect(videos()[0]).toMatchObject({ title: '屋上の Music Video', revision: 1, fileName: 'Music Video.mkv' });
    await frame();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('用 PotPlayer 播放：屋上の Music Video');
    // Escape: nothing sent, the old name stays, focus back on the row's menu button.
    await menu('Special Movie', '改名…');
    const second = screen.getByRole('textbox', { name: 'MV 名称：Special Movie' });
    fireEvent.change(second, { target: { value: '別の名前' } });
    fireEvent.keyDown(second, { key: 'Escape' });
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(sent('renameMusicVideo')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '用 PotPlayer 播放：Special Movie' })).toBeTruthy();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('更多：Special Movie');
    // The album page stays (Escape in the field does not navigate back).
    expect(document.querySelector('[data-scroller="album"]')).not.toBeNull();
  });

  test('rename meets a change made elsewhere: the draft stays, the latest is shown, a second save goes through', async () => {
    let conflicted = false;
    const { sent, videos } = setup({ options: { musicVideos: true }, intercept: (action, elsewhere) => {
      if (action.type !== 'renameMusicVideo' || conflicted) return null;
      conflicted = true;
      return (async () => {
        await elsewhere.dispatch({ type: 'renameMusicVideo', albumId: ALBUM, videoId: action.videoId, baseRevision: action.baseRevision, title: 'Music Video（另一窗口）' });
        return elsewhere.dispatch(action);
      })();
    } });
    await menu('Music Video', '改名…');
    const field = screen.getByRole('textbox', { name: /^MV 名称：/ });
    fireEvent.change(field, { target: { value: '屋上の Music Video' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await flush();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/别处改过.*草稿还在/);
    expect((screen.getByRole('textbox', { name: /^MV 名称：/ }) as HTMLInputElement).value).toBe('屋上の Music Video');
    expect(field.getAttribute('aria-invalid')).toBeNull();               // a conflict is not an invalid name
    fireEvent.keyDown(screen.getByRole('textbox', { name: /^MV 名称：/ }), { key: 'Enter' });
    await flush();
    expect(sent('renameMusicVideo').map(a => a.baseRevision)).toEqual([0, 1]);
    expect(videos()[0].title).toBe('屋上の Music Video');
  });

  test('remove the link (never the file): confirmed in place, Escape cancels, focus moves on, then back to the album', async () => {
    const { sent, videos } = setup({ options: { musicVideos: true } });
    await menu('Music Video', '移除关联…');
    const confirm = screen.getByRole('group', { name: '移除关联：Music Video' });
    expect(confirm.textContent).toContain('视频文件不会被删除');
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: '取消' }));
    fireEvent.keyDown(confirm, { key: 'Escape' });
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(sent('removeMusicVideo')).toHaveLength(0);
    expect(document.querySelector('[data-scroller="album"]')).not.toBeNull();
    await menu('Music Video', '移除关联…');
    fireEvent.click(within(screen.getByRole('group', { name: '移除关联：Music Video' })).getByRole('button', { name: '移除关联' }));
    await flush();
    expect(sent('removeMusicVideo')).toEqual([{ type: 'removeMusicVideo', albumId: ALBUM, videoId: 'demo-mv-1', baseRevision: 0 }]);
    expect(videos().map(v => v.id)).toEqual(['demo-mv-2']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('用 PotPlayer 播放：Special Movie');
    await menu('Special Movie', '移除关联…');
    fireEvent.click(within(screen.getByRole('group', { name: '移除关联：Special Movie' })).getByRole('button', { name: '移除关联' }));
    await flush();
    expect(videoSection()).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('更多专辑操作');
  });

  test('a removal the core refuses leaves the row and says why', async () => {
    const { videos } = setup({ options: { musicVideos: true, videoError: { code: 'io', message: '资料没有写入成功。' } } });
    await menu('Music Video', '移除关联…');
    fireEvent.click(within(screen.getByRole('group', { name: '移除关联：Music Video' })).getByRole('button', { name: '移除关联' }));
    await flush();
    expect(videos()).toHaveLength(2);
    expect(within(rowOf('Music Video')).getByRole('alert').textContent).toContain('资料没有写入成功');
  });

  test('names: 1–200 characters once trimmed, no control characters', () => {
    expect(validateVideoTitle('')).toMatch(/不能为空/);
    expect(validateVideoTitle('   ')).toMatch(/不能为空/);
    expect(validateVideoTitle('あ'.repeat(200))).toBeNull();
    expect(validateVideoTitle(' ' + 'あ'.repeat(200) + ' ')).toBeNull();
    expect(validateVideoTitle('あ'.repeat(201))).toMatch(/200/);
    expect(validateVideoTitle('a\nb')).toMatch(/控制字符/);
    expect(validateVideoTitle('名前\u0007')).toMatch(/控制字符/);
  });
});

// ── The file picker as the real core runs it: started → a task → done or cancelled ──
function Controlled({ initial, onAction: handle }: { initial: UISnapshot; onAction(action: UIAction, set: (f: (s: UISnapshot) => UISnapshot) => void): ActionResult }) {
  const [snapshot, setSnapshot] = useState(initial);
  const onAction = useCallback(async (action: UIAction) => handle(action, setSnapshot), [handle]);
  return <UIBootContext.Provider value={atAlbum}><PlayerUI snapshot={snapshot} surface="main" onAction={onAction} /></UIBootContext.Provider>;
}
function pickerSetup(withVideos: boolean) {
  const session = createMockSession({ autoTick: false, musicVideos: withVideos });
  const initial = session.connect('main').getSnapshot();
  session.destroy();
  const log: UIAction[] = [];
  let set!: (f: (s: UISnapshot) => UISnapshot) => void;
  const task: TaskInfo = { id: 'task-mv', kind: 'import', status: 'running', label: '关联本地 MV', cancellable: true, albumId: ALBUM };
  render(<Controlled initial={initial} onAction={(action, setter) => {
    log.push(action); set = setter;
    if (action.type === 'addMusicVideo' || action.type === 'detectPotPlayer' || action.type === 'pickPotPlayer') {
      setter(s => ({ ...s, tasks: [...s.tasks, task] }));
      return { ok: true, status: 'started', taskId: task.id };
    }
    if (action.type === 'cancelTask') { setter(s => ({ ...s, tasks: s.tasks.map(t => ({ ...t, status: 'cancelling' as const })) })); return { ok: true, status: 'applied' }; }
    return { ok: true, status: 'applied' };
  }} />);
  const finish = (change: (s: UISnapshot) => UISnapshot = s => s) =>
    act(async () => { set(s => ({ ...change(s), tasks: [] })); await new Promise(r => setTimeout(r, 0)); });
  const withVideo = (video: MusicVideo) => (s: UISnapshot): UISnapshot => ({ ...s, library: { ...s.library, revision: s.library.revision + 1,
    albums: s.library.albums.map(a => a.id === ALBUM ? { ...a, musicVideos: [...(a.musicVideos ?? []), video] } : a) } });
  return { log, finish, withVideo };
}

describe('the file picker runs as a task', () => {
  test('started is not success: a status line with 取消 while it runs; a cancelled pick adds nothing and says nothing', async () => {
    const { log, finish } = pickerSetup(false);
    fireEvent.click(screen.getByRole('button', { name: '更多专辑操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '关联 MV…' }));
    await flush();
    const status = screen.getAllByRole('status').find(s => s.textContent?.includes('请在弹出的窗口中选择 MKV 文件'))!;
    expect(status).toBeTruthy();
    expect(videoSection()).toBeNull();
    fireEvent.click(within(status).getByRole('button', { name: '取消' }));
    await flush();
    expect(log.map(a => a.type)).toEqual(['addMusicVideo', 'cancelTask']);
    expect(screen.getAllByRole('status').some(s => s.textContent?.includes('正在取消'))).toBe(true);
    await finish();
    expect(videoSection()).toBeNull();
    expect(document.body.textContent).not.toMatch(/已关联/);
  });

  test('a task that ends with the link in the snapshot is announced, once', async () => {
    const { finish, withVideo } = pickerSetup(true);
    fireEvent.click(within(videoSection()!).getByRole('button', { name: /关联 MV…/ }));
    await flush();
    expect(within(videoSection()!).getAllByRole('status').some(s => s.textContent?.includes('请在弹出的窗口中选择 MKV 文件'))).toBe(true);
    expect(within(videoSection()!).getByRole('button', { name: /关联 MV…/ }).hasAttribute('disabled')).toBe(true);
    await finish(withVideo({ id: 'mv-new', revision: 0, title: '特典映像', fileName: '特典映像.mkv' }));
    expect(rowOf('特典映像').dataset.fresh).toBe('true');
    expect(screen.getAllByRole('status').some(s => s.textContent === '已关联「特典映像」')).toBe(true);
  });

  test('settings: PotPlayer “未指定” → started task; cancel is quiet; potPlayerConfigured is never sent as a setting', async () => {
    cleanup();
    const session = createMockSession({ autoTick: false });
    const initial = session.connect('main').getSnapshot();
    session.destroy();
    const log: UIAction[] = [];
    let set!: (f: (s: UISnapshot) => UISnapshot) => void;
    render(<UIBootContext.Provider value={{ overlay: 'settings' }}><ControlledSettings initial={initial} log={log} grab={s => { set = s; }} /></UIBootContext.Provider>);
    const box = document.querySelector<HTMLElement>('section[aria-label="MV 播放"]')!;
    expect(box.textContent).toContain('未指定');
    expect(box.textContent).toMatch(/第一次播放 MV 时会在常见安装位置自动查找/);
    fireEvent.click(within(box).getByRole('button', { name: '选择程序…' }));
    await flush();
    expect(within(box).getByRole('status').textContent).toContain('选择 PotPlayer 程序');
    await act(async () => { set(s => ({ ...s, tasks: [] })); await new Promise(r => setTimeout(r, 0)); });
    expect(box.textContent).toContain('未指定');
    expect(box.textContent).not.toMatch(/已设置|已找到/);
    fireEvent.click(within(box).getByRole('button', { name: '自动查找' }));
    await flush();
    await act(async () => { set(s => ({ ...s, tasks: [], settings: { ...s.settings, potPlayerConfigured: true } })); await new Promise(r => setTimeout(r, 0)); });
    expect(box.textContent).toContain('已指定');
    expect(box.textContent).toContain('已找到 PotPlayer。');
    expect(log.map(a => a.type)).toEqual(['pickPotPlayer', 'detectPotPlayer']);
    expect(log.some(a => a.type === 'updateSettings' && 'potPlayerConfigured' in a.patch)).toBe(false);
  });

  test('settings: a failed search is said next to the PotPlayer buttons', async () => {
    cleanup();
    setup({ boot: { overlay: 'settings' }, options: { videoError: { code: 'notFound', message: '常见安装位置没有找到 PotPlayer。' } } });
    const box = document.querySelector<HTMLElement>('section[aria-label="MV 播放"]')!;
    fireEvent.click(within(box).getByRole('button', { name: '自动查找' }));
    await flush();
    expect(within(box).getByRole('alert').textContent).toContain('没有找到 PotPlayer');
  });
});

function ControlledSettings({ initial, log, grab }: { initial: UISnapshot; log: UIAction[]; grab(set: (f: (s: UISnapshot) => UISnapshot) => void): void }) {
  const [snapshot, setSnapshot] = useState(initial);
  grab(setSnapshot);
  const onAction = useCallback(async (action: UIAction): Promise<ActionResult> => {
    log.push(action);
    if (action.type === 'pickPotPlayer' || action.type === 'detectPotPlayer') {
      setSnapshot(s => ({ ...s, tasks: [{ id: 't-player', kind: 'import', status: 'running', label: '设置 PotPlayer', cancellable: true }] }));
      return { ok: true, status: 'started', taskId: 't-player' };
    }
    return { ok: true, status: 'applied' };
  }, [log]);
  return <PlayerUI snapshot={snapshot} surface="main" onAction={onAction} />;
}

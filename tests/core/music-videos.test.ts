import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rename, rm, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openLocalStore } from '../../src/local/store.ts';
import { startLocalServer } from '../../src/local/server.ts';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { applyLocalWrite } from '../../src/local/actions.ts';
import { linkVideo, validateMkv, validatePotPlayer, launchPotPlayer, videoTitle } from '../../src/local/musicVideos.ts';
import { parseLocalData } from '../../src/local/backups.ts';
import { prepareWindowsPicker } from '../../scripts/prepare-picker.mjs';
import type { UIAction } from '../../src/contracts/player.ts';

async function setup(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cd-mv-'));
  const store = await openLocalStore(path.join(directory, 'data'));
  const fixture = createDemoData();
  await store.transact(data => { data.library = fixture.library; data.lyricsByTrack = fixture.lyricsByTrack; });
  const mv = path.join(directory, '中文 日本語 & (MV).mkv');
  await writeFile(mv, Buffer.from('1a45dfa3010203', 'hex'));
  const executable = path.join(directory, 'PotPlayerMini64.exe');
  await writeFile(executable, 'MZ-not-executed-test-fixture');
  let selected: string | null = mv;
  let launcherError = false;
  const launches: string[][] = [];
  const server = await startLocalServer({ store, dataDirectory: path.join(directory, 'data'),
    picker: async () => selected, videoPlayerDetector: async () => executable,
    videoLauncher: async (exe, file, signal) => { signal.throwIfAborted(); if (launcherError) throw new Error('spawn failed'); launches.push([exe, file]); } });
  t.after(async () => {
    await server.close(); await store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cd-mv-'));
    await rm(directory, { recursive: true, force: true });
  });
  const bootstrap = await (await fetch(server.origin + '/api/bootstrap')).json();
  const post = async (route: string, action: UIAction) => (await fetch(server.origin + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cd-token': bootstrap.token, origin: server.origin }, body: JSON.stringify(action),
  })).json();
  const task = async (action: UIAction) => {
    const reply = await post('/api/task', action);
    if (!reply.ok) return reply;
    for (let i = 0; i < 200; i++) {
      const result = await (await fetch(server.origin + '/api/task/' + reply.taskId, { headers: { 'x-cd-token': bootstrap.token } })).json();
      if (result.state !== 'running') return result;
      await delay(5);
    }
    throw new Error('Task did not finish');
  };
  return { directory, store, mv, executable, launches, post, task, albumId: fixture.library.albums[0].id,
    select: (value: string | null) => { selected = value; }, failLaunch: () => { launcherError = true; } };
}

test('MKV links survive restart parsing and backup, stay private, and do not copy or remove media', async t => {
  const f = await setup(t);
  const original = await readFile(f.mv);
  assert.equal((await f.task({ type: 'addMusicVideo', albumId: f.albumId })).state, 'done');
  const publicAlbum = f.store.view().library.albums.find(a => a.id === f.albumId)!;
  const video = publicAlbum.musicVideos![0];
  assert.equal(video.fileName, path.basename(f.mv));
  assert.equal(JSON.stringify(f.store.view()).includes(f.directory.replaceAll('\\', '\\\\')), false);
  const parsed = parseLocalData(await readFile(path.join(f.directory, 'data/library.json'), 'utf8'));
  assert.equal(parsed.musicVideos![video.id].path, f.mv);
  await f.store.backup();
  assert.equal((await f.post('/api/action', { type: 'renameMusicVideo', albumId: f.albumId,
    videoId: video.id, baseRevision: 0, title: '我的 MV' })).ok, true);
  assert.equal((await f.post('/api/action', { type: 'removeMusicVideo', albumId: f.albumId,
    videoId: video.id, baseRevision: 0 })).code, 'conflict');
  assert.equal((await f.post('/api/action', { type: 'removeMusicVideo', albumId: f.albumId,
    videoId: video.id, baseRevision: 1 })).ok, true);
  assert.deepEqual(await readFile(f.mv), original);
  assert.equal((await readdir(path.join(f.directory, 'data'))).some(name => name.endsWith('.mkv')), false);
});

test('cancel, duplicate, wrong album, invalid extension and malformed container do not add links', async t => {
  const f = await setup(t);
  f.select(null);
  assert.equal((await f.task({ type: 'addMusicVideo', albumId: f.albumId })).state, 'cancelled');
  f.select(f.mv);
  await f.task({ type: 'addMusicVideo', albumId: f.albumId });
  assert.equal((await f.task({ type: 'addMusicVideo', albumId: f.albumId })).error.code, 'invalidAction');
  assert.equal((await f.task({ type: 'addMusicVideo', albumId: 'nonexistent' })).code, 'notFound');
  await assert.rejects(validateMkv(f.executable), { code: 'invalidAction' });
  const invalid = path.join(f.directory, 'invalid.mkv'); await writeFile(invalid, 'not-matroska');
  await assert.rejects(validateMkv(invalid), { code: 'invalidAction' });
  const wrong = path.join(f.directory, 'other.exe'); await writeFile(wrong, 'MZ');
  await assert.rejects(validatePotPlayer(wrong), { code: 'invalidAction' });
  await assert.rejects(validatePotPlayer(path.join(f.directory, 'missing', 'PotPlayerMini64.exe')), { code: 'notFound' });
  assert.equal(videoTitle('😀'.repeat(200)), '😀'.repeat(200));
  assert.throws(() => videoTitle('😀'.repeat(201)), { code: 'invalidAction' });
  assert.equal(f.store.view().library.albums.find(a => a.id === f.albumId)!.musicVideos!.length, 1);
});

test('moving a video keeps the association; relink preserves its name and launcher receives the new path', async t => {
  const f = await setup(t);
  await f.task({ type: 'addMusicVideo', albumId: f.albumId });
  const video = f.store.view().library.albums.find(a => a.id === f.albumId)!.musicVideos![0];
  const play = { type: 'playMusicVideo', albumId: f.albumId, videoId: video.id } as const;
  assert.equal((await f.post('/api/action', play)).ok, true);
  assert.deepEqual(f.launches[0], [f.executable, f.mv]);
  assert.equal(f.store.view().settings.potPlayerConfigured, true);
  const moved = path.join(f.directory, 'moved.mkv'); await rename(f.mv, moved);
  assert.equal((await f.post('/api/action', play)).code, 'fileMissing');
  assert.ok(f.store.read().musicVideos![video.id]);
  f.select(moved);
  assert.equal((await f.task({ type: 'relinkMusicVideo', albumId: f.albumId, videoId: video.id, baseRevision: 0 })).state, 'done');
  assert.equal(f.store.read().musicVideos![video.id].title, video.title);
  assert.equal((await f.post('/api/action', play)).ok, true);
  assert.equal(f.launches[1][1], moved);
  f.failLaunch(); assert.equal((await f.post('/api/action', play)).ok, false);
  assert.equal(f.launches.length, 2);
});

test('album removal drops only video associations; old stores remain valid and scans can replace album objects', async t => {
  const f = await setup(t);
  const old = f.store.read(); delete old.musicVideos; delete old.potPlayerPath;
  assert.ok(parseLocalData(JSON.stringify(old)));
  // A frozen older app can remove an album while preserving unknown MV fields.
  // Keep unrelated music/settings readable, retaining the detached link privately.
  old.musicVideos = { detached: { albumId: 'removed-in-older-app', revision: 0, title: '😀'.repeat(200), path: f.mv } };
  assert.ok(parseLocalData(JSON.stringify(old)));
  await f.store.transact(data => linkVideo(data, f.albumId, f.mv));
  await f.store.transact(data => { data.library.albums = structuredClone(data.library.albums); });
  assert.equal(f.store.view().library.albums.find(a => a.id === f.albumId)!.musicVideos!.length, 1);
  await f.store.transact(data => applyLocalWrite(data, { type: 'removeAlbum', albumId: f.albumId, baseLibraryRevision: data.library.revision }));
  assert.equal(Object.keys(f.store.read().musicVideos!).length, 0);
  assert.equal((await readFile(f.mv)).length, 7);
});

test('mock MV actions cover both surfaces without starting any application', async () => {
  const session = createMockSession({ autoTick: false, musicVideos: true });
  try {
    const main = session.connect('main'), mini = session.connect('mini');
    const album = main.getSnapshot().library.albums[0], video = album.musicVideos![0];
    assert.equal((await main.dispatch({ type: 'renameMusicVideo', albumId: album.id, videoId: video.id,
      baseRevision: 0, title: 'New title' })).ok, true);
    assert.equal(mini.getSnapshot().library.albums[0].musicVideos![0].title, 'New title');
  } finally { session.destroy(); }
});

test('Windows process launch preserves Unicode and shell metacharacters as one filename argument', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t);
  const source = path.join(f.directory, 'Capture.cs');
  await writeFile(source, `using System; using System.IO; class Capture { [STAThread] static void Main(string[] args) { File.WriteAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "args.txt"), args); } }`);
  const helper = await prepareWindowsPicker(path.join(f.directory, 'capture'), source);
  const player = path.join(f.directory, 'capture', 'PotPlayerMini64.exe'); await copyFile(helper, player);
  await launchPotPlayer(player, f.mv, new AbortController().signal);
  let args: string | undefined;
  for (let i = 0; i < 200; i++) { try { args = await readFile(path.join(f.directory, 'capture', 'args.txt'), 'utf8'); break; } catch { await delay(10); } }
  assert.deepEqual(args?.trim().split(/\r?\n/), [f.mv, '/current', '/autoplay']);
});

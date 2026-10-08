import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planAlbumRemoval } from '../../src/core/library.ts';
import { emptyPlayer, loadQueue, pruneQueueForLibrary } from '../../src/core/queue.ts';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { applyLocalWrite } from '../../src/local/actions.ts';
import { mergeScan, scanFolder } from '../../src/local/scanner.ts';
import { openLocalStore } from '../../src/local/store.ts';
import { startLocalServer } from '../../src/local/server.ts';
import { listLocalBackups, parseLocalData } from '../../src/local/backups.ts';
import { createAudioFolder } from '../helpers/audioFiles.ts';
import type { UIAction } from '../../src/contracts/player.ts';

const roots = new Set<string>();
after(async () => {
  for (const root of roots) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(relative.startsWith('cd-player-removal-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cd-player-removal-'));
  roots.add(root);
  const music = await createAudioFolder(path.join(root, 'music'), 0.1);
  const directory = path.join(root, 'data'), store = await openLocalStore(directory);
  const scan = await scanFolder(music, path.join(directory, 'covers'), new AbortController().signal);
  await store.transact(data => mergeScan(data, scan));
  return { music, directory, store, scan };
}
async function fingerprints(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(await fingerprints(filename)))
      result[path.join(entry.name, name)] = value;
    else result[entry.name] = createHash('sha256').update(await readFile(filename)).digest('hex');
  }
  return result;
}
const code = (result: ReturnType<typeof planAlbumRemoval>) => result.ok ? 'applied' : result.code;

test('removal plan validates the confirmed revision and owns tracks by albumId without mutating its input', () => {
  const { library } = createDemoData(), before = structuredClone(library);
  const album = library.albums[0];
  assert.equal(code(planAlbumRemoval(library, album.id, library.revision + 1)), 'conflict');
  assert.equal(code(planAlbumRemoval(library, album.id, NaN)), 'invalidAction');
  assert.equal(code(planAlbumRemoval(library, '', library.revision)), 'invalidAction');
  assert.equal(code(planAlbumRemoval(library, 'gone', library.revision)), 'notFound');
  const foreign = library.tracks.find(track => track.albumId !== album.id)!;
  album.trackIds.push(foreign.id); // A stale index cannot remove another album's record.
  const plan = planAlbumRemoval(library, album.id, library.revision);
  assert.ok(plan.ok);
  assert.equal(plan.library.revision, library.revision + 1);
  assert.ok(!plan.trackIds.includes(foreign.id));
  assert.strictEqual(plan.library.tracks.find(track => track.id === foreign.id), foreign);
  assert.equal(library.tracks.length, before.tracks.length);
  assert.equal(library.albums.length, before.albums.length);
});

test('queue removal clears all repeated entries and current playback, preserving other identities and options', () => {
  const { library } = createDemoData();
  const own = library.tracks[0], other = library.tracks.find(track => track.albumId !== own.albumId && track.available)!;
  const before = { ...loadQueue(emptyPlayer(), [own.id, other.id, own.id], library),
    volume: 0.3, muted: true, shuffle: true, repeat: 'all' as const, positionMs: 1234 };
  const plan = planAlbumRemoval(library, own.albumId, library.revision);
  assert.ok(plan.ok);
  const player = pruneQueueForLibrary(before, plan.library);
  assert.equal(player.status, 'idle');
  assert.equal(player.currentTrackId, null);
  assert.equal(player.currentEntryId, null);
  assert.equal(player.currentQueueIndex, -1);
  assert.equal(player.positionMs, 0);
  assert.deepEqual(player.queue, [before.queue[1]]);
  assert.strictEqual(player.queue[0], before.queue[1]);
  assert.deepEqual([player.volume, player.muted, player.shuffle, player.repeat], [0.3, true, true, 'all']);
  const continuing = { ...before, currentTrackId: other.id, currentEntryId: before.queue[1].id, currentQueueIndex: 1 };
  const retained = pruneQueueForLibrary(continuing, plan.library);
  assert.equal(retained.status, 'playing');
  assert.equal(retained.positionMs, 1234);
  assert.equal(retained.currentQueueIndex, 0);
  assert.equal(retained.currentEntryId, continuing.currentEntryId);
  assert.strictEqual(pruneQueueForLibrary(retained, plan.library), retained);
});

test('HTTP removal backs up latest metadata, preserves every original byte, persists exclusions, and explicit reimport restores', async () => {
  const { music, directory, store, scan } = await setup();
  const before = await fingerprints(music), album = scan.albums[0];
  await store.transact(data => applyLocalWrite(data, { type: 'updateAlbum', albumId: album.id,
    baseRevision: album.revision, patch: { title: '手动整理' } }));
  const revision = store.view().library.revision;
  const server = await startLocalServer({ store, dataDirectory: directory, picker: async () => music });
  const headers = { 'content-type': 'application/json', 'x-cd-token': server.token };
  const post = async (endpoint: string, action: UIAction) => (await fetch(server.origin + endpoint,
    { method: 'POST', headers, body: JSON.stringify(action) })).json();
  try {
    const response = await post('/api/action', { type: 'removeAlbum', albumId: album.id, baseLibraryRevision: revision });
    assert.equal(response.ok, true);
    assert.equal(response.view.library.revision, revision + 1);
    const removedIds = scan.tracks.filter(track => track.albumId === album.id).map(track => track.id);
    for (const id of removedIds) {
      assert.equal(store.read().files[id], undefined);
      assert.equal(store.read().lyricsByTrack[id], undefined);
      assert.equal(store.read().archivedLyrics[id], undefined);
      assert.equal(store.read().excludedTrackIds![id], revision + 1);
      assert.equal((await fetch(server.origin + '/api/media/' + id, { headers })).status, 404);
    }
    assert.equal(store.read().covers[album.id], undefined);
    assert.deepEqual(await fingerprints(music), before);
    const backups = await listLocalBackups(directory);
    const backup = backups.valid.find(item => item.libraryRevision === revision)!;
    assert.ok(backup, 'fresh pre-removal backup required even inside normal backup throttle');
    const payload = JSON.parse(await readFile(path.join(directory, 'backups', backup.id), 'utf8')).payload;
    assert.equal(parseLocalData(payload).library.albums.find(item => item.id === album.id)!.title, '手动整理');
    await store.transact(data => mergeScan(data, scan));
    assert.ok(!store.view().library.albums.some(item => item.id === album.id));
    const started = await post('/api/task', { type: 'importFolder' });
    assert.equal(started.status, 'started');
    let task;
    for (let count = 0; count < 200; count++) {
      task = await (await fetch(server.origin + '/api/task/' + started.taskId, { headers })).json();
      if (task.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(task.state, 'done');
    assert.equal(store.view().library.albums.find(item => item.id === album.id)!.title, album.title);
    for (const id of removedIds) assert.equal(store.read().excludedTrackIds![id], undefined);
    assert.deepEqual(await fingerprints(music), before);
  } finally { await server.close(); await store.close(); }
  const restarted = await openLocalStore(directory);
  try { assert.equal(restarted.view().library.tracks.length, scan.tracks.length); }
  finally { await restarted.close(); }
});

test('restart and scans started before removal cannot resurrect excluded tracks; scan inputs stay unchanged', async () => {
  const { directory, store, scan } = await setup();
  const before = structuredClone(scan), startRevision = store.view().library.revision, album = scan.albums[0];
  await store.transact(data => applyLocalWrite(data, { type: 'removeAlbum', albumId: album.id,
    baseLibraryRevision: startRevision }));
  await store.transact(data => mergeScan(data, scan, { restoreRemovedAtRevision: startRevision }));
  await store.close();
  const restarted = await openLocalStore(directory);
  try {
    await restarted.transact(data => mergeScan(data, scan));
    assert.ok(!restarted.view().library.albums.some(item => item.id === album.id));
    assert.ok(scan.tracks.filter(track => track.albumId === album.id).every(track => restarted.read().excludedTrackIds![track.id] > 0));
    assert.deepEqual(scan, before);
  } finally { await restarted.close(); }
});

test('HTTP removal rejects stale confirmation and a failed backup without dropping any record', async () => {
  const { directory, store, scan } = await setup(), album = scan.albums[0];
  const backup = store.backup.bind(store);
  const server = await startLocalServer({ store, dataDirectory: directory });
  const post = async (revision: number) => (await fetch(server.origin + '/api/action', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cd-token': server.token },
    body: JSON.stringify({ type: 'removeAlbum', albumId: album.id, baseLibraryRevision: revision }) })).json();
  try {
    const initial = store.view();
    assert.equal((await post(initial.library.revision - 1)).code, 'conflict');
    store.backup = async () => { throw new Error('test disk failure'); };
    assert.equal((await post(initial.library.revision)).code, 'io');
    assert.deepEqual(store.view(), initial);
  } finally { store.backup = backup; await server.close(); await store.close(); }
});

test('an import chooser already open before removal cannot restore the removed album', async () => {
  const { music, directory, store, scan } = await setup();
  let choose!: (value: string) => void;
  const server = await startLocalServer({ store, dataDirectory: directory, picker: async () => new Promise(resolve => { choose = resolve; }) });
  const headers = { 'content-type': 'application/json', 'x-cd-token': server.token };
  const post = async (url: string, action: UIAction) => (await fetch(server.origin + url,
    { method: 'POST', headers, body: JSON.stringify(action) })).json();
  try {
    const started = await post('/api/task', { type: 'importFolder' });
    for (let i = 0; i < 50 && !choose; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(choose);
    const album = scan.albums[0];
    assert.equal((await post('/api/action', { type: 'removeAlbum', albumId: album.id,
      baseLibraryRevision: store.view().library.revision })).ok, true);
    choose(music);
    let task;
    for (let i = 0; i < 200; i++) {
      task = await (await fetch(server.origin + '/api/task/' + started.taskId, { headers })).json();
      if (task.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(task.state, 'done');
    assert.ok(!store.view().library.albums.some(item => item.id === album.id));
  } finally { if (choose) choose(music); await server.close(); await store.close(); }
});

test('removal cancels a pending targeted file chooser so its late result does not write lyrics', async () => {
  const { music, directory, store, scan } = await setup();
  let choose!: (value: string) => void;
  const server = await startLocalServer({ store, dataDirectory: directory, picker: async () => new Promise(resolve => { choose = resolve; }) });
  const headers = { 'content-type': 'application/json', 'x-cd-token': server.token };
  const post = async (url: string, action: UIAction) => (await fetch(server.origin + url,
    { method: 'POST', headers, body: JSON.stringify(action) })).json();
  const track = scan.tracks.find(item => item.title === '窓の光')!;
  try {
    const started = await post('/api/task', { type: 'importLyrics', trackId: track.id, content: 'original', baseRevision: 0 });
    for (let i = 0; i < 50 && !choose; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(choose);
    assert.equal((await post('/api/action', { type: 'removeAlbum', albumId: track.albumId,
      baseLibraryRevision: store.view().library.revision })).ok, true);
    choose(path.join(music, 'Disc 1', '01 原创音.lrc'));
    let task;
    for (let i = 0; i < 100; i++) {
      task = await (await fetch(server.origin + '/api/task/' + started.taskId, { headers })).json();
      if (task.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(task.state, 'cancelled');
    assert.equal(store.view().lyricsByTrack[track.id], undefined);
  } finally { if (choose) choose(path.join(music, 'Disc 1', '01 原创音.lrc')); await server.close(); await store.close(); }
});

test('old schema-one stores remain readable and invalid exclusion data is rejected', async () => {
  const { store } = await setup();
  try {
    const data = store.read(); delete data.excludedTrackIds;
    assert.equal(parseLocalData(JSON.stringify(data)).excludedTrackIds, undefined);
    for (const excludedTrackIds of [null, [], { track: -1 }, { track: 1.5 }, { track: '2' }])
      assert.throws(() => parseLocalData(JSON.stringify({ ...data, excludedTrackIds })));
  } finally { await store.close(); }
});

test('DemoBridge removal atomically clears current lyrics, editor, repeated queue entries and background imports across surfaces', async () => {
  let release!: (value: string) => void;
  const session = createMockSession({ autoTick: false, taskDelayMs: 0,
    importText: async () => new Promise(resolve => { release = resolve; }) });
  const main = session.connect('main'), mini = session.connect('mini');
  const otherId = main.getSnapshot().library.tracks.find(track => track.albumId !== 'album-blue' && track.available)!.id;
  try {
    await main.dispatch({ type: 'playTracks', trackIds: ['track-blue', otherId, 'track-blue'], startIndex: 0 });
    await main.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    await main.dispatch({ type: 'importLyrics', trackId: 'track-blue', content: 'original', destination: 'editorDraft' });
    for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const albumId = main.getSnapshot().library.tracks.find(track => track.id === 'track-blue')!.albumId;
    const revision = main.getSnapshot().library.revision;
    const observed: ReturnType<typeof main.getSnapshot>[] = [];
    main.subscribe(() => observed.push(main.getSnapshot())); mini.subscribe(() => observed.push(mini.getSnapshot()));
    assert.equal((await mini.dispatch({ type: 'removeAlbum', albumId, baseLibraryRevision: revision })).ok, true);
    assert.equal(main.getSnapshot().lyrics, null);
    assert.equal(main.getSnapshot().lyricsEditor, null);
    assert.equal(main.getSnapshot().player.status, 'idle');
    assert.deepEqual(main.getSnapshot().player.queue.map(entry => entry.trackId), [otherId]);
    assert.ok(observed.every(snapshot => snapshot.library.revision === revision + 1 && snapshot.player.currentTrackId === null));
    release('[00:01]late'); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(main.getSnapshot().tasks.length, 0);
    assert.equal(main.getSnapshot().lyricsEditor, null);
    assert.equal((await main.dispatch({ type: 'playAlbum', albumId })).ok, false);
    await main.dispatch({ type: 'togglePlayback' });
    assert.equal(main.getSnapshot().player.currentTrackId, otherId);
  } finally { session.destroy(); }
});

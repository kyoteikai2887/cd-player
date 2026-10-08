import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, cp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pcm, flac, wav } from '../helpers/audioFiles.ts';
import { scanFolder, mergeScan, markRootUnavailable } from '../../src/local/scanner.ts';
import { hashMusicFile, observeLegacyIdentities } from '../../src/local/identity.ts';
import { openLocalStore } from '../../src/local/store.ts';
import { applyLocalWrite } from '../../src/local/actions.ts';
import { listLocalBackups, parseLocalData } from '../../src/local/backups.ts';
import { startLocalServer } from '../../src/local/server.ts';
import type { UIAction } from '../../src/contracts/player.ts';

const roots = new Set<string>();
after(async () => {
  for (const root of roots) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(relative.startsWith('cd-player-relocation-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cd-player-relocation-'));
  roots.add(root);
  const music = path.join(root, 'original'), directory = path.join(root, 'data');
  await mkdir(music);
  for (const n of [1, 2]) await writeFile(path.join(music, `${n}.flac`), flac(pcm(.1, 440 + n * 80), {
    ALBUM: '原创路径试验', TITLE: '原创曲 ' + n, ARTIST: '测试歌手', TRACKNUMBER: String(n), DISCNUMBER: String(n),
  }));
  await writeFile(path.join(music, '1.lrc'), '[00:00.000]原始歌词');
  await writeFile(path.join(music, 'capture.log'), 'Original relocation test log');
  const store = await openLocalStore(directory);
  const scan = await scanFolder(music, path.join(directory, 'covers'), new AbortController().signal);
  await store.transact(data => mergeScan(data, scan));
  return { root, music, directory, store, scan, album: scan.albums[0], track: scan.tracks[0] };
}
const scanAt = (root: string, directory: string) => scanFolder(root, path.join(directory, 'covers'), new AbortController().signal);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('whole folder relocation preserves IDs, protected metadata, saved lyrics, cover and timestamps, and survives restart', async () => {
  const { root, music, directory, store, scan, album, track } = await setup();
  const originalBytes = await readFile(path.join(music, '1.flac'));
  await store.transact(data => {
    applyLocalWrite(data, { type: 'updateAlbum', albumId: album.id, baseRevision: 0, patch: { title: '手动专辑' } });
    applyLocalWrite(data, { type: 'updateTrack', trackId: track.id, baseRevision: 0, patch: { title: '手动曲名', trackNumber: 9 } });
    applyLocalWrite(data, { type: 'setLyricsOffset', trackId: track.id, baseRevision: 0, offsetMs: 350 });
    data.library.albums[0].cover = { thumbUrl: '/api/cover/' + album.id, fullUrl: '/api/cover/' + album.id };
    data.library.albums[0].userEditedFields.push('cover');
    data.covers[album.id] = { path: 'manual-cover.image', mime: 'image/png' };
  });
  const before = store.read(), moved = path.join(root, '新位置');
  await rename(music, moved);
  const incoming = await scanAt(moved, directory), untouched = structuredClone(incoming);
  await store.transact(data => assert.equal(mergeScan(data, incoming).relocated, 1));
  const current = store.read();
  assert.deepEqual(current.library.tracks.map(t => t.id).sort(), scan.tracks.map(t => t.id).sort());
  assert.equal(current.library.albums.length, 1);
  assert.equal(current.library.albums[0].id, album.id);
  assert.equal(current.library.albums[0].title, '手动专辑');
  assert.equal(current.library.albums[0].addedAt, before.library.albums[0].addedAt);
  assert.equal(current.library.tracks.find(t => t.id === track.id)!.title, '手动曲名');
  assert.equal(current.library.tracks.find(t => t.id === track.id)!.trackNumber, 9);
  assert.deepEqual(current.lyricsByTrack[track.id], before.lyricsByTrack[track.id]);
  assert.deepEqual(current.covers[album.id], before.covers[album.id]);
  assert.deepEqual(current.roots, [moved]);
  assert.equal(sha(await readFile(current.files[track.id].path)), sha(originalBytes));
  assert.equal(await readFile(path.join(moved, 'capture.log'), 'utf8'), 'Original relocation test log');
  assert.deepEqual(incoming, untouched);
  await store.close();
  const reopened = await openLocalStore(directory);
  try { assert.deepEqual(reopened.read(), current); } finally { await reopened.close(); }
});

test('identical copied album does not duplicate records; broad-root rescan prefers known path', async () => {
  const { root, music, directory, store, scan } = await setup();
  try {
    const copy = path.join(root, 'copy'); await cp(music, copy, { recursive: true });
    const broad = await scanAt(root, directory);
    await store.transact(data => mergeScan(data, broad));
    assert.equal(store.read().library.albums.length, 1);
    assert.equal(store.read().library.tracks.length, 2);
    assert.equal(store.read().files[scan.tracks[0].id].path, scan.files[scan.tracks[0].id].path);
    const copied = await scanAt(copy, directory);
    await store.transact(data => mergeScan(data, copied));
    await store.transact(data => mergeScan(data, copied));
    assert.equal(store.read().library.albums.length, 1);
    assert.equal(store.read().library.tracks.length, 2);
    assert.ok(Object.values(store.read().files).every(file => file.path.startsWith(copy + path.sep)));
  } finally { await store.close(); }
});

test('same tags and duration with different audio never relink, and incomplete albums never guess', async () => {
  const { root, music, directory, store, album } = await setup();
  try {
    const copy = path.join(root, 'different'); await cp(music, copy, { recursive: true });
    await writeFile(path.join(copy, '1.flac'), flac(pcm(.1, 999), {
      ALBUM: '原创路径试验', TITLE: '原创曲 1', ARTIST: '测试歌手', TRACKNUMBER: '1', DISCNUMBER: '1',
    }));
    const incoming = await scanAt(copy, directory);
    await store.transact(data => assert.equal(mergeScan(data, incoming).relocated, 0));
    assert.equal(store.read().library.albums.length, 2);
    assert.ok(store.read().library.albums.some(a => a.id === album.id));
    const partial = path.join(root, 'partial'); await mkdir(partial);
    await cp(path.join(music, '2.flac'), path.join(partial, '2.flac'));
    const subset = await scanAt(partial, directory);
    await store.transact(data => assert.equal(mergeScan(data, subset).relocated, 0));
    assert.equal(store.read().library.albums.length, 3);
  } finally { await store.close(); }
});

test('ambiguous old copies are left separate with a warning', async () => {
  const { root, music, directory, store } = await setup();
  try {
    const second = path.join(root, 'second'); await cp(music, second, { recursive: true });
    const duplicate = await scanAt(second, directory);
    // Simulate a pre-existing duplicate legacy record, rather than introducing one through the new merge.
    await store.transact(data => {
      data.library.albums.push(...duplicate.albums);
      data.library.tracks.push(...duplicate.tracks);
      Object.assign(data.files, duplicate.files); Object.assign(data.fileIdentities!, duplicate.identities);
      Object.assign(data.lyricsByTrack, duplicate.lyrics);
    });
    const third = path.join(root, 'third'); await cp(music, third, { recursive: true });
    const incoming = await scanAt(third, directory);
    await store.transact(data => {
      const result = mergeScan(data, incoming);
      assert.equal(result.relocated, 0); assert.ok(result.warnings.some(w => w.includes('关联不唯一')));
    });
    assert.equal(store.read().library.albums.length, 3);
  } finally { await store.close(); }
});

test('moved removed album stays excluded across restart and late imports; a fresh explicit import restores', async () => {
  const { root, music, directory, store, album } = await setup();
  const startRevision = store.view().library.revision;
  const moved = path.join(root, 'moved'); await rename(music, moved);
  const incoming = await scanAt(moved, directory);
  await store.transact(data => applyLocalWrite(data, { type: 'removeAlbum', albumId: album.id, baseLibraryRevision: startRevision }));
  await store.transact(data => mergeScan(data, incoming, { restoreRemovedAtRevision: startRevision }));
  assert.equal(store.view().library.albums.length, 0);
  await store.close();
  const reopened = await openLocalStore(directory);
  try {
    await reopened.transact(data => mergeScan(data, incoming));
    assert.equal(reopened.view().library.tracks.length, 0);
    const boundary = reopened.view().library.revision;
    await reopened.transact(data => mergeScan(data, incoming, { restoreRemovedAtRevision: boundary }));
    assert.equal(reopened.view().library.albums[0].id, album.id);
    assert.equal(reopened.view().library.tracks.length, 2);
    assert.deepEqual(reopened.read().excludedTrackIds, {});
  } finally { await reopened.close(); }
});

test('a late partial copy cannot bypass removal by renaming an untagged WAV and changing its inferred track number', async () => {
  const { root, music, directory, store } = await setup();
  try {
    const filename = path.join(music, '3.wav'); await writeFile(filename, wav(pcm(.1, 700)));
    const expanded = await scanAt(music, directory);
    await store.transact(data => mergeScan(data, expanded));
    const track = expanded.tracks.find(t => t.id === Object.keys(expanded.files).find(id => expanded.files[id].path === filename))!;
    const revision = store.view().library.revision;
    await store.transact(data => applyLocalWrite(data, { type: 'removeAlbum', albumId: track.albumId, baseLibraryRevision: revision }));
    const partial = path.join(root, 'partial'); await mkdir(partial);
    await cp(filename, path.join(partial, '99.wav'));
    const incoming = await scanAt(partial, directory);
    await store.transact(data => mergeScan(data, incoming, { restoreRemovedAtRevision: revision }));
    assert.ok(!store.view().library.tracks.some(t => t.title === '99'));
  } finally { await store.close(); }
});

test('legacy observations upgrade readable records and preserve the latest concurrent edits', async () => {
  const { root, music, directory, store, album, track } = await setup();
  try {
    await store.transact(data => {
      delete data.fileIdentities;
      applyLocalWrite(data, { type: 'updateTrack', trackId: track.id, baseRevision: 0, patch: { discNumber: 7, trackNumber: 8 } });
    });
    const observations = await observeLegacyIdentities(store.read(), new AbortController().signal);
    assert.equal(observations.length, 2);
    const moved = path.join(root, 'moved'); await rename(music, moved);
    const incoming = await scanAt(moved, directory);
    await store.transact(data => applyLocalWrite(data, { type: 'updateAlbum', albumId: album.id,
      baseRevision: 0, patch: { title: '扫描期间修改' } }));
    await store.transact(data => mergeScan(data, incoming, { observations }));
    assert.equal(store.view().library.albums.length, 1);
    assert.equal(store.view().library.albums[0].title, '扫描期间修改');
    assert.equal(store.view().library.tracks.find(t => t.id === track.id)!.discNumber, 7);
    assert.equal(store.view().library.tracks.find(t => t.id === track.id)!.trackNumber, 8);
    assert.ok(store.read().files[track.id].path.startsWith(moved));
    const retainedHash = store.read().fileIdentities![track.id].sha256;
    observations.find(item => item.trackId === track.id)!.identity.sha256 = '0'.repeat(64);
    assert.equal(store.read().fileIdentities![track.id].sha256, retainedHash);
  } finally { await store.close(); }
});

test('legacy observations taken before a concurrent removal still reject late moved imports', async () => {
  const { root, music, directory, store, album } = await setup();
  try {
    await store.transact(data => { delete data.fileIdentities; });
    const observations = await observeLegacyIdentities(store.read(), new AbortController().signal);
    const revision = store.view().library.revision;
    await store.transact(data => applyLocalWrite(data, { type: 'removeAlbum', albumId: album.id, baseLibraryRevision: revision }));
    const moved = path.join(root, 'moved'); await rename(music, moved);
    const incoming = await scanAt(moved, directory);
    await store.transact(data => mergeScan(data, incoming, { observations, restoreRemovedAtRevision: revision }));
    assert.equal(store.view().library.tracks.length, 0);
  } finally { await store.close(); }
});

test('unreadable legacy files cannot be matched by metadata and malformed identity stores are rejected', async () => {
  const { root, music, directory, store, album } = await setup();
  try {
    await store.transact(data => { delete data.fileIdentities; });
    const moved = path.join(root, 'moved'); await rename(music, moved);
    assert.deepEqual(await observeLegacyIdentities(store.read(), new AbortController().signal), []);
    const incoming = await scanAt(moved, directory);
    await store.transact(data => assert.ok(mergeScan(data, incoming).warnings.some(w => w.includes('没有文件指纹'))));
    assert.equal(store.view().library.albums.length, 2);
    assert.ok(store.view().library.albums.some(a => a.id === album.id));
    const data = store.read(); delete data.fileIdentities;
    assert.equal(parseLocalData(JSON.stringify(data)).fileIdentities, undefined);
    for (const fileIdentities of [null, [], { id: null }, { id: {} }, { id: { sha256: 'bad', size: 1 } }])
      assert.throws(() => parseLocalData(JSON.stringify({ ...data, fileIdentities })));
  } finally { await store.close(); }
});

test('cancellation during a streaming hash closes the file and leaves the store unchanged', async () => {
  const { root, store } = await setup();
  try {
    const large = path.join(root, 'hash-only.bin');
    await writeFile(large, Buffer.alloc(16 * 1024 * 1024, 1));
    const controller = new AbortController(), before = store.read();
    const hashing = hashMusicFile(large, await stat(large), controller.signal);
    setTimeout(() => controller.abort(), 2);
    await assert.rejects(hashing);
    await rename(large, large + '.closed');
    assert.deepEqual(store.read(), before);
  } finally { await store.close(); }
});

test('every path change requires a fresh latest-state backup and a failed backup leaves old paths intact', async () => {
  const { root, music, directory, store, album, track } = await setup();
  try {
    await store.backup();
    await store.transact(data => applyLocalWrite(data, { type: 'updateAlbum', albumId: album.id,
      baseRevision: 0, patch: { title: '需备份的最新资料' } }));
    const revision = store.view().library.revision;
    const moved = path.join(root, 'moved'); await rename(music, moved);
    const incoming = await scanAt(moved, directory);
    await store.transact(data => mergeScan(data, incoming));
    const backups = await listLocalBackups(directory);
    const latest = backups.valid.find(backup => backup.libraryRevision === revision)!;
    assert.ok(latest);
    const saved = parseLocalData(JSON.parse(await readFile(path.join(directory, 'backups', latest.id), 'utf8')).payload);
    assert.equal(saved.library.albums[0].title, '需备份的最新资料');
    assert.ok(saved.files[track.id].path.startsWith(music));
    await rename(path.join(directory, 'backups'), path.join(directory, 'saved-backups'));
    await writeFile(path.join(directory, 'backups'), 'block new backup directory');
    const again = path.join(root, 'again'); await rename(moved, again);
    const next = await scanAt(again, directory), before = store.read();
    await assert.rejects(store.transact(data => mergeScan(data, next)), /备份/);
    assert.deepEqual(store.read(), before);
  } finally { await store.close(); }
});

test('hashing checks file changes and cancellation without altering originals', async () => {
  const { music, store } = await setup();
  try {
    const file = path.join(music, '1.flac'), before = await readFile(file), info = await stat(file);
    assert.equal(await hashMusicFile(file, info, new AbortController().signal), sha(before));
    await assert.rejects(hashMusicFile(file, { ...info, size: info.size + 1 }, new AbortController().signal));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(hashMusicFile(file, info, controller.signal), /取消/);
    assert.deepEqual(await readFile(file), before);
  } finally { await store.close(); }
});

test('HTTP import relinks and serves old media IDs at the new location; rescan skips offline roots', async () => {
  const { root, music, directory, store, track, album } = await setup();
  const moved = path.join(root, 'moved'); await rename(music, moved);
  const server = await startLocalServer({ store, dataDirectory: directory, picker: async () => moved });
  const headers = { 'content-type': 'application/json', 'x-cd-token': server.token };
  const post = async (action: UIAction) => (await fetch(server.origin + '/api/task', {
    method: 'POST', headers, body: JSON.stringify(action),
  })).json();
  const wait = async (id: string) => {
    for (let n = 0; n < 300; n++) {
      const task = await (await fetch(server.origin + '/api/task/' + id, { headers })).json();
      if (task.state !== 'running') { assert.equal(task.state, 'done', JSON.stringify(task)); return task; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Task did not complete');
  };
  try {
    await wait((await post({ type: 'rescanLibrary' })).taskId);
    assert.equal(store.view().library.tracks.find(t => t.id === track.id)!.available, false);
    await wait((await post({ type: 'importFolder' })).taskId);
    assert.equal(store.view().library.albums[0].id, album.id);
    assert.equal(store.view().library.tracks.length, 2);
    const audio = await fetch(server.origin + '/api/media/' + track.id, { headers });
    assert.equal(audio.status, 200);
    assert.equal(sha(new Uint8Array(await audio.arrayBuffer())), sha(await readFile(path.join(moved, '1.flac'))));
    const missing = path.join(root, 'absent');
    await store.transact(data => data.roots.unshift(missing));
    await wait((await post({ type: 'rescanLibrary' })).taskId);
    assert.equal(store.view().library.tracks.find(t => t.id === track.id)!.available, true);
  } finally { await server.close(); await store.close(); }
});

test('offline marking preserves metadata and lyrics and only increments changed revisions', async () => {
  const { music, store } = await setup();
  try {
    const before = store.read();
    await store.transact(data => markRootUnavailable(data, music));
    const offline = store.read();
    assert.deepEqual(offline.lyricsByTrack, before.lyricsByTrack);
    assert.deepEqual(offline.library.albums, before.library.albums);
    assert.ok(offline.library.tracks.every(t => !t.available));
    await store.transact(data => markRootUnavailable(data, music));
    assert.equal(store.view().library.revision, offline.library.revision);
  } finally { await store.close(); }
});

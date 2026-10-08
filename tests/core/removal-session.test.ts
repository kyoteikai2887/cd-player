import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalSession } from '../../src/bridge/createLocalSession.ts';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { planAlbumRemoval } from '../../src/core/library.ts';
import type { LocalView } from '../../src/local/model.ts';
import type { AudioEngine, AudioSample } from '../../src/core/audio.ts';
import type { LocalClient } from '../../src/bridge/localClient.ts';
import type { LocalTask } from '../../src/local/server.ts';

function setup() {
  const demo = createDemoData();
  let view: LocalView = { library: demo.library, lyricsByTrack: demo.lyricsByTrack, settings: demo.settings };
  let sample: AudioSample = { trackId: null, playing: false, ended: false, positionMs: 0, durationMs: 0, cycle: 0 };
  let stops = 0;
  const prepared: (string | null)[] = [];
  const engine: AudioEngine = {
    async activate() {},
    async play(trackId, positionMs, playing) { sample = { trackId, positionMs, playing, durationMs: 180000, ended: false, cycle: sample.cycle + 1 }; },
    pause() { sample = { ...sample, playing: false }; },
    async resume() { sample = { ...sample, playing: true }; },
    seek(positionMs) { sample = { ...sample, positionMs }; },
    sample: () => sample,
    prepareNext(id) { prepared.push(id); }, setGain() {},
    stop() { stops++; sample = { ...sample, trackId: null, playing: false }; }, destroy() {},
  };
  const client: LocalClient = {
    initial: structuredClone(view),
    async write(action) {
      if (action.type !== 'removeAlbum') throw Error('Unexpected write');
      const plan = planAlbumRemoval(view.library, action.albumId, action.baseLibraryRevision);
      if (!plan.ok) return { ...plan, view };
      view = { ...view, library: plan.library,
        lyricsByTrack: Object.fromEntries(Object.entries(view.lyricsByTrack).filter(([id]) => !plan.trackIds.includes(id))) };
      return { ok: true, view };
    },
    async start() { return { ok: false, code: 'unsupported' }; },
    async task() { throw Error('Unexpected task'); },
  };
  const session = createLocalSession({ client, engine, autoTick: false });
  const main = session.connect('main'), mini = session.connect('mini');
  const other = view.library.tracks.find(track => track.albumId !== 'album-blue' && track.available)!;
  return { session, main, mini, client, engine, other, prepared,
    stops: () => stops, getView: () => view, updateView: (next: LocalView) => { view = next; } };
}

test('real session publishes removal on both surfaces before returning, stopping audio and clearing related editor and lyrics', async () => {
  const { session, main, mini, other, stops, prepared } = setup();
  try {
    await main.dispatch({ type: 'playTracks', trackIds: ['track-blue', other.id, 'track-blue'], startIndex: 0 });
    await main.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    await main.dispatch({ type: 'setVolume', volume: 0.4 });
    await main.dispatch({ type: 'setRepeat', repeat: 'all' });
    const before = main.getSnapshot(), oldStops = stops();
    const result = await mini.dispatch({ type: 'removeAlbum', albumId: 'album-blue', baseLibraryRevision: before.library.revision });
    assert.equal(result.ok, true);
    for (const bridge of [main, mini]) {
      const after = bridge.getSnapshot();
      assert.equal(after.library.revision, before.library.revision + 1);
      assert.equal(after.lyricsEditor, null);
      assert.equal(after.lyrics, null);
      assert.equal(after.player.status, 'idle');
      assert.equal(after.player.currentTrackId, null);
      assert.equal(after.player.positionMs, 0);
      assert.deepEqual(after.player.queue, [before.player.queue[1]]);
      assert.deepEqual([after.player.volume, after.player.repeat], [0.4, 'all']);
    }
    assert.equal(stops(), oldStops + 1);
    assert.equal(prepared.at(-1), null);
    await mini.dispatch({ type: 'togglePlayback' });
    assert.equal(main.getSnapshot().player.currentTrackId, other.id);
    assert.equal(main.getSnapshot().player.currentEntryId, before.player.queue[1].id);
  } finally { session.destroy(); }
});

test('removing a different album preserves current transport and refreshes its preloaded successor', async () => {
  const { session, main, other, stops, prepared } = setup();
  try {
    await main.dispatch({ type: 'playTracks', trackIds: ['track-blue', other.id, 'track-tv', other.id], startIndex: 0 });
    await main.dispatch({ type: 'seek', positionMs: 1450 });
    await main.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    const before = main.getSnapshot(), oldStops = stops();
    assert.equal(prepared.at(-1), other.id);
    assert.equal((await main.dispatch({ type: 'removeAlbum', albumId: other.albumId,
      baseLibraryRevision: before.library.revision })).ok, true);
    const after = main.getSnapshot();
    assert.equal(stops(), oldStops);
    assert.equal(after.player.status, before.player.status);
    assert.equal(after.player.positionMs, 1450);
    assert.equal(after.player.currentEntryId, before.player.currentEntryId);
    assert.deepEqual(after.player.queue, [before.player.queue[0], before.player.queue[2]]);
    assert.strictEqual(after.lyrics, before.lyrics);
    assert.equal(after.lyricsEditor?.trackId, 'track-blue');
    assert.equal(prepared.at(-1), 'track-tv');
  } finally { session.destroy(); }
});

test('stale confirmation returns latest library without changing playback or removing the album', async () => {
  const { session, main, updateView, getView, stops } = setup();
  try {
    await main.dispatch({ type: 'playAlbum', albumId: 'album-blue' });
    const before = main.getSnapshot(), oldStops = stops();
    updateView({ ...getView(), library: { ...getView().library, revision: before.library.revision + 1 } });
    const result = await main.dispatch({ type: 'removeAlbum', albumId: 'album-blue', baseLibraryRevision: before.library.revision });
    assert.equal(result.ok ? 'applied' : result.code, 'conflict');
    assert.equal(main.getSnapshot().library.revision, before.library.revision + 1);
    assert.ok(main.getSnapshot().library.albums.some(album => album.id === 'album-blue'));
    const current = main.getSnapshot().player;
    assert.deepEqual([current.status, current.currentTrackId, current.currentEntryId, current.positionMs],
      [before.player.status, before.player.currentTrackId, before.player.currentEntryId, before.player.positionMs]);
    assert.strictEqual(current.queue, before.player.queue);
    assert.equal(stops(), oldStops);
    assert.equal(main.getSnapshot().notices.length, 0);
  } finally { session.destroy(); }
});

test('a late older background snapshot cannot restore a removed album or its queued entries', async () => {
  const { session, main, client, getView, other } = setup();
  let finish!: (task: LocalTask) => void;
  const old = structuredClone(getView());
  client.start = async () => ({ ok: true, status: 'started', taskId: 'old-scan',
    task: { id: 'old-scan', kind: 'scan', label: 'old scan', status: 'running', cancellable: true } });
  client.task = async () => new Promise(resolve => { finish = resolve; });
  try {
    await main.dispatch({ type: 'playTracks', trackIds: ['track-blue', other.id], startIndex: 0 });
    await main.dispatch({ type: 'rescanLibrary' });
    assert.ok(finish);
    await main.dispatch({ type: 'removeAlbum', albumId: 'album-blue', baseLibraryRevision: main.getSnapshot().library.revision });
    finish({ task: { id: 'old-scan', kind: 'scan', label: 'old scan', status: 'running', cancellable: true },
      state: 'done', result: { view: old } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(!main.getSnapshot().library.albums.some(album => album.id === 'album-blue'));
    assert.deepEqual(main.getSnapshot().player.queue.map(entry => entry.trackId), [other.id]);
    assert.equal(main.getSnapshot().tasks.length, 0);
  } finally { session.destroy(); }
});

test('removal during audio loading cancels the pending activation and cannot publish playing after it completes', async () => {
  const { session, main, engine } = setup();
  let finish!: () => void;
  engine.play = async () => new Promise(resolve => { finish = resolve; });
  try {
    const play = main.dispatch({ type: 'playAlbum', albumId: 'album-blue' });
    for (let i = 0; i < 50 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(main.getSnapshot().player.status, 'buffering');
    await main.dispatch({ type: 'removeAlbum', albumId: 'album-blue', baseLibraryRevision: main.getSnapshot().library.revision });
    finish();
    assert.deepEqual(await play, { ok: true, status: 'cancelled' });
    assert.equal(main.getSnapshot().player.status, 'idle');
    assert.equal(main.getSnapshot().lyrics, null);
  } finally { session.destroy(); }
});

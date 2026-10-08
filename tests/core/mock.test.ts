import assert from 'node:assert/strict';
import test from 'node:test';
import type { LyricsDocument, LyricsEdit, PlayerBridge } from '../../src/contracts/player.ts';
import { createMockBridge, createMockSession } from '../../src/mock/createMockBridge.ts';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { parseLyrics } from '../../src/core/lyrics.ts';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await wait(2); }
  assert.fail('Expected state transition did not arrive');
}
const asEdit = (doc: LyricsDocument): LyricsEdit => ({ kind: doc.kind as LyricsEdit['kind'], language: doc.language,
  translationLanguage: doc.translationLanguage, lines: doc.lines.map(l => ({ ...l })), offsetMs: doc.offsetMs, locked: doc.locked });
const play = (bridge: PlayerBridge, trackId = 'track-blue') => bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue', startTrackId: trackId });

test('other writes publish the open editor document and retain its pending draft import', async () => {
  const session = createMockSession({ autoTick: false, taskDelayMs: 0,
    importText: async () => '[00:00.000]original import\n[00:08.000]second line' });
  const main = session.connect('main'), mini = session.connect('mini');
  try {
    await main.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    await main.dispatch({ type: 'importLyrics', trackId: 'track-blue', content: 'translation', destination: 'editorDraft', baseRevision: 0 });
    await until(() => main.getSnapshot().lyricsEditor!.pendingImport !== null);
    const pending = main.getSnapshot().lyricsEditor!.pendingImport;
    assert.equal((await mini.dispatch({ type: 'setLyricsOffset', trackId: 'track-blue', offsetMs: 240, baseRevision: 0 })).ok, true);
    assert.equal(main.getSnapshot().lyricsEditor!.document!.offsetMs, 240);
    assert.equal(main.getSnapshot().lyricsEditor!.document!.revision, 1);
    assert.strictEqual(main.getSnapshot().lyricsEditor!.pendingImport, pending);
    await mini.dispatch({ type: 'setNoLyrics', trackId: 'track-blue', kind: 'instrumental', baseRevision: 1 });
    assert.equal(main.getSnapshot().lyricsEditor!.document!.kind, 'instrumental');
    assert.equal(main.getSnapshot().lyricsEditor!.status, 'ready');
    await mini.dispatch({ type: 'setNoLyrics', trackId: 'track-blue', kind: null, baseRevision: 2 });
    await mini.dispatch({ type: 'importLyrics', trackId: 'track-blue', content: 'original', baseRevision: 3 });
    await until(() => main.getSnapshot().lyricsEditor!.document!.revision === 4);
    assert.equal(main.getSnapshot().lyricsEditor!.document!.lines[0].original, 'original import');
    assert.strictEqual(main.getSnapshot().lyricsEditor!.pendingImport, pending);
  } finally { session.destroy(); }
});

test('factory instances and separate bridges own private data; large scenario has 300 tracks', async () => {
  const a = createDemoData(), b = createDemoData(); a.library.albums[0].albumArtists.push('changed');
  assert.equal(b.library.albums[0].albumArtists.length, 1); assert.equal(createDemoData('large').library.tracks.length, 300);
  const first = createMockBridge({ autoTick: false }), second = createMockBridge({ autoTick: false });
  try {
    await play(first); await play(second);
    await first.dispatch({ type: 'setLyricsOffset', trackId: 'track-blue', baseRevision: 0, offsetMs: 200 });
    assert.equal(first.getSnapshot().lyrics!.offsetMs, 200); assert.equal(second.getSnapshot().lyrics!.offsetMs, 0);
  } finally { first.destroy(); second.destroy(); }
});
test('empty-library play fails normally without a duplicate notice', async () => {
  const bridge = createMockBridge({ scenario: 'empty', autoTick: false });
  try { const before = bridge.getSnapshot().notices;
    assert.equal((await bridge.dispatch({ type: 'togglePlayback' })).ok, false);
    assert.strictEqual(bridge.getSnapshot().notices, before);
  } finally { bridge.destroy(); }
});

test('named content and mini scenarios initialize their requested state', () => {
  for (const kind of ['spoken', 'plain', 'missing', 'partial', 'instrumental'] as const) {
    const bridge = createMockBridge({ scenario: kind, autoTick: false });
    try {
      const document = bridge.getSnapshot().lyrics!;
      if (kind === 'partial') assert.equal(document.translationStatus, 'partial');
      else assert.equal(document.kind, kind);
    } finally { bridge.destroy(); }
  }
  for (const scenario of ['transparent-mini', 'opaque-mini'] as const) {
    const bridge = createMockBridge({ scenario, surface: 'mini', autoTick: false });
    try {
      assert.equal(bridge.getSnapshot().host.surfaceVisible, true);
      assert.equal(bridge.getSnapshot().host.capabilities.transparentWindow, scenario === 'transparent-mini');
    } finally { bridge.destroy(); }
  }
});
test('position ticks retain queue/library/lyrics references and share one core across surfaces', async () => {
  let time = 1000;
  const session = createMockSession({ autoTick: false, now: () => time });
  const main = session.connect('main'), mini = session.connect('mini');
  try {
    await play(main); const before = main.getSnapshot(); assert.strictEqual(main.getSnapshot(), before);
    time += 200; session.advanceBy(200); const after = main.getSnapshot();
    assert.strictEqual(after.library, before.library); assert.strictEqual(after.player.queue, before.player.queue);
    assert.strictEqual(after.lyrics, before.lyrics); assert.strictEqual(after.host, before.host);
    assert.equal(after.player.positionMs, 200); assert.equal(mini.getSnapshot().player.positionMs, 200);
    await main.dispatch({ type: 'setWindowMode', mode: 'mini' });
    assert.equal(main.getSnapshot().host.surfaceVisible, false); assert.equal(mini.getSnapshot().host.surfaceVisible, true);
    main.destroy(); time += 200; session.advanceBy(200); assert.equal(mini.getSnapshot().player.positionMs, 400);
  } finally { session.destroy(); }
});
test('duplicate tracks have stable entry IDs; queue selection and edits preserve current identity', async () => {
  const bridge = createMockBridge({ autoTick: false });
  try {
    await bridge.dispatch({ type: 'playTracks', trackIds: ['track-blue', 'track-blue'], startIndex: 0 });
    const queue = bridge.getSnapshot().player.queue; assert.notEqual(queue[0].id, queue[1].id);
    await bridge.dispatch({ type: 'playQueueEntry', entryId: queue[1].id });
    assert.strictEqual(bridge.getSnapshot().player.queue, queue); assert.equal(bridge.getSnapshot().player.currentEntryId, queue[1].id);
    await bridge.dispatch({ type: 'moveQueueEntry', entryId: queue[1].id, toIndex: 0 });
    assert.equal(bridge.getSnapshot().player.currentQueueIndex, 0); assert.equal(bridge.getSnapshot().player.currentEntryId, queue[1].id);
    await bridge.dispatch({ type: 'removeFromQueue', entryId: queue[1].id });
    assert.equal(bridge.getSnapshot().player.currentEntryId, queue[0].id);
    await bridge.dispatch({ type: 'removeFromQueue', entryId: queue[0].id });
    assert.equal(bridge.getSnapshot().player.status, 'idle'); assert.equal(bridge.getSnapshot().player.currentEntryId, null);
  } finally { bridge.destroy(); }
});
test('manual next overrides repeat-one while natural end repeats current track', async () => {
  const session = createMockSession({ autoTick: false }), bridge = session.connect('main');
  try {
    await play(bridge); await bridge.dispatch({ type: 'setRepeat', repeat: 'one' });
    session.advanceBy(180000); assert.equal(bridge.getSnapshot().player.currentTrackId, 'track-blue');
    await bridge.dispatch({ type: 'next' }); assert.equal(bridge.getSnapshot().player.currentTrackId, 'track-tv');
  } finally { session.destroy(); }
});
test('editor import only publishes an unpaired draft payload and does not save or bump revision', async () => {
  const bridge = createMockBridge({ autoTick: false, taskDelayMs: 0,
    importText: async () => '[offset:+300]\n[00:01.000]译文' });
  try {
    await play(bridge); await bridge.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    const original = bridge.getSnapshot().lyrics!;
    const result = await bridge.dispatch({ type: 'importLyrics', trackId: 'track-blue', content: 'translation', destination: 'editorDraft' });
    assert.ok(result.ok && result.status === 'started');
    await until(() => !!bridge.getSnapshot().lyricsEditor?.pendingImport);
    const pending = bridge.getSnapshot().lyricsEditor!.pendingImport!;
    assert.equal(pending.content, 'translation'); assert.equal(pending.lines[0].original, '译文'); assert.equal(pending.lines[0].startMs, 700);
    assert.equal(pending.lines[0].translation, undefined); assert.strictEqual(bridge.getSnapshot().lyrics, original);
    assert.equal(bridge.getSnapshot().lyrics!.revision, 0);
  } finally { bridge.destroy(); }
});
test('closing/reopening editor rejects an old asynchronous draft import', async () => {
  let release: ((value: string) => void) | undefined;
  const bridge = createMockBridge({ autoTick: false, taskDelayMs: 0, importText: () => new Promise(resolve => { release = resolve; }) });
  try {
    await bridge.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    await bridge.dispatch({ type: 'importLyrics', trackId: 'track-blue', content: 'original', destination: 'editorDraft' });
    await until(() => !!release); await bridge.dispatch({ type: 'closeLyricsEditor' });
    await bridge.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' }); release!('[00:01]old');
    await until(() => bridge.getSnapshot().tasks.length === 0);
    assert.equal(bridge.getSnapshot().lyricsEditor!.pendingImport, null);
  } finally { bridge.destroy(); }
});
test('document import rechecks revision after file selection, cancellation prevents late writes', async () => {
  let release: ((value: string) => void) | undefined;
  const bridge = createMockBridge({ autoTick: false, taskDelayMs: 0, importText: () => new Promise(resolve => { release = resolve; }) });
  try {
    await play(bridge);
    await bridge.dispatch({ type: 'importLyrics', trackId: 'track-blue', content: 'original' }); await until(() => !!release);
    await bridge.dispatch({ type: 'setLyricsOffset', trackId: 'track-blue', baseRevision: 0, offsetMs: 100 });
    release!('[00:01]replacement'); await until(() => bridge.getSnapshot().tasks.length === 0);
    assert.equal(bridge.getSnapshot().lyrics!.revision, 1); assert.equal(bridge.getSnapshot().lyrics!.offsetMs, 100);
    assert.notEqual(bridge.getSnapshot().lyrics!.lines[0].original, 'replacement');
    release = undefined;
    const result = await bridge.dispatch({ type: 'importLyrics', trackId: 'track-blue', content: 'original' }); await until(() => !!release);
    const noticeCount = bridge.getSnapshot().notices.length;
    assert.ok(result.ok && result.status === 'started');
    await bridge.dispatch({ type: 'cancelTask', taskId: result.taskId }); release!('[00:01]cancelled'); await wait(10);
    assert.equal(bridge.getSnapshot().lyrics!.revision, 1); assert.equal(bridge.getSnapshot().notices.length, noticeCount);
  } finally { bridge.destroy(); }
});
test('save conflict returns latest document and clear/missing differs from no-lyrics classification', async () => {
  const bridge = createMockBridge({ autoTick: false });
  try {
    await play(bridge); const initial = bridge.getSnapshot().lyrics!;
    await bridge.dispatch({ type: 'openLyricsEditor', trackId: 'track-blue' });
    await bridge.dispatch({ type: 'setLyricsOffset', trackId: 'track-blue', baseRevision: 0, offsetMs: 200 });
    const result = await bridge.dispatch({ type: 'saveLyrics', trackId: 'track-blue', baseRevision: 0, patch: asEdit(initial) });
    assert.ok(!result.ok && result.code === 'conflict'); assert.equal(bridge.getSnapshot().lyricsEditor!.status, 'conflict');
    assert.equal(bridge.getSnapshot().lyricsEditor!.document!.offsetMs, 200);
    await bridge.dispatch({ type: 'saveLyrics', trackId: 'track-blue', baseRevision: 1, patch: { ...asEdit(initial), kind: 'missing', lines: [] } });
    assert.equal(bridge.getSnapshot().lyrics!.kind, 'missing'); assert.equal(bridge.getSnapshot().lyrics!.lines.length, 0);
    await bridge.dispatch({ type: 'setNoLyrics', trackId: 'track-blue', baseRevision: 2, kind: 'spoken' });
    assert.equal(bridge.getSnapshot().lyrics!.kind, 'spoken');
    await bridge.dispatch({ type: 'setNoLyrics', trackId: 'track-blue', baseRevision: 3, kind: null });
    assert.equal(bridge.getSnapshot().lyrics!.kind, 'missing');
  } finally { bridge.destroy(); }
});
test('locked explicit lookup fails without a notice and duration mismatch does not overwrite originals', async () => {
  const locked = createMockBridge({ autoTick: false, scenario: 'locked' });
  try { const count = locked.getSnapshot().notices.length;
    const result = await locked.dispatch({ type: 'lookupLyrics', trackId: 'track-blue' });
    assert.ok(!result.ok && result.code === 'locked'); assert.equal(locked.getSnapshot().notices.length, count);
  } finally { locked.destroy(); }
  const bridge = createMockBridge({ autoTick: false, taskDelayMs: 0, lookup: async track => ({
    document: parseLyrics('[00:00]wrong full version', track.id), durationMs: 180000 }) });
  try { await play(bridge, 'track-tv'); const lines = bridge.getSnapshot().lyrics!.lines;
    await bridge.dispatch({ type: 'lookupLyrics', trackId: 'track-tv' }); await until(() => bridge.getSnapshot().tasks.length === 0);
    assert.strictEqual(bridge.getSnapshot().lyrics!.lines, lines); assert.equal(bridge.getSnapshot().lyrics!.lookup, 'notFound');
  } finally { bridge.destroy(); }
});
test('lookup fills only missing translations and offset-only save retains source provenance', async () => {
  const data = createDemoData(), candidate = data.lyricsByTrack['track-partial'];
  candidate.lines[1].translation = '补充的原创译文'; candidate.source.translation = { kind: 'provider', name: '演示' };
  candidate.lines[0].translation = 'must not replace existing';
  const bridge = createMockBridge({ autoTick: false, taskDelayMs: 0, lookup: async () => ({ document: candidate, durationMs: 150000 }) });
  try {
    await bridge.dispatch({ type: 'playAlbum', albumId: 'album-no-cover', startTrackId: 'track-partial' });
    const original = bridge.getSnapshot().lyrics!;
    await bridge.dispatch({ type: 'lookupLyrics', trackId: 'track-partial' }); await until(() => bridge.getSnapshot().tasks.length === 0);
    const filled = bridge.getSnapshot().lyrics!;
    assert.equal(filled.lines[0].translation, original.lines[0].translation); assert.equal(filled.lines[1].translation, '补充的原创译文');
    assert.deepEqual(filled.lines.map(l => l.original), original.lines.map(l => l.original));
    await bridge.dispatch({ type: 'saveLyrics', trackId: 'track-partial', baseRevision: filled.revision, patch: { ...asEdit(filled), offsetMs: 100 } });
    assert.equal(bridge.getSnapshot().lyrics!.source.translation!.kind, 'provider');
  } finally { bridge.destroy(); }
});
test('metadata diff uses cover previews, protected changes require confirmation, stale review is atomic', async () => {
  const bridge = createMockBridge({ autoTick: false, taskDelayMs: 0 });
  try {
    await bridge.dispatch({ type: 'updateAlbum', albumId: 'album-blue', baseRevision: 0, patch: { title: 'manual title' } });
    await bridge.dispatch({ type: 'lookupMetadata', albumId: 'album-blue' }); await until(() => bridge.getSnapshot().metadataReview?.status === 'ready');
    const review = bridge.getSnapshot().metadataReview!, candidate = review.candidates[0];
    const title = candidate.changes.find(c => c.field === 'title')!, cover = candidate.changes.find(c => c.field === 'cover')!;
    assert.deepEqual(cover.to, { thumbUrl: '/covers/white.svg', width: 600, height: 600 });
    const action = { type: 'applyMetadataCandidate' as const, albumId: 'album-blue', reviewId: review.id, candidateId: candidate.id,
      changeIds: [title.id, cover.id], confirmedProtectedChangeIds: [] as string[] };
    const denied = await bridge.dispatch(action); assert.ok(!denied.ok && denied.code === 'locked');
    assert.equal(bridge.getSnapshot().library.albums[0].title, 'manual title');
    assert.equal((await bridge.dispatch({ ...action, confirmedProtectedChangeIds: [title.id] })).ok, true);
    assert.ok(bridge.getSnapshot().library.albums[0].userEditedFields.includes('title'));
    await bridge.dispatch({ type: 'lookupMetadata', albumId: 'album-blue' }); await until(() => bridge.getSnapshot().metadataReview?.status === 'ready');
    const stale = bridge.getSnapshot().metadataReview!, latest = bridge.getSnapshot().library.albums[0];
    await bridge.dispatch({ type: 'updateAlbum', albumId: latest.id, baseRevision: latest.revision, patch: { label: 'manual label' } });
    const before = bridge.getSnapshot().library;
    const rejected = await bridge.dispatch({ ...action, reviewId: stale.id, candidateId: stale.candidates[0].id,
      changeIds: stale.candidates[0].changes.map(c => c.id), confirmedProtectedChangeIds: stale.candidates[0].changes.filter(c => c.userEdited).map(c => c.id) });
    assert.ok(!rejected.ok && rejected.code === 'conflict'); assert.strictEqual(bridge.getSnapshot().library, before);
  } finally { bridge.destroy(); }
});
test('hidden main keeps dirty flag and settings merge does not clobber the other surface', async () => {
  const session = createMockSession({ autoTick: false }), main = session.connect('main'), mini = session.connect('mini');
  try {
    await main.dispatch({ type: 'reportUnsavedChanges', surface: 'main', dirty: true });
    await main.dispatch({ type: 'hideToTray' }); let prompted = false;
    assert.equal(await session.requestExit(async () => { prompted = true; return false; }), false); assert.equal(prompted, true);
    assert.equal((await mini.dispatch({ type: 'reportUnsavedChanges', surface: 'main', dirty: false })).ok, false);
    await main.dispatch({ type: 'updateSettings', patch: { ui: { main: { sort: 'title' } } } });
    await mini.dispatch({ type: 'updateSettings', patch: { ui: { mini: { tab: 'lyrics' } } } });
    assert.deepEqual(main.getSnapshot().settings.ui, { main: { sort: 'title' }, mini: { tab: 'lyrics' } });
    assert.equal((await main.dispatch({ type: 'updateSettings', patch: { accentColor: 'red' } })).ok, false);
  } finally { session.destroy(); }
});

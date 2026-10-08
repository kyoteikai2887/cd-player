import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSession } from "../../src/bridge/createLocalSession.ts";
import { createDemoData } from "../../src/mock/fixtures.ts";
import type { AudioEngine, AudioSample } from "../../src/core/audio.ts";
import type { LocalClient } from "../../src/bridge/localClient.ts";
import type { LocalTask } from '../../src/local/server.ts';
import { parseLyrics } from '../../src/core/lyrics.ts';
import { prepareLyricsReview } from '../../src/local/online/candidates.ts';

function setup() {
  const listeners = new Set<() => void>();
  const data = createDemoData();
  let sample: AudioSample = {
      trackId: null,
      positionMs: 0,
      durationMs: 0,
      playing: false,
      ended: false,
      cycle: 0,
    },
    stopped = false;
  const engine: AudioEngine = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async activate() {},
    async play(id, position, playing) {
      sample = {
        trackId: id,
        positionMs: position,
        durationMs: 180000,
        playing,
        ended: false,
        cycle: sample.cycle + 1,
      };
    },
    pause() {
      sample = { ...sample, playing: false };
    },
    async resume() {
      sample = { ...sample, playing: true };
    },
    seek(position) {
      sample = { ...sample, positionMs: position };
    },
    sample: () => sample,
    prepareNext() {},
    setGain() {},
    stop() {
      sample = { ...sample, trackId: null, playing: false };
    },
    destroy() {
      stopped = true;
    },
  };
  const client: LocalClient = {
    initial: {
      library: data.library,
      lyricsByTrack: data.lyricsByTrack,
      settings: data.settings,
    },
    async write() {
      return {
        ok: false,
        code: "conflict",
        message: "new revision",
        view: client.initial,
      };
    },
    async start() {
      return { ok: false, code: "unsupported" };
    },
    async task() {
      throw new Error("No task");
    },
  };
  const session = createLocalSession({
    client,
    engine,
    autoTick: false,
    now: () => 1000,
  });
  return {
    session,
    engine,
    client,
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
    setSample: (value: Partial<AudioSample>) => {
      sample = { ...sample, ...value };
    },
    stopped: () => stopped,
  };
}

test('online review transitions reach both surfaces; adoption publishes the new library before the result', async () => {
  const { session, client } = setup(), main = session.connect('main'), mini = session.connect('mini');
  const album = client.initial.library.albums[0], review = { id: 'review-online', albumId: album.id, baseLibraryRevision: client.initial.library.revision,
    status: 'searching' as const, candidates: [], error: null };
  let finish!: (task: LocalTask) => void;
  client.start = async () => ({ ok: true, taskId: 'metadata-job', metadataReview: review });
  client.task = async () => new Promise(resolve => { finish = resolve; });
  try {
    const started = await main.dispatch({ type: 'lookupMetadata', albumId: album.id }); assert.equal(started.ok, true);
    assert.equal(main.getSnapshot().metadataReview?.status, 'searching'); assert.equal(mini.getSnapshot().metadataReview?.id, review.id);
    finish({ task: { id: 'metadata-job', kind: 'metadata', status: 'running', cancellable: true, label: 'test' }, state: 'done', result: { metadataReview: { ...review, status: 'ready' } } });
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(main.getSnapshot().metadataReview?.status, 'ready');
    client.write = async () => ({ ok: true, view: { ...client.initial, library: { ...client.initial.library, revision: client.initial.library.revision + 1 } } });
    await main.dispatch({ type: 'applyMetadataCandidate', albumId: album.id, reviewId: review.id, candidateId: 'candidate', changeIds: ['field'], confirmedProtectedChangeIds: [] });
    assert.equal(main.getSnapshot().metadataReview, null); assert.equal(mini.getSnapshot().library.revision, client.initial.library.revision + 1);
  } finally { session.destroy(); }
});
test('closing an online review suppresses late results and displays no redundant notice for a review failure', async () => {
  for (const close of [false, true]) {
    const { session, client } = setup(), bridge = session.connect('main'), album = client.initial.library.albums[0];
    let finish!: (task: LocalTask) => void;
    const review = { id: 'review', albumId: album.id, baseLibraryRevision: 0, status: 'searching' as const, candidates: [], error: null };
    client.start = async () => ({ ok: true, taskId: 'metadata', metadataReview: review });
    client.task = async () => new Promise(resolve => { finish = resolve; }); client.write = async () => ({ ok: true });
    try {
      await bridge.dispatch({ type: 'lookupMetadata', albumId: album.id });
      if (close) await bridge.dispatch({ type: 'closeMetadataReview' });
      finish({ task: { id: 'metadata', kind: 'metadata', status: 'running', cancellable: true, label: 'test' }, state: 'failed', error: { code: 'unavailable', message: 'offline' } });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(bridge.getSnapshot().metadataReview?.status ?? null, close ? null : 'failed'); assert.equal(bridge.getSnapshot().notices.length, 0);
    } finally { session.destroy(); }
  }
});
test('lyrics searching and failure preserve content, clock reference identity and editor state across surfaces', async () => {
  const { session, client, emit, setSample } = setup(), main = session.connect('main'), mini = session.connect('mini'), id = 'track-blue';
  let finish!: (task: LocalTask) => void;
  client.start = async () => ({ ok: true, taskId: 'lyrics-job' }); client.task = async () => new Promise(resolve => { finish = resolve; });
  try {
    await main.dispatch({ type: 'playTracks', trackIds: [id], startIndex: 0 }); await main.dispatch({ type: 'openLyricsEditor', trackId: id });
    const original = main.getSnapshot().lyrics!, queue = main.getSnapshot().player.queue;
    await main.dispatch({ type: 'lookupLyrics', trackId: id });
    const searching = main.getSnapshot().lyrics!; assert.equal(searching.lookup, 'searching'); assert.equal(searching.lines, original.lines);
    setSample({ positionMs: 1000 }); emit(); assert.equal(main.getSnapshot().lyrics, searching); assert.equal(main.getSnapshot().player.queue, queue);
    assert.equal(mini.getSnapshot().lyricsEditor?.document?.lookup, 'searching');
    finish({ task: { id: 'lyrics-job', kind: 'lyrics', status: 'running', cancellable: true, label: 'test' }, state: 'failed', error: { code: 'unavailable', message: 'offline' } });
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(main.getSnapshot().lyrics?.lookup, 'failed');
    assert.equal(main.getSnapshot().lyrics?.lines, original.lines); assert.equal(main.getSnapshot().notices.length, 0);
    assert.equal(mini.getSnapshot().lyrics?.lookupError?.message, 'offline');
  } finally { session.destroy(); }
});
test('lyrics completion adopts editor document before marking lookup idle; cancellation restores the old document', async () => {
  for (const cancel of [false, true]) {
    const { session, client } = setup(), bridge = session.connect('main'), id = 'track-blue'; let finish!: (task: LocalTask) => void;
    client.start = async () => ({ ok: true, taskId: 'lyrics-job' }); client.task = async () => new Promise(resolve => { finish = resolve; });
    try {
      await bridge.dispatch({ type: 'playTracks', trackIds: [id], startIndex: 0 }); await bridge.dispatch({ type: 'openLyricsEditor', trackId: id });
      const old = bridge.getSnapshot().lyrics;
      await bridge.dispatch({ type: 'lookupLyrics', trackId: id });
      const next = { ...client.initial, library: { ...client.initial.library, revision: client.initial.library.revision + 1 },
        lyricsByTrack: { ...client.initial.lyricsByTrack, [id]: { ...parseLyrics('新原创歌词', id), revision: old!.revision + 1 } } };
      finish({ task: { id: 'lyrics-job', kind: 'lyrics', status: 'running', cancellable: true, label: 'test' }, state: cancel ? 'cancelled' : 'done',
        result: cancel ? undefined : { view: next, lyricsLookup: { trackId: id, status: 'idle' } } });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(bridge.getSnapshot().lyrics?.lookup, 'idle'); assert.equal(bridge.getSnapshot().lyricsEditor?.document, bridge.getSnapshot().lyrics);
      if (cancel) assert.equal(bridge.getSnapshot().lyrics, old); else assert.equal(bridge.getSnapshot().lyrics?.lines[0].original, '新原创歌词');
    } finally { session.destroy(); }
  }
});

test("audio events advance and finish a hidden queue with the position timer disabled", async () => {
  const { session, setSample, emit, listenerCount } = setup();
  const main = session.connect("main"),
    mini = session.connect("mini");
  try {
    await main.dispatch({
      type: "playTracks",
      trackIds: ["track-blue", "track-tv"],
      startIndex: 0,
    });
    await main.dispatch({ type: "hideToTray" });
    const seen: { track: string | null; lyrics: string | undefined }[] = [];
    mini.subscribe(() =>
      seen.push({
        track: mini.getSnapshot().player.currentTrackId,
        lyrics: mini.getSnapshot().lyrics?.trackId,
      }),
    );
    setSample({ ended: true, playing: false, positionMs: 180000 });
    emit();
    emit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(mini.getSnapshot().player.currentQueueIndex, 1);
    assert.equal(mini.getSnapshot().player.currentTrackId, "track-tv");
    assert.ok(seen.every((value) => value.track === value.lyrics));
    setSample({ ended: true, playing: false, positionMs: 180000 });
    emit();
    assert.equal(mini.getSnapshot().player.status, "paused");
    assert.equal(mini.getSnapshot().player.currentQueueIndex, 1);
    assert.equal(listenerCount(), 1);
  } finally {
    session.destroy();
  }
  assert.equal(listenerCount(), 0);
  emit();
});

test("output failure wakes the session and preserves the device error classification with one notice", async () => {
  const { session, setSample, emit } = setup();
  const bridge = session.connect("main");
  try {
    await bridge.dispatch({ type: "playAlbum", albumId: "album-blue" });
    setSample({ error: "output closed", errorCode: "device" });
    emit();
    emit();
    assert.equal(bridge.getSnapshot().player.error?.code, "device");
    assert.equal(bridge.getSnapshot().notices.length, 1);
  } finally {
    session.destroy();
  }
});
test("real session keeps one audio engine across surfaces and publishes atomic track/lyrics while retaining tick references", async () => {
  const { session, setSample, stopped } = setup(),
    main = session.connect("main"),
    mini = session.connect("mini");
  try {
    await main.dispatch({ type: "playAlbum", albumId: "album-blue" });
    const before = main.getSnapshot();
    setSample({ positionMs: 200 });
    session.tick();
    const after = main.getSnapshot();
    assert.strictEqual(after.player.queue, before.player.queue);
    assert.strictEqual(after.library, before.library);
    assert.strictEqual(after.lyrics, before.lyrics);
    setSample({
      trackId: "track-tv",
      positionMs: 10,
      durationMs: 90000,
      cycle: 2,
    });
    session.tick();
    assert.equal(main.getSnapshot().player.currentTrackId, "track-tv");
    assert.equal(main.getSnapshot().lyrics!.trackId, "track-tv");
    await main.dispatch({ type: "hideToTray" });
    main.destroy();
    setSample({ positionMs: 400 });
    session.tick();
    assert.equal(mini.getSnapshot().player.positionMs, 400);
    assert.equal(stopped(), false);
  } finally {
    session.destroy();
    assert.equal(stopped(), true);
  }
});
test("consecutive duplicate tracks advance entry identity at an audio cycle boundary", async () => {
  const { session, setSample } = setup(),
    bridge = session.connect("main");
  try {
    await bridge.dispatch({
      type: "playTracks",
      trackIds: ["track-blue", "track-blue"],
      startIndex: 0,
    });
    const first = bridge.getSnapshot().player.currentEntryId;
    setSample({ cycle: 2, positionMs: 5 });
    session.tick();
    assert.notEqual(bridge.getSnapshot().player.currentEntryId, first);
    assert.equal(bridge.getSnapshot().player.currentQueueIndex, 1);
  } finally {
    session.destroy();
  }
});
test("real write conflicts preserve a latest editor document and hide retains the exit guard", async () => {
  const { session, client } = setup(),
    bridge = session.connect("main");
  try {
    await bridge.dispatch({ type: "openLyricsEditor", trackId: "track-blue" });
    client.initial.lyricsByTrack["track-blue"] = {
      ...client.initial.lyricsByTrack["track-blue"],
      revision: 3,
      offsetMs: 150,
    };
    const result = await bridge.dispatch({
      type: "setLyricsOffset",
      trackId: "track-blue",
      baseRevision: 0,
      offsetMs: 200,
    });
    assert.ok(!result.ok && result.code === "conflict");
    assert.equal(bridge.getSnapshot().lyricsEditor!.document!.revision, 3);
    assert.equal(bridge.getSnapshot().lyricsEditor!.status, "conflict");
    await bridge.dispatch({
      type: "reportUnsavedChanges",
      surface: "main",
      dirty: true,
    });
    await bridge.dispatch({ type: "hideToTray" });
    assert.equal(await session.requestExit(async () => false), false);
    assert.equal(bridge.getSnapshot().notices.length, 0);
  } finally {
    session.destroy();
  }
});
test("volume changes made while decoding survive completion; replay after queue end reloads audio", async () => {
  const { session, engine } = setup(),
    bridge = session.connect("main");
  let release: (() => void) | undefined;
  const original = engine.play;
  engine.play = async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await original(...args);
  };
  try {
    const pending = bridge.dispatch({
      type: "playAlbum",
      albumId: "album-blue",
    });
    for (let i = 0; i < 20 && !release; i++)
      await new Promise((r) => setTimeout(r, 0));
    await bridge.dispatch({ type: "setVolume", volume: 0.2 });
    release!();
    await pending;
    assert.equal(bridge.getSnapshot().player.volume, 0.2);
    engine.play = original;
    await bridge.dispatch({
      type: "playTracks",
      trackIds: ["track-blue"],
      startIndex: 0,
    });
    await bridge.dispatch({ type: "next" });
    assert.equal(bridge.getSnapshot().player.status, "paused");
    await bridge.dispatch({ type: "togglePlayback" });
    assert.equal(bridge.getSnapshot().player.status, "playing");
    assert.equal(engine.sample().trackId, "track-blue");
  } finally {
    session.destroy();
  }
});
test("a delayed resume cannot overwrite a newer explicit track selection", async () => {
  const { session, engine } = setup(),
    bridge = session.connect("main");
  let release: (() => void) | undefined;
  try {
    await bridge.dispatch({ type: "playAlbum", albumId: "album-blue" });
    await bridge.dispatch({ type: "togglePlayback" });
    const original = engine.resume;
    engine.resume = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await original();
    };
    const pending = bridge.dispatch({ type: "togglePlayback" });
    for (let i = 0; i < 20 && !release; i++)
      await new Promise((r) => setTimeout(r, 0));
    await bridge.dispatch({
      type: "playAlbum",
      albumId: "album-blue",
      startTrackId: "track-tv",
    });
    release!();
    const result = await pending;
    assert.ok(result.ok && result.status === "cancelled");
    assert.equal(bridge.getSnapshot().player.currentTrackId, "track-tv");
  } finally {
    session.destroy();
  }
});

test("streaming underrun recovers from buffering without becoming a user pause, including hidden surfaces", async () => {
  const { session, setSample } = setup(),
    bridge = session.connect("main");
  try {
    await bridge.dispatch({ type: "playAlbum", albumId: "album-blue" });
    await bridge.dispatch({ type: "hideToTray" });
    setSample({ playing: true, buffering: true, positionMs: 500 });
    session.tick();
    assert.equal(bridge.getSnapshot().player.status, "buffering");
    setSample({ buffering: false, positionMs: 750 });
    session.tick();
    assert.equal(bridge.getSnapshot().player.status, "playing");
    assert.equal(bridge.getSnapshot().player.positionMs, 750);
    assert.equal(bridge.getSnapshot().host.surfaceVisible, false);
    setSample({ buffering: true });
    session.tick();
    await bridge.dispatch({ type: "togglePlayback" });
    assert.equal(bridge.getSnapshot().player.status, "paused");
  } finally {
    session.destroy();
  }
});

test("an asynchronous decoder error is reported once and never mistaken for queue end", async () => {
  const { session, setSample } = setup(),
    bridge = session.connect("main");
  try {
    await bridge.dispatch({ type: "playAlbum", albumId: "album-blue" });
    const entry = bridge.getSnapshot().player.currentEntryId;
    setSample({ playing: false, error: "音频文件读取中断" });
    session.tick();
    session.tick();
    assert.equal(bridge.getSnapshot().player.status, "error");
    assert.equal(bridge.getSnapshot().player.currentEntryId, entry);
    assert.equal(bridge.getSnapshot().notices.length, 1);
  } finally {
    session.destroy();
  }
});

test("a streamed track ending during buffering still advances through the existing queue", async () => {
  const { session, setSample } = setup(),
    bridge = session.connect("main");
  try {
    await bridge.dispatch({ type: "playAlbum", albumId: "album-blue" });
    setSample({ playing: true, buffering: true });
    session.tick();
    assert.equal(bridge.getSnapshot().player.status, "buffering");
    setSample({ ended: true, playing: false, buffering: false });
    session.tick();
    for (
      let i = 0;
      i < 20 && bridge.getSnapshot().player.currentTrackId !== "track-tv";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bridge.getSnapshot().player.currentTrackId, "track-tv");
  } finally {
    session.destroy();
  }
});

test("toggle while initially buffering pauses the request rather than loading the same track a second time", async () => {
  const { session, engine } = setup(),
    bridge = session.connect("main");
  let release!: () => void,
    starts = 0,
    cancelled = false;
  const originalPlay = engine.play,
    originalPause = engine.pause;
  engine.play = async (...args) => {
    starts++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (cancelled) throw new Error("cancelled");
    return originalPlay(...args);
  };
  engine.pause = () => {
    cancelled = true;
    originalPause();
  };
  try {
    const pending = bridge.dispatch({
      type: "playAlbum",
      albumId: "album-blue",
    });
    for (let i = 0; i < 20 && !release; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bridge.getSnapshot().player.status, "buffering");
    const paused = await bridge.dispatch({ type: "togglePlayback" });
    assert.equal(paused.ok, true);
    assert.equal(bridge.getSnapshot().player.status, "paused");
    release();
    const result = await pending;
    assert.ok(result.ok && result.status === "cancelled");
    assert.equal(starts, 1);
    assert.equal(bridge.getSnapshot().player.status, "paused");
  } finally {
    session.destroy();
  }
});


test('lyric candidate review crosses surfaces and draft import does not write or replace the editor document', async()=>{
  const f=setup(),main=f.session.connect('main'),mini=f.session.connect('mini');
  try {
    const track=f.client.initial.library.tracks[0],album=f.client.initial.library.albums.find(a=>a.id===track.albumId)!,doc=f.client.initial.lyricsByTrack[track.id];
    const prepared=prepareLyricsReview(track,album,doc,[{provider:'原创测试',recordId:'1',title:track.title,artistCredit:track.artistCredit,
      albumTitle:album.title,durationMs:track.durationMs,document:parseLyrics('[00:00]原创候选',track.id)}]);
    f.client.start=async()=>({ok:true,taskId:'candidate-job',lyricsReview:{...prepared.review,status:'searching'}});
    f.client.task=async()=>({task:{id:'candidate-job',kind:'lyrics',label:'搜索歌词候选',status:'running',cancellable:true},state:'done',result:{lyricsReview:prepared.review}});
    await main.dispatch({type:'searchLyricsCandidates',trackId:track.id});await new Promise(r=>setTimeout(r,0));
    assert.equal(main.getSnapshot().lyricsReview?.status,'ready');assert.equal(mini.getSnapshot().lyricsReview,main.getSnapshot().lyricsReview);
    await main.dispatch({type:'openLyricsEditor',trackId:track.id});
    f.client.write=async()=>({ok:true,view:f.client.initial,pendingImport:{id:'candidate-import',content:'original',kind:'synced',lines:prepared.review.candidates[0].document.lines,language:null,warnings:[]}});
    assert.equal((await main.dispatch({type:'applyLyricsCandidate',trackId:track.id,reviewId:prepared.review.id,candidateId:prepared.review.candidates[0].id,destination:'editorDraft'})).ok,true);
    assert.equal(main.getSnapshot().lyricsReview,null);assert.equal(main.getSnapshot().lyricsEditor!.document,doc);
    assert.equal(main.getSnapshot().lyricsEditor!.pendingImport!.id,'candidate-import');assert.equal(mini.getSnapshot().lyricsReview,null);
    assert.equal(main.getSnapshot().notices.length,0);
  }finally{f.session.destroy();}
});

test('closing a lyric review prevents late failure from reopening it or emitting a duplicate notice',async()=>{
  const f=setup(),main=f.session.connect('main');let release!:(task:LocalTask)=>void;
  try{
    const track=f.client.initial.library.tracks[0],album=f.client.initial.library.albums.find(a=>a.id===track.albumId)!;
    const p=prepareLyricsReview(track,album,f.client.initial.lyricsByTrack[track.id],[]);
    f.client.start=async()=>({ok:true,taskId:'late-review',lyricsReview:{...p.review,status:'searching'}});
    f.client.task=()=>new Promise(r=>{release=r;});f.client.write=async()=>({ok:true,view:f.client.initial});
    await main.dispatch({type:'searchLyricsCandidates',trackId:track.id});await main.dispatch({type:'closeLyricsReview'});
    release({task:{id:'late-review',kind:'lyrics',label:'搜索歌词候选',status:'running',cancellable:true},state:'failed',error:{code:'unavailable',message:'迟到错误'}});
    await new Promise(r=>setTimeout(r,0));assert.equal(main.getSnapshot().lyricsReview,null);assert.equal(main.getSnapshot().notices.length,0);
  }finally{f.session.destroy();}
});

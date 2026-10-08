import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdaptiveAudioEngine,
  canBufferAudio,
} from "../../src/core/adaptiveAudio.ts";
import type { AudioEngine, AudioSample } from "../../src/core/audio.ts";

function port() {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  let sample: AudioSample = {
    trackId: null,
    positionMs: 0,
    durationMs: 3000,
    playing: false,
    ended: false,
    cycle: 0,
  };
  const engine: AudioEngine = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async activate() {},
    async play(id, position, playing) {
      calls.push("play:" + id);
      Object.assign(sample, {
        trackId: id,
        positionMs: position,
        playing,
        cycle: sample.cycle + 1,
      });
    },
    pause() {
      calls.push("pause");
      sample.playing = false;
    },
    async resume() {
      calls.push("resume");
      sample.playing = true;
    },
    seek(position) {
      sample.positionMs = position;
    },
    sample: () => ({ ...sample }),
    prepareNext(id) {
      calls.push("next:" + id);
    },
    setGain(volume, muted) {
      calls.push(`gain:${volume}:${muted}`);
    },
    stop() {
      calls.push("stop");
      sample.trackId = null;
    },
    destroy() {
      calls.push("destroy");
    },
  };
  return {
    engine,
    calls,
    sample,
    emit: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}
const small = { size: 1000, durationMs: 3000, sampleRate: 44100, channels: 2 };
const long = { ...small, durationMs: 1200000 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("audio policy checks both compressed size and estimated PCM before full decode; unknown metadata streams", () => {
  assert.equal(canBufferAudio(small), true);
  assert.equal(canBufferAudio(long), false);
  assert.equal(canBufferAudio({ ...small, size: 129 * 1024 * 1024 }), false);
  assert.equal(
    canBufferAudio({ ...small, durationMs: 120000, sampleRate: 192000 }),
    false,
  );
  assert.equal(canBufferAudio({ ...small, durationMs: 120000 }, 192000), false);
  for (const values of [
    { durationMs: 0 },
    { sampleRate: 0 },
    { channels: 0 },
    { durationMs: Infinity },
    { size: NaN },
  ])
    assert.equal(canBufferAudio({ ...small, ...values }), false);
});

test("repeating an identical buffered track schedules a fresh source on every cycle", async () => {
  const buffered = port(),
    streamed = port();
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: async () => small,
  });
  try {
    await engine.play("same", 0, true, new AbortController().signal);
    engine.prepareNext("same");
    await flush();
    buffered.sample.cycle++;
    engine.sample();
    engine.prepareNext("same");
    await flush();
    assert.equal(
      buffered.calls.filter((call) => call === "next:same").length,
      2,
    );
  } finally {
    engine.destroy();
  }
});

test("small tracks preserve PCM scheduling; a long successor is never passed to the full decoder", async () => {
  const buffered = port(),
    streamed = port();
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: async (id) => (id === "long" ? long : small),
  });
  try {
    await engine.play("short", 0, true, new AbortController().signal);
    engine.prepareNext("second");
    await flush();
    assert.ok(buffered.calls.includes("next:second"));
    engine.prepareNext("long");
    await flush();
    assert.ok(!buffered.calls.includes("next:long"));
    assert.ok(buffered.calls.includes("next:null"));
    await engine.play("long", 1500, true, new AbortController().signal);
    assert.ok(streamed.calls.includes("play:long"));
    assert.ok(!buffered.calls.includes("play:long"));
    assert.equal(engine.sample().positionMs, 1500);
  } finally {
    engine.destroy();
  }
});

test("switching between backends and a buffered promotion retain monotonically increasing playback cycles", async () => {
  const buffered = port(),
    streamed = port();
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: async (id) => (id === "long" ? long : small),
  });
  try {
    await engine.play("short", 0, true, new AbortController().signal);
    const a = engine.sample().cycle;
    buffered.sample.cycle++;
    buffered.sample.trackId = "second";
    assert.equal(engine.sample().cycle, a + 1);
    await engine.play("long", 0, true, new AbortController().signal);
    assert.equal(engine.sample().cycle, a + 2);
    await engine.play("short", 0, true, new AbortController().signal);
    assert.equal(engine.sample().cycle, a + 3);
  } finally {
    engine.destroy();
  }
});

test("a superseded successor metadata lookup cannot replace a newer scheduled track", async () => {
  const buffered = port(),
    streamed = port();
  let release!: (value: typeof small) => void;
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: (id) =>
      id === "stale"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(small),
  });
  try {
    await engine.play("short", 0, true, new AbortController().signal);
    engine.prepareNext("stale");
    engine.prepareNext("latest");
    await flush();
    release(small);
    await flush();
    assert.ok(buffered.calls.includes("next:latest"));
    assert.ok(!buffered.calls.includes("next:stale"));
  } finally {
    engine.destroy();
  }
});

test("stop during metadata lookup aborts the request and prevents late playback", async () => {
  const buffered = port(),
    streamed = port();
  let release!: (value: typeof small) => void, signal!: AbortSignal;
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: (_, passedSignal) => {
      signal = passedSignal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const pending = engine.play("late", 0, true, new AbortController().signal);
    engine.stop();
    assert.equal(signal.aborted, true);
    release(small);
    await assert.rejects(pending);
    assert.equal(engine.sample().trackId, null);
    assert.ok(!buffered.calls.includes("play:late"));
  } finally {
    engine.destroy();
  }
});

test("volume and mute apply to either backend and failed lookup leaves no old audio playing", async () => {
  const buffered = port(),
    streamed = port();
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: async (id) => {
      if (id === "missing") throw new Error("missing");
      return long;
    },
  });
  try {
    engine.setGain(0.2, true);
    await engine.play("long", 0, true, new AbortController().signal);
    assert.ok(streamed.calls.includes("gain:0.2:true"));
    await assert.rejects(
      engine.play("missing", 0, true, new AbortController().signal),
    );
    assert.equal(engine.sample().trackId, null);
  } finally {
    engine.destroy();
  }
});

test("pause while selecting a decoder cancels the pending lookup instead of later starting audio", async () => {
  const buffered = port(),
    streamed = port();
  let release!: (value: typeof small) => void;
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  try {
    const pending = engine.play(
      "pending",
      0,
      true,
      new AbortController().signal,
    );
    engine.pause();
    release(small);
    await assert.rejects(pending);
    assert.equal(engine.sample().trackId, null);
    assert.ok(!buffered.calls.includes("play:pending"));
  } finally {
    engine.destroy();
  }
});

test("adaptive notifications follow only the active decoder and remove both subscriptions on disposal", async () => {
  const buffered = port(),
    streamed = port();
  const engine = createAdaptiveAudioEngine({
    buffered: buffered.engine,
    streaming: streamed.engine,
    info: async (id) => (id === "long" ? long : small),
  });
  const seen: (string | null)[] = [];
  engine.subscribe!(() => seen.push(engine.sample().trackId));
  await engine.play("short", 0, true, new AbortController().signal);
  buffered.emit();
  buffered.emit();
  streamed.emit();
  await flush();
  assert.deepEqual(seen, ["short"]);
  await engine.play("long", 0, true, new AbortController().signal);
  buffered.emit();
  await flush();
  assert.deepEqual(seen, ["short"]);
  streamed.emit();
  await flush();
  assert.deepEqual(seen, ["short", "long"]);
  streamed.emit();
  engine.destroy();
  await flush();
  assert.equal(buffered.listenerCount(), 0);
  assert.equal(streamed.listenerCount(), 0);
  assert.equal(seen.length, 2);
});

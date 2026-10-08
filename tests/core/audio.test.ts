import assert from "node:assert/strict";
import test from "node:test";
import { createWebAudioEngine } from "../../src/core/audio.ts";

function fakeContext() {
  const events = new EventTarget();
  const sources: { onended: (() => void) | null }[] = [];
  const starts: { when: number; offset: number; stopped: boolean }[] = [],
    gains: number[] = [],
    gainNodes: { gain: { value: number } }[] = [];
  const context = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    currentTime: 10,
    state: "suspended",
    destination: {},
    async resume() {
      if (context.state === "closed")
        throw new Error("Cannot resume closed context");
      context.state = "running";
      events.dispatchEvent(new Event("statechange"));
    },
    async close() {
      context.state = "closed";
      events.dispatchEvent(new Event("statechange"));
    },
    createGain() {
      const node = {
        gain: {
          value: 0,
          setValueAtTime(value: number) {
            gains.push(value);
          },
        },
        connect() {},
        disconnect() {},
      };
      gainNodes.push(node);
      return node;
    },
    async decodeAudioData(bytes: ArrayBuffer) {
      const duration = new Uint8Array(bytes)[0];
      return { duration, length: duration * 44100, numberOfChannels: 1 };
    },
    createBufferSource() {
      let record:
        { when: number; offset: number; stopped: boolean } | undefined;
      const source = {
        buffer: null,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() {},
        start(when: number, offset = 0) {
          record = { when, offset, stopped: false };
          starts.push(record);
        },
        stop() {
          if (record) record.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return {
    context,
    events,
    sources,
    starts,
    gains,
    gainNodes,
    engine: createWebAudioEngine({
      context: () => context as unknown as AudioContext,
      load: async () => new Uint8Array([3]).buffer,
    }),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
test("an interrupted output preserves playback intent instead of becoming a user pause", async () => {
  const { engine, context } = fakeContext();
  try {
    await engine.activate();
    await engine.play("a", 0, true, new AbortController().signal);
    context.currentTime = 11;
    context.state = "suspended";
    assert.equal(engine.sample().buffering, true);
    assert.equal(engine.sample().playing, false);
    assert.equal(engine.sample().positionMs, 1000);
    context.state = "running";
    assert.equal(engine.sample().buffering, false);
    assert.equal(engine.sample().playing, true);
    engine.pause();
    context.state = "suspended";
    assert.equal(engine.sample().buffering, false);
  } finally {
    engine.destroy();
  }
});
test("audio position follows the audio clock; pause, seek and resume recreate one source without running a UI clock", async () => {
  const { engine, context, starts } = fakeContext();
  try {
    await engine.activate();
    await engine.play("a", 0, true, new AbortController().signal);
    context.currentTime = 11.25;
    assert.equal(engine.sample().positionMs, 1250);
    engine.pause();
    context.currentTime = 20;
    assert.equal(engine.sample().positionMs, 1250);
    engine.seek(500);
    assert.equal(engine.sample().positionMs, 500);
    await engine.resume();
    assert.equal(starts.at(-1)!.offset, 0.5);
    context.currentTime = 20.5;
    assert.equal(engine.sample().positionMs, 1000);
    engine.seek(999999);
    assert.equal(engine.sample().positionMs, 3000);
  } finally {
    engine.destroy();
  }
});
test("next source is scheduled at the exact current PCM boundary; duplicate IDs get a new playback cycle", async () => {
  const { engine, context, starts } = fakeContext();
  try {
    await engine.activate();
    await engine.play("same", 0, true, new AbortController().signal);
    const cycle = engine.sample().cycle;
    engine.prepareNext("same");
    await flush();
    assert.equal(starts[1].when, 13);
    assert.equal(starts[1].offset, 0);
    context.currentTime = 13.25;
    assert.equal(engine.sample().cycle, cycle + 1);
    assert.equal(engine.sample().positionMs, 250);
  } finally {
    engine.destroy();
  }
});
test("seek cancels the scheduled next source; mute preserves the stored volume", async () => {
  const { engine, starts, gains } = fakeContext();
  try {
    await engine.activate();
    await engine.play("a", 0, true, new AbortController().signal);
    engine.prepareNext("b");
    await flush();
    engine.seek(1000);
    assert.equal(starts[1].stopped, true);
    engine.setGain(0.3, true);
    engine.setGain(0.3, false);
    assert.deepEqual(gains, [0, 0.3]);
  } finally {
    engine.destroy();
  }
});
test("late decoding cannot resurrect playback after stop", async () => {
  const { context } = fakeContext();
  let release: ((value: ArrayBuffer) => void) | undefined;
  const engine = createWebAudioEngine({
    context: () => context as unknown as AudioContext,
    load: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  try {
    await engine.activate();
    const pending = engine.play("late", 0, true, new AbortController().signal);
    engine.stop();
    release!(new Uint8Array([3]).buffer);
    await assert.rejects(pending);
    assert.equal(engine.sample().trackId, null);
  } finally {
    engine.destroy();
  }
});
test("aborted download cannot commit a source", async () => {
  const { engine, starts } = fakeContext(),
    controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(engine.play("cancelled", 0, true, controller.signal));
    assert.equal(starts.length, 0);
  } finally {
    engine.destroy();
  }
});

test("natural end wakes the owner at a duplicate-track boundary without polling; cancelled sources are silent", async () => {
  const { engine, context, sources } = fakeContext();
  await engine.activate();
  await engine.play("same", 0, true, new AbortController().signal);
  const cycle = engine.sample().cycle;
  engine.prepareNext("same");
  await flush();
  const samples: ReturnType<typeof engine.sample>[] = [];
  const unsubscribe = engine.subscribe!(() => samples.push(engine.sample()));
  context.currentTime = 13.05;
  sources[0].onended!();
  await flush();
  assert.equal(samples.length, 1);
  assert.equal(samples[0].cycle, cycle + 1);
  assert.equal(samples[0].trackId, "same");
  assert.ok(Math.abs(samples[0].positionMs - 50) < 0.01);
  engine.pause();
  assert.equal(sources[1].onended, null);
  unsubscribe();
  engine.destroy();
});

test("output state changes notify once; closed output is a device error and disposal removes queued notifications", async () => {
  const { engine, context, events } = fakeContext();
  await engine.activate();
  await engine.play("a", 0, true, new AbortController().signal);
  const samples: ReturnType<typeof engine.sample>[] = [];
  engine.subscribe!(() => samples.push(engine.sample()));
  context.state = "suspended";
  events.dispatchEvent(new Event("statechange"));
  events.dispatchEvent(new Event("statechange"));
  await flush();
  assert.equal(samples.length, 1);
  assert.equal(samples[0].buffering, true);
  context.state = "closed";
  events.dispatchEvent(new Event("statechange"));
  await flush();
  assert.equal(samples[1].errorCode, "device");
  events.dispatchEvent(new Event("statechange"));
  engine.destroy();
  await flush();
  assert.equal(samples.length, 2);
});

test("explicit retry recreates a closed output, preserves position and gain, and cancels its old scheduled successor", async () => {
  const first = fakeContext(),
    second = fakeContext();
  second.context.currentTime = 0;
  let creations = 0;
  const engine = createWebAudioEngine({
    context: () =>
      (++creations === 1 ? first : second).context as unknown as AudioContext,
    load: async () => new Uint8Array([3]).buffer,
  });
  const updates: ReturnType<typeof engine.sample>[] = [];
  engine.subscribe!(() => updates.push(engine.sample()));
  try {
    engine.setGain(0.22, true);
    await engine.activate();
    await engine.play("a", 0, true, new AbortController().signal);
    engine.prepareNext("b");
    await flush();
    first.context.currentTime = 11.25;
    await first.context.close();
    await flush();
    assert.equal(engine.sample().errorCode, "device");
    assert.equal(creations, 1, "sampling must not restart closed output");
    engine.pause();
    await engine.activate();
    await engine.resume();
    assert.equal(creations, 2);
    assert.equal(first.starts[1].stopped, true);
    assert.equal(engine.sample().trackId, "a");
    assert.equal(engine.sample().error, undefined);
    assert.equal(engine.sample().playing, true);
    assert.equal(engine.sample().positionMs, 1250);
    assert.equal(second.starts[0].offset, 1.25);
    assert.equal(second.gainNodes[0].gain.value, 0);
    engine.setGain(0.22, false);
    assert.equal(second.gains.at(-1), 0.22);
    await flush();
    const count = updates.length;
    first.events.dispatchEvent(new Event("statechange"));
    await flush();
    assert.equal(
      updates.length,
      count,
      "retired output must not wake the owner",
    );
  } finally {
    engine.destroy();
  }
});

test("a user pause wins over delayed Web Audio resume", async () => {
  const { engine, context, starts } = fakeContext();
  try {
    await engine.activate();
    await engine.play("a", 1000, false, new AbortController().signal);
    let release!: () => void;
    context.resume = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = engine.resume();
    engine.pause();
    release();
    await pending;
    assert.equal(starts.length, 0);
    assert.equal(engine.sample().playing, false);
    assert.equal(engine.sample().positionMs, 1000);
  } finally {
    engine.destroy();
  }
});

test("closed output at a scheduled boundary stays a device error instead of promoting the queue", async () => {
  const { engine, context } = fakeContext();
  try {
    await engine.activate();
    await engine.play("a", 0, true, new AbortController().signal);
    engine.prepareNext("b");
    await flush();
    const cycle = engine.sample().cycle;
    context.currentTime = 13;
    await context.close();
    assert.equal(engine.sample().errorCode, "device");
    assert.equal(engine.sample().trackId, "a");
    assert.equal(engine.sample().cycle, cycle);
    assert.equal(engine.sample().ended, false);
  } finally {
    engine.destroy();
  }
});

test("failed output recreation preserves a safe error sample and a later explicit retry can succeed", async () => {
  const first = fakeContext(),
    second = fakeContext();
  let attempts = 0;
  const engine = createWebAudioEngine({
    context: () => {
      attempts++;
      if (attempts === 2) throw new Error("Output still unavailable");
      return (attempts === 1 ? first : second)
        .context as unknown as AudioContext;
    },
    load: async () => new Uint8Array([3]).buffer,
  });
  try {
    await engine.activate();
    await engine.play("a", 500, true, new AbortController().signal);
    first.context.currentTime += 0.75;
    await first.context.close();
    await assert.rejects(engine.activate(), /unavailable/);
    assert.equal(engine.sample().trackId, "a");
    assert.equal(engine.sample().positionMs, 1250);
    assert.equal(engine.sample().errorCode, "device");
    assert.equal(engine.sample().playing, false);
    await engine.activate();
    await engine.resume();
    assert.equal(engine.sample().positionMs, 1250);
    assert.equal(engine.sample().playing, true);
  } finally {
    engine.destroy();
  }
});

test("disposing an already closed output does not close it again", async () => {
  const { engine, context } = fakeContext();
  await engine.activate();
  await context.close();
  let redundantCloses = 0;
  context.close = async () => {
    redundantCloses++;
  };
  engine.destroy();
  engine.destroy();
  assert.equal(redundantCloses, 0);
});

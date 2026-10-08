import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingAudioEngine } from "../../src/core/streamingAudio.ts";

class Media extends EventTarget {
  src = "";
  preload = "";
  volume = 1;
  muted = false;
  currentTime = 0;
  duration = 1200;
  readyState = 0;
  paused = true;
  ended = false;
  seeking = false;
  error: { code: number } | null = null;
  metadata = true;
  loadCount = 0;
  playWork: (() => Promise<void>) | undefined;
  load() {
    this.loadCount++;
    if (!this.src) {
      this.readyState = 0;
      return;
    }
    if (this.metadata) {
      this.readyState = 4;
      this.dispatchEvent(new Event("loadedmetadata"));
    }
  }
  play() {
    this.paused = false;
    return this.playWork?.() ?? Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}
function setup(timeoutMs = 1000) {
  const instances: Media[] = [];
  const engine = createStreamingAudioEngine({
    timeoutMs,
    media: () => {
      const media = new Media();
      instances.push(media);
      return media as unknown as HTMLAudioElement;
    },
  });
  return { engine, instances };
}

test("an unexpected media pause is buffering until output resumes; an explicit pause clears intent", async () => {
  const { engine, instances } = setup();
  try {
    await engine.play("large", 0, true, new AbortController().signal);
    const media = instances[0];
    media.paused = true;
    assert.equal(engine.sample().playing, false);
    assert.equal(engine.sample().buffering, true);
    media.paused = false;
    assert.equal(engine.sample().playing, true);
    assert.equal(engine.sample().buffering, false);
    engine.pause();
    assert.equal(engine.sample().buffering, false);
  } finally {
    engine.destroy();
  }
});

test("large media plays without ArrayBuffer decoding; pause/resume/seek read the real media clock", async () => {
  const { engine, instances } = setup();
  try {
    engine.setGain(0.25, true);
    await engine.play("large/id", 100000, true, new AbortController().signal);
    const media = instances[0];
    assert.equal(media.src, "/api/media/large%2Fid");
    assert.equal(media.preload, "metadata");
    assert.equal(media.volume, 0.25);
    assert.equal(media.muted, true);
    assert.equal(engine.sample().durationMs, 1200000);
    assert.equal(engine.sample().positionMs, 100000);
    engine.pause();
    assert.equal(engine.sample().playing, false);
    assert.equal(media.paused, true);
    engine.seek(900000);
    await engine.resume();
    assert.equal(engine.sample().positionMs, 900000);
    assert.equal(media.paused, false);
    engine.setGain(0.25, false);
    assert.equal(media.muted, false);
    engine.seek(999999999);
    assert.equal(engine.sample().positionMs, 1200000);
  } finally {
    engine.destroy();
  }
  assert.equal(instances[0].src, "");
});

test("waiting and seeking are buffering, not a user pause; end and decoder error remain distinct", async () => {
  const { engine, instances } = setup();
  try {
    await engine.play("large", 0, true, new AbortController().signal);
    const media = instances[0];
    media.readyState = 2;
    assert.equal(engine.sample().buffering, true);
    assert.equal(engine.sample().playing, true);
    media.readyState = 4;
    media.seeking = true;
    assert.equal(engine.sample().buffering, true);
    media.seeking = false;
    assert.equal(engine.sample().buffering, false);
    media.ended = true;
    assert.equal(engine.sample().ended, true);
    media.ended = false;
    media.error = { code: 2 };
    assert.match(engine.sample().error!, /读取中断/);
    assert.equal(engine.sample().ended, false);
  } finally {
    engine.destroy();
  }
});

test("abort during metadata loading unloads the element and a late metadata event cannot play", async () => {
  const media = new Media();
  media.metadata = false;
  const engine = createStreamingAudioEngine({
    media: () => media as unknown as HTMLAudioElement,
  });
  const controller = new AbortController();
  try {
    const pending = engine.play("late", 0, true, controller.signal);
    controller.abort();
    await assert.rejects(pending, /取消/);
    media.readyState = 4;
    media.dispatchEvent(new Event("loadedmetadata"));
    assert.equal(media.paused, true);
    assert.equal(media.src, "");
    assert.equal(engine.sample().trackId, null);
  } finally {
    engine.destroy();
  }
});

test("stopping a pending play promise prevents a late success from resurrecting audio", async () => {
  const media = new Media();
  let release!: () => void;
  media.playWork = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const engine = createStreamingAudioEngine({
    media: () => media as unknown as HTMLAudioElement,
  });
  try {
    const pending = engine.play("late", 0, true, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.stop();
    release();
    await assert.rejects(pending);
    assert.equal(media.paused, true);
    assert.equal(media.src, "");
    assert.equal(engine.sample().trackId, null);
  } finally {
    engine.destroy();
  }
});

test("pause wins over a delayed resume and does not turn into a playing sample", async () => {
  const { engine, instances } = setup();
  try {
    await engine.play("large", 0, false, new AbortController().signal);
    const media = instances[0];
    let release!: () => void;
    media.playWork = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = engine.resume();
    engine.pause();
    release();
    await assert.rejects(pending);
    assert.equal(engine.sample().playing, false);
    assert.equal(media.paused, true);
  } finally {
    engine.destroy();
  }
});

test("missing decoder support rejects once and unloads its media resource", async () => {
  const media = new Media();
  media.load = () => {
    if (media.src) {
      media.error = { code: 4 };
      media.dispatchEvent(new Event("error"));
    }
  };
  const engine = createStreamingAudioEngine({
    media: () => media as unknown as HTMLAudioElement,
  });
  try {
    await assert.rejects(
      engine.play("bad", 0, true, new AbortController().signal),
      /格式/,
    );
    assert.equal(media.src, "");
    assert.equal(engine.sample().trackId, null);
  } finally {
    engine.destroy();
  }
});

test("metadata timeout settles the operation and repeated destroy is harmless", async () => {
  const media = new Media();
  media.metadata = false;
  const engine = createStreamingAudioEngine({
    timeoutMs: 10,
    media: () => media as unknown as HTMLAudioElement,
  });
  await assert.rejects(
    engine.play("hung", 0, true, new AbortController().signal),
    /未及时/,
  );
  engine.destroy();
  engine.destroy();
  assert.equal(media.src, "");
  await assert.rejects(
    engine.play("closed", 0, true, new AbortController().signal),
    /关闭/,
  );
});

test("native media end and recovery wake the owner; replaced elements and queued notifications cannot leak", async () => {
  const { engine, instances } = setup();
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  await engine.play("a", 0, true, new AbortController().signal);
  const samples: ReturnType<typeof engine.sample>[] = [];
  engine.subscribe!(() => samples.push(engine.sample()));
  instances[0].paused = true;
  instances[0].dispatchEvent(new Event("pause"));
  await flush();
  assert.equal(samples[0].buffering, true);
  instances[0].paused = false;
  instances[0].dispatchEvent(new Event("playing"));
  await flush();
  assert.equal(samples[1].playing, true);
  instances[0].ended = true;
  instances[0].dispatchEvent(new Event("ended"));
  await flush();
  assert.equal(samples[2].ended, true);
  await engine.play("b", 0, true, new AbortController().signal);
  instances[0].dispatchEvent(new Event("ended"));
  await flush();
  assert.equal(samples.length, 3);
  instances[1].dispatchEvent(new Event("waiting"));
  engine.destroy();
  instances[1].dispatchEvent(new Event("error"));
  await flush();
  assert.equal(samples.length, 3);
});

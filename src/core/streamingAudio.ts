import type { AudioEngine, AudioSample } from "./audio.ts";
import { createAudioEvents } from "./audioEvents.ts";

/** Media-element decoder: never downloads an entire file into a JS ArrayBuffer. */
export function createStreamingAudioEngine(
  options: {
    media?: () => HTMLAudioElement;
    url?: (id: string) => string;
    timeoutMs?: number;
  } = {},
): AudioEngine {
  const events = createAudioEvents();
  let disposed = false,
    cycle = 0,
    generation = 0,
    volume = 0.7,
    muted = false;
  type Current = {
    id: string;
    media: HTMLAudioElement;
    playing: boolean;
    unwatch: () => void;
  };
  let current: Current | null = null,
    operation: AbortController | null = null;
  const timeout = options.timeoutMs ?? 5000;
  const cancel = () => {
    generation++;
    operation?.abort();
    operation = null;
  };
  function release(target: Current) {
    target.unwatch();
    target.playing = false;
    target.media.pause();
    target.media.removeAttribute("src");
    target.media.load();
  }
  const mediaError = (media: HTMLAudioElement) =>
    new Error(
      media.error?.code === 2
        ? "音频文件读取中断，请重新扫描或重试。"
        : media.error?.code === 4
          ? "当前系统无法播放此音频格式。"
          : "音频解码失败，请重试。",
    );
  /** All listeners/timers are removed for success, error, cancellation and timeout. */
  function bounded(
    target: Current,
    signal: AbortSignal,
    work: (
      resolve: () => void,
      reject: (error: unknown) => void,
    ) => (() => void) | void,
  ) {
    return new Promise<void>((resolve, reject) => {
      let cleanupWork: (() => void) | void,
        settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        target.media.removeEventListener("error", failed);
        cleanupWork?.();
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new Error("播放请求已取消。"));
      const failed = () => finish(mediaError(target.media));
      const timer = setTimeout(
        () => finish(new Error("音频加载未及时完成，请重试。")),
        timeout,
      );
      signal.addEventListener("abort", abort, { once: true });
      target.media.addEventListener("error", failed);
      if (signal.aborted) {
        abort();
        return;
      }
      if (target.media.error) {
        failed();
        return;
      }
      try {
        cleanupWork = work(
          () => finish(),
          (error) => finish(error),
        );
        if (settled) cleanupWork?.();
      } catch (error) {
        finish(error);
      }
    });
  }
  function begin(signal?: AbortSignal) {
    cancel();
    const controller = new AbortController(),
      request = generation;
    operation = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    return {
      controller,
      request,
      done: () => {
        signal?.removeEventListener("abort", abort);
        if (operation === controller) operation = null;
      },
    };
  }
  function check(target: Current, request: number, signal: AbortSignal) {
    if (
      disposed ||
      current !== target ||
      request !== generation ||
      signal.aborted
    )
      throw new Error("播放请求已取消。");
  }
  async function start(target: Current, signal: AbortSignal) {
    target.playing = true;
    await bounded(target, signal, (resolve, reject) => {
      target.media.play().then(resolve, reject);
    });
  }
  function stop() {
    cancel();
    if (current) release(current);
    current = null;
  }
  return {
    subscribe: events.subscribe,
    async activate() {
      if (disposed) throw new Error("音频引擎已关闭。");
    },
    async play(id, position, playing, signal) {
      if (disposed) throw new Error("音频引擎已关闭。");
      stop();
      const pending = begin(signal);
      const media = options.media?.() ?? new Audio();
      const target: Current = { id, media, playing: false, unwatch: () => {} };
      current = target;
      const eventNames = [
        "ended",
        "error",
        "waiting",
        "stalled",
        "playing",
        "pause",
        "seeking",
        "seeked",
        "canplay",
      ];
      const changed = () => {
        if (current === target) events.notify();
      };
      for (const name of eventNames) media.addEventListener(name, changed);
      target.unwatch = () => {
        for (const name of eventNames) media.removeEventListener(name, changed);
      };
      media.preload = "metadata";
      media.volume = volume;
      media.muted = muted;
      media.src = (
        options.url ?? ((value) => "/api/media/" + encodeURIComponent(value))
      )(id);
      try {
        check(target, pending.request, pending.controller.signal);
        await bounded(target, pending.controller.signal, (resolve) => {
          const loaded = () => {
            if (media.readyState >= 1) resolve();
          };
          media.addEventListener("loadedmetadata", loaded);
          media.load();
          loaded();
          return () => media.removeEventListener("loadedmetadata", loaded);
        });
        check(target, pending.request, pending.controller.signal);
        if (!Number.isFinite(media.duration) || media.duration <= 0)
          throw new Error("音频时长无法读取。");
        media.currentTime = Math.max(
          0,
          Math.min(position / 1000, media.duration),
        );
        if (playing) await start(target, pending.controller.signal);
        check(target, pending.request, pending.controller.signal);
        cycle++;
      } catch (error) {
        if (current === target) {
          release(target);
          current = null;
        }
        throw error;
      } finally {
        pending.done();
      }
    },
    pause() {
      cancel();
      if (current) {
        current.playing = false;
        current.media.pause();
      }
    },
    async resume(signal) {
      if (!current) return;
      const target = current,
        pending = begin(signal);
      try {
        check(target, pending.request, pending.controller.signal);
        await start(target, pending.controller.signal);
        check(target, pending.request, pending.controller.signal);
      } catch (error) {
        if (current === target && pending.request === generation) {
          target.playing = false;
          target.media.pause();
        }
        throw error;
      } finally {
        pending.done();
      }
    },
    seek(position) {
      if (!current) return;
      current.media.currentTime = Math.max(
        0,
        Math.min(position / 1000, current.media.duration),
      );
    },
    sample(): AudioSample {
      if (!current)
        return {
          trackId: null,
          positionMs: 0,
          durationMs: 0,
          playing: false,
          ended: false,
          cycle,
        };
      const media = current.media;
      const durationMs = Number.isFinite(media.duration)
        ? media.duration * 1000
        : 0;
      const ended = current.playing && media.ended;
      return {
        trackId: current.id,
        positionMs: Math.min(durationMs, Math.max(0, media.currentTime * 1000)),
        durationMs,
        playing: current.playing && !media.paused && !ended && !media.error,
        ended,
        cycle,
        buffering:
          current.playing &&
          !ended &&
          !media.error &&
          (media.paused || media.seeking || media.readyState < 3),
        ...(media.error ? { error: mediaError(media).message } : {}),
      };
    },
    // Media elements do not promise sample-accurate transitions between files.
    prepareNext() {},
    setGain(value, valueMuted) {
      volume = Math.max(0, Math.min(1, value));
      muted = valueMuted;
      if (current) {
        current.media.volume = volume;
        current.media.muted = muted;
      }
    },
    stop,
    destroy() {
      if (disposed) return;
      disposed = true;
      events.dispose();
      stop();
    },
  };
}

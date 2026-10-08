import { createWebAudioEngine } from "./audio.ts";
import type { AudioEngine, AudioSample } from "./audio.ts";
import { createStreamingAudioEngine } from "./streamingAudio.ts";
import { createAudioEvents } from "./audioEvents.ts";

/** Private audio transport data; not a UI contract or persisted library field. */
export interface AudioInfo {
  size: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
}

// Leave headroom below the validation decoder's 128 MiB per-track limits.
const bufferBudget = 96 * 1024 * 1024;
export function canBufferAudio(
  info: AudioInfo,
  outputSampleRate = 48000,
): boolean {
  if (
    Object.values(info).some((value) => !Number.isFinite(value) || value <= 0)
  )
    return false;
  if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) return false;
  if (!Number.isInteger(info.channels) || info.channels > 32) return false;
  // decodeAudioData resamples to the context's output rate. Source rate alone
  // underestimates small-rate files on a normal 48 kHz output device.
  const pcmBytes =
    Math.ceil(
      (info.durationMs / 1000) *
        Math.max(48000, info.sampleRate, outputSampleRate),
    ) *
    info.channels *
    4;
  return info.size <= bufferBudget && pcmBytes <= bufferBudget;
}

/** Small tracks keep sample-scheduled PCM playback; larger ones use media range reads. */
export function createAdaptiveAudioEngine(
  options: {
    buffered?: AudioEngine;
    streaming?: AudioEngine;
    info?: (id: string, signal: AbortSignal) => Promise<AudioInfo>;
    /** Private diagnostic option; normal playback selects automatically. */
    forceStreaming?: boolean;
  } = {},
): AudioEngine {
  const buffered = options.buffered ?? createWebAudioEngine();
  const streaming = options.streaming ?? createStreamingAudioEngine();
  const info =
    options.info ??
    (async (id, signal) => {
      const response = await fetch(
        "/api/audio-info/" + encodeURIComponent(id),
        { signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error("音频文件无法读取，请重新扫描。");
      return (await response.json()) as AudioInfo;
    });
  let active: AudioEngine | null = null,
    disposed = false,
    generation = 0;
  let loading: AbortController | null = null,
    nextLookup: AbortController | null = null;
  let nextGeneration = 0,
    pendingNext: string | null = null;
  let cycle = 0,
    backendCycle = 0;
  const events = createAudioEvents();
  const unsubscribeBuffered = buffered.subscribe?.(() => {
    if (active === buffered) events.notify();
  });
  const unsubscribeStreaming = streaming.subscribe?.(() => {
    if (active === streaming) events.notify();
  });
  function cancelNext() {
    nextGeneration++;
    nextLookup?.abort();
    nextLookup = null;
    pendingNext = null;
    buffered.prepareNext(null);
  }
  function stop() {
    generation++;
    loading?.abort();
    loading = null;
    cancelNext();
    buffered.stop();
    streaming.stop();
    active = null;
  }
  function check(signal: AbortSignal, request: number) {
    if (disposed || signal.aborted || request !== generation)
      throw new Error("播放请求已取消。");
  }
  function sample(): AudioSample {
    if (!active)
      return {
        trackId: null,
        positionMs: 0,
        durationMs: 0,
        playing: false,
        ended: false,
        cycle,
      };
    const sampled = active.sample();
    if (sampled.cycle !== backendCycle) {
      cycle++;
      backendCycle = sampled.cycle;
      // A repeated track ID still needs a fresh successor after each promotion.
      nextGeneration++;
      nextLookup?.abort();
      nextLookup = null;
      pendingNext = null;
    }
    return { ...sampled, cycle };
  }
  return {
    subscribe: events.subscribe,
    activate: () => buffered.activate(),
    async play(id, position, playing, signal) {
      stop();
      const request = generation,
        controller = new AbortController();
      loading = controller;
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      try {
        check(controller.signal, request);
        const metadata = await info(id, controller.signal);
        check(controller.signal, request);
        const selected =
          !options.forceStreaming &&
          canBufferAudio(metadata, buffered.outputSampleRate?.())
            ? buffered
            : streaming;
        active = selected;
        await selected.play(id, position, playing, controller.signal);
        check(controller.signal, request);
        backendCycle = selected.sample().cycle;
        cycle++;
      } catch (error) {
        if (request === generation) {
          active?.stop();
          active = null;
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        if (loading === controller) loading = null;
      }
    },
    pause() {
      if (loading) {
        stop();
        return;
      }
      cancelNext();
      active?.pause();
    },
    async resume(signal) {
      await active?.resume(signal);
    },
    seek(position) {
      cancelNext();
      active?.seek(position);
    },
    sample,
    prepareNext(id) {
      if (id === pendingNext) return;
      cancelNext();
      if (!id || active !== buffered || !buffered.sample().playing) return;
      pendingNext = id;
      const request = nextGeneration,
        controller = new AbortController();
      nextLookup = controller;
      void info(id, controller.signal)
        .then((metadata) => {
          if (
            disposed ||
            controller.signal.aborted ||
            request !== nextGeneration ||
            active !== buffered
          )
            return;
          if (canBufferAudio(metadata, buffered.outputSampleRate?.()))
            buffered.prepareNext(id);
          // A streamed successor is started by the session's existing ended path.
        })
        .catch(() => {
          // Preloading is optional. The eventual foreground play reports its error once.
        });
    },
    setGain(volume, muted) {
      buffered.setGain(volume, muted);
      streaming.setGain(volume, muted);
    },
    stop,
    destroy() {
      if (disposed) return;
      disposed = true;
      unsubscribeBuffered?.();
      unsubscribeStreaming?.();
      events.dispose();
      stop();
      buffered.destroy();
      streaming.destroy();
    },
  };
}

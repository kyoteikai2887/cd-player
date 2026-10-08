import { createAudioEvents } from "./audioEvents.ts";

/** Audio output stays behind this port, independent of React and desktop-window ownership. */
export interface AudioSample {
  trackId: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  ended: boolean;
  cycle: number;
  /** Internal decoder state; kept out of the shared UI contract. */
  buffering?: boolean;
  error?: string;
  errorCode?: "decode" | "device";
}
export interface AudioEngine {
  activate(): Promise<void>;
  play(
    trackId: string,
    positionMs: number,
    playing: boolean,
    signal: AbortSignal,
  ): Promise<void>;
  pause(): void;
  resume(signal?: AbortSignal): Promise<void>;
  seek(positionMs: number): void;
  sample(): AudioSample;
  prepareNext(trackId: string | null): void;
  setGain(volume: number, muted: boolean): void;
  stop(): void;
  destroy(): void;
  /** Optional internal sizing hint for decodeAudioData's output resampling. */
  outputSampleRate?(): number;
  /** Internal end/output notifications; position snapshots still use a 5 Hz timer. */
  subscribe?(listener: () => void): () => void;
}

export function createWebAudioEngine(
  options: {
    context?: () => AudioContext;
    load?: (id: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  } = {},
): AudioEngine {
  const events = createAudioEvents();
  let context: AudioContext | null = null,
    gain: GainNode | null = null,
    disposed = false;
  let current: {
    id: string;
    buffer: AudioBuffer;
    source: AudioBufferSourceNode | null;
    anchor: number;
    position: number;
    playing: boolean;
  } | null = null;
  let next: {
    id: string;
    buffer: AudioBuffer;
    source: AudioBufferSourceNode;
    at: number;
  } | null = null;
  let preload: AbortController | null = null,
    generation = 0,
    pendingNext: string | null = null;
  let volume = 0.7,
    muted = false,
    cycle = 0,
    playGeneration = 0;
  const maximumPCMBytes = 128 * 1024 * 1024;
  const ensure = () => {
    if (disposed) throw new Error("音频引擎已关闭。");
    if (context?.state === "closed")
      throw new Error("音频输出已关闭，请点击播放重试。");
    if (!context) {
      context = options.context ? options.context() : new AudioContext();
      context.addEventListener("statechange", events.notify);
      gain = context.createGain();
      gain.gain.value = muted ? 0 : volume;
      gain.connect(context.destination);
    }
    return context;
  };
  const load =
    options.load ??
    (async (id, signal) => {
      const response = await fetch("/api/media/" + encodeURIComponent(id), {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("音频文件无法读取，请重新扫描。");
      if (Number(response.headers.get("content-length")) > 128 * 1024 * 1024)
        throw new Error("此验证引擎暂不支持超过128MB的单个音频文件。");
      return response.arrayBuffer();
    });
  const decode = async (id: string, signal: AbortSignal) => {
    const ctx = ensure(),
      data = await load(id, signal);
    if (signal.aborted) throw new Error("播放请求已取消。");
    const buffer = await ctx.decodeAudioData(data);
    if (signal.aborted || disposed) throw new Error("播放请求已取消。");
    if (buffer.length * buffer.numberOfChannels * 4 > maximumPCMBytes)
      throw new Error(
        "曲目解码后超过验证引擎的内存限制，后续桌面引擎将使用流式解码。",
      );
    return buffer;
  };
  const stopSource = (source: AudioBufferSourceNode | null) => {
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* Already finished. */
    }
    source.disconnect();
  };
  const cancelNext = () => {
    generation++;
    preload?.abort();
    preload = null;
    pendingNext = null;
    if (next) stopSource(next.source);
    next = null;
  };
  const sourceFor = (buffer: AudioBuffer) => {
    const source = ensure().createBufferSource();
    source.buffer = buffer;
    source.connect(gain!);
    source.onended = () => {
      if (source === current?.source || source === next?.source)
        events.notify();
    };
    return source;
  };
  function promote() {
    if (
      next &&
      context &&
      context.state !== "closed" &&
      context.currentTime >= next.at
    ) {
      if (current?.source) {
        current.source.onended = null;
        current.source.disconnect();
      }
      current = {
        id: next.id,
        buffer: next.buffer,
        source: next.source,
        anchor: next.at,
        position: 0,
        playing: true,
      };
      cycle++;
      next = null;
      pendingNext = null;
    }
  }
  function sample(): AudioSample {
    promote();
    if (!current)
      return {
        trackId: null,
        positionMs: 0,
        durationMs: 0,
        playing: false,
        ended: false,
        cycle,
      };
    const durationMs = current.buffer.duration * 1000;
    const outputState = context?.state ?? "closed";
    const positionMs =
      current.playing && context
        ? Math.min(
            durationMs,
            Math.max(0, (context!.currentTime - current.anchor) * 1000),
          )
        : current.position;
    return {
      trackId: current.id,
      positionMs,
      durationMs,
      playing:
        current.playing && outputState === "running" && positionMs < durationMs,
      ended:
        current.playing && outputState !== "closed" && positionMs >= durationMs,
      cycle,
      buffering:
        current.playing &&
        positionMs < durationMs &&
        outputState !== "running" &&
        outputState !== "closed",
      ...(outputState === "closed"
        ? {
            error: "音频输出已关闭，请点击播放重试。",
            errorCode: "device" as const,
          }
        : {}),
    };
  }
  /** Closed contexts cannot resume. Rebuild only on an explicit activation/retry. */
  function recoverClosedOutput() {
    if (disposed) throw new Error("音频引擎已关闭。");
    if (context?.state !== "closed") return;
    const position = sample().positionMs;
    playGeneration++;
    cancelNext();
    stopSource(current?.source ?? null);
    if (current) {
      current.source = null;
      current.position = position;
      current.playing = false;
    }
    context.removeEventListener("statechange", events.notify);
    gain?.disconnect();
    context = null;
    gain = null;
  }
  function startCurrent(positionMs: number) {
    if (!current) return;
    const position = Math.max(
      0,
      Math.min(positionMs, current.buffer.duration * 1000),
    );
    const source = sourceFor(current.buffer),
      at = context!.currentTime;
    current.source = source;
    current.position = position;
    current.anchor = at - position / 1000;
    current.playing = true;
    source.start(at, position / 1000);
  }
  return {
    subscribe: events.subscribe,
    outputSampleRate: () => ensure().sampleRate,
    async activate() {
      recoverClosedOutput();
      await ensure().resume();
    },
    async play(id, positionMs, playing, signal) {
      const request = ++playGeneration;
      const buffer = await decode(id, signal);
      if (signal.aborted || playGeneration !== request)
        throw new Error("播放请求已被新操作替代。");
      cancelNext();
      stopSource(current?.source ?? null);
      current = {
        id,
        buffer,
        source: null,
        anchor: ensure().currentTime,
        position: Math.min(buffer.duration * 1000, Math.max(0, positionMs)),
        playing: false,
      };
      cycle++;
      if (playing) startCurrent(positionMs);
    },
    pause() {
      playGeneration++;
      const sampled = sample();
      cancelNext();
      if (!current) return;
      stopSource(current.source);
      current.source = null;
      current.position = sampled.positionMs;
      current.playing = false;
    },
    async resume(signal) {
      if (signal?.aborted) return;
      recoverClosedOutput();
      const target = current;
      const request = playGeneration;
      await ensure().resume();
      if (
        !disposed &&
        !signal?.aborted &&
        request === playGeneration &&
        current === target &&
        current &&
        !current.playing
      )
        startCurrent(current.position);
    },
    seek(positionMs) {
      playGeneration++;
      const playing = current?.playing;
      cancelNext();
      stopSource(current?.source ?? null);
      if (!current) return;
      current.position = Math.max(
        0,
        Math.min(positionMs, current.buffer.duration * 1000),
      );
      current.source = null;
      current.playing = false;
      if (playing) startCurrent(current.position);
    },
    sample,
    prepareNext(id) {
      promote();
      if (id === pendingNext) return;
      cancelNext();
      if (!id || !current?.playing) return;
      const baseline = generation,
        controller = new AbortController();
      preload = controller;
      pendingNext = id;
      void (
        id === current.id
          ? Promise.resolve(current.buffer)
          : decode(id, controller.signal)
      )
        .then((buffer) => {
          if (disposed || generation !== baseline || !current?.playing) return;
          const at = current.anchor + current.buffer.duration;
          if (at <= context!.currentTime + 0.005) {
            pendingNext = null;
            return;
          }
          const source = sourceFor(buffer);
          source.start(at);
          next = { id, buffer, source, at };
        })
        .catch(() => {
          if (generation === baseline) pendingNext = null;
        });
    },
    setGain(value, valueMuted) {
      volume = Math.max(0, Math.min(1, value));
      muted = valueMuted;
      if (gain && context)
        gain.gain.setValueAtTime(muted ? 0 : volume, context.currentTime);
    },
    stop() {
      playGeneration++;
      cancelNext();
      stopSource(current?.source ?? null);
      current = null;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      events.dispose();
      context?.removeEventListener("statechange", events.notify);
      cancelNext();
      stopSource(current?.source ?? null);
      current = null;
      if (context && context.state !== "closed")
        void context.close().catch(() => {});
    },
  };
}

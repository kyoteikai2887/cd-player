import { useEffect, useReducer, useRef } from 'react';
import type { LyricLine, PlayerSnapshot } from '../../contracts/player.ts';
import { activeLyricIndex, nextLyricBoundary } from '../../core/lyrics.ts';
import { EXTRAPOLATION_CAP_MS, extrapolationRemaining, lyricWakeDelay, renderPosition } from './clock.ts';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const hasRaf = () => typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';

/**
 * Display time for text (≈4 Hz while playing and visible). Every new sample re-anchors;
 * nothing is accumulated, and extrapolation stops at the 750 ms cap.
 * `preview` (scrubbing / clicked lyric) overrides the display without touching playback.
 */
export function useRenderPos(player: PlayerSnapshot, active: boolean, preview: number | null = null, hz = 4): number {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const position = preview ?? renderPosition(player, now());
  useEffect(() => {
    if (preview !== null || !active || player.status !== 'playing') return;
    const started = now();
    const interval = setInterval(() => {
      tick();
      if (now() - started > EXTRAPOLATION_CAP_MS + 1000 / hz) clearInterval(interval);
    }, 1000 / hz);
    return () => clearInterval(interval);
  }, [player, active, preview, hz]);
  return position;
}

/**
 * Calls `apply(fraction)` every animation frame while playing, visible and within the
 * extrapolation budget; once otherwise. Callers write transforms directly (composited, no layout),
 * so React does not re-render per frame.
 */
export function useProgressFrames(apply: (fraction: number) => void, player: PlayerSnapshot, active: boolean, preview: number | null) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const duration = Math.max(0, player.durationMs);
    const write = (pos: number) => applyRef.current(duration ? Math.min(1, Math.max(0, pos / duration)) : 0);
    if (preview !== null) { write(preview); return; }
    write(renderPosition(player, now()));
    if (!active || player.status !== 'playing' || !hasRaf()) return;
    let frame = 0;
    const loop = () => {
      const t = now();
      write(renderPosition(player, t));
      if (extrapolationRemaining(player, t) > 0) frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [player, active, preview]);
}

/**
 * Active synced line, re-evaluated exactly at the next boundary (no polling).
 * Re-scheduled on every sample, document, offset or visibility change.
 */
export function useActiveLyric(lines: readonly LyricLine[] | null, offsetMs: number, player: PlayerSnapshot,
  active: boolean, preview: number | null): number {
  const [wake, bump] = useReducer((x: number) => x + 1, 0);
  const t = now();
  const position = preview ?? renderPosition(player, t);
  const index = lines ? activeLyricIndex(lines, position, offsetMs) : -1;
  const latest = useRef({ position, t });
  latest.current = { position, t };
  useEffect(() => {
    if (!lines || preview !== null || !active || player.status !== 'playing') return;
    const { position: pos, t: at } = latest.current;
    const boundary = nextLyricBoundary(lines, pos, offsetMs);
    const delay = lyricWakeDelay(boundary, pos, extrapolationRemaining(player, at));
    if (delay === null) return;
    const timer = setTimeout(bump, delay + 1);
    return () => clearTimeout(timer);
  }, [lines, offsetMs, player, active, preview, wake]);
  return index;
}

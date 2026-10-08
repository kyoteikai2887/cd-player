import type { PlayerSnapshot } from '../../contracts/player.ts';

/** Frozen display-clock rules (CONTRACT_BEHAVIOR §2). The UI never accumulates its own time. */
export const EXTRAPOLATION_CAP_MS = 750;

export type ClockSample = Pick<PlayerSnapshot, 'status' | 'positionMs' | 'durationMs' | 'positionSampledAt'>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** age = clamp(now - sampledAt, 0, 750); renderPos = clamp(pos + (playing ? age : 0), 0, duration). */
export function renderPosition(sample: ClockSample, localNow: number): number {
  const duration = Number.isFinite(sample.durationMs) ? Math.max(0, sample.durationMs) : 0;
  const position = Number.isFinite(sample.positionMs) ? sample.positionMs : 0;
  if (sample.status !== 'playing' || !Number.isFinite(localNow) || !Number.isFinite(sample.positionSampledAt)) {
    return clamp(position, 0, duration);
  }
  const age = clamp(localNow - sample.positionSampledAt, 0, EXTRAPOLATION_CAP_MS);
  return clamp(position + age, 0, duration);
}

/** Milliseconds of extrapolation left before the display must wait for the next sample. */
export function extrapolationRemaining(sample: ClockSample, localNow: number): number {
  if (sample.status !== 'playing' || !Number.isFinite(localNow) || !Number.isFinite(sample.positionSampledAt)) return 0;
  const age = clamp(localNow - sample.positionSampledAt, 0, EXTRAPOLATION_CAP_MS);
  const untilEnd = Math.max(0, sample.durationMs - sample.positionMs - age);
  return Math.min(EXTRAPOLATION_CAP_MS - age, untilEnd);
}

/**
 * How long to wait before re-evaluating the active lyric line.
 * Returns null when there is nothing to wake for inside the current extrapolation budget;
 * the next snapshot re-schedules.
 */
export function lyricWakeDelay(boundary: number | null, renderPos: number, remaining: number): number | null {
  if (boundary === null || !Number.isFinite(boundary) || !Number.isFinite(renderPos)) return null;
  const delay = boundary - renderPos;
  if (delay > remaining) return null;
  return Math.max(0, Math.ceil(delay));
}

/** m:ss, or h:mm:ss for long tracks. Negative and invalid values show 0:00. */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** Human total for album lengths: "48 分钟" / "1 小时 12 分钟". */
export function formatTotal(ms: number): string {
  const minutes = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** Signed seconds for the offset chip: +0.3s / −1.2s / 0.0s. */
export function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms === 0) return '0.0s';
  const sign = ms > 0 ? '+' : '−';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

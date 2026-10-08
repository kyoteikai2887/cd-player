import { describe, expect, test } from 'vitest';
import { EXTRAPOLATION_CAP_MS, extrapolationRemaining, formatClock, formatOffset, formatTotal, lyricWakeDelay, renderPosition } from '../../src/ui/lib/clock.ts';
import { activeLyricIndex, nextLyricBoundary, parseLyrics } from '../../src/core/lyrics.ts';

const sample = (status: 'playing' | 'paused' | 'buffering' | 'idle' | 'error', positionMs: number, sampledAt: number, durationMs = 180000) =>
  ({ status, positionMs, positionSampledAt: sampledAt, durationMs });

describe('display clock (frozen formula)', () => {
  test('playing extrapolates from the latest sample, capped at 750 ms', () => {
    expect(renderPosition(sample('playing', 10000, 1000), 1200)).toBe(10200);
    expect(renderPosition(sample('playing', 10000, 1000), 1000 + EXTRAPOLATION_CAP_MS + 5000)).toBe(10000 + EXTRAPOLATION_CAP_MS);
  });
  test('non-playing states never extrapolate', () => {
    for (const status of ['paused', 'buffering', 'idle', 'error'] as const) {
      expect(renderPosition(sample(status, 10000, 1000), 1600)).toBe(10000);
    }
  });
  test('clock skew in the past or invalid input is clamped, never negative or past the end', () => {
    expect(renderPosition(sample('playing', 10000, 2000), 1000)).toBe(10000);
    expect(renderPosition(sample('playing', 179900, 0), 700)).toBe(180000);
    expect(renderPosition(sample('paused', -50, 0), 0)).toBe(0);
    expect(renderPosition(sample('playing', 10000, Number.NaN), 100)).toBe(10000);
  });
  test('remaining budget shrinks with age and stops at the end of the track', () => {
    expect(extrapolationRemaining(sample('playing', 0, 1000), 1200)).toBe(550);
    expect(extrapolationRemaining(sample('playing', 179800, 1000), 1000)).toBe(200);
    expect(extrapolationRemaining(sample('paused', 0, 1000), 1000)).toBe(0);
  });
  test('lyric wake-up is scheduled only inside the current extrapolation budget', () => {
    expect(lyricWakeDelay(2000, 1800, 500)).toBe(200);
    expect(lyricWakeDelay(2000, 1000, 500)).toBeNull();
    expect(lyricWakeDelay(null, 1000, 500)).toBeNull();
  });
  test('scheduling with the shared lyric functions honours breaks and user offset', () => {
    const doc = parseLyrics('[00:01]one\n[00:02]\n[00:03]two', 'x');
    const offset = 200;
    const pos = renderPosition(sample('playing', 1100, 0), 100);
    expect(activeLyricIndex(doc.lines, pos, offset)).toBe(0);
    const boundary = nextLyricBoundary(doc.lines, pos, offset);
    expect(boundary).toBe(2200);
    expect(lyricWakeDelay(boundary, pos, extrapolationRemaining(sample('playing', 1100, 0), 100))).toBeNull();
    expect(lyricWakeDelay(boundary, 2000, 650)).toBe(200);
    expect(activeLyricIndex(doc.lines, 2200, offset)).toBe(-1);
  });
});

describe('time formatting', () => {
  test('clock, totals and signed offsets', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65000)).toBe('1:05');
    expect(formatClock(3725000)).toBe('1:02:05');
    expect(formatClock(-10)).toBe('0:00');
    expect(formatTotal(48 * 60000)).toBe('48 分钟');
    expect(formatTotal(72 * 60000)).toBe('1 小时 12 分钟');
    expect(formatOffset(300)).toBe('+0.3s');
    expect(formatOffset(-1200)).toBe('−1.2s');
    expect(formatOffset(0)).toBe('0.0s');
  });
});

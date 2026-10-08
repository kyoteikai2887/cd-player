import assert from "node:assert/strict";
import test from "node:test";
import { startNativeHeartbeat } from "../../src/bridge/nativeHealth.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("idle heartbeat repeats without changing playback state and never overlaps probes", async () => {
  let active = 0, peak = 0;
  const reports: boolean[] = [];
  let enough!: () => void;
  const received = new Promise<void>((resolve) => { enough = resolve; });
  const stop = startNativeHeartbeat({
    intervalMs: 5, timeoutMs: 500,
    async probe() {
      peak = Math.max(peak, ++active);
      await pause(15);
      active--;
    },
    async report(ready) {
      reports.push(ready);
      if (reports.length === 3) enough();
    },
  });
  try {
    await received;
    assert.deepEqual(reports, [true, true, true]);
    assert.equal(peak, 1);
  } finally { stop(); }
  await pause(30);
  assert.equal(reports.length, 3);
});

test("an unresponsive probe times out, recovers, and cannot publish late success", async () => {
  let firstSignal!: AbortSignal;
  let release!: () => void;
  let count = 0;
  const reports: boolean[] = [];
  let recovered!: () => void;
  const received = new Promise<void>((resolve) => { recovered = resolve; });
  const stop = startNativeHeartbeat({
    intervalMs: 5, timeoutMs: 15,
    probe(signal) {
      if (++count === 1) {
        firstSignal = signal;
        return new Promise<void>((resolve) => { release = resolve; });
      }
      return Promise.resolve();
    },
    async report(ready) {
      reports.push(ready);
      if (ready) { stop(); recovered(); }
    },
  });
  try {
    await received;
    assert.equal(firstSignal.aborted, true);
    assert.deepEqual(reports, [false, true]);
    release();
    await pause(30);
    assert.deepEqual(reports, [false, true]);
  } finally { stop(); }
});

test("disposing an in-flight heartbeat cancels it and never reports a late response", async () => {
  let signal!: AbortSignal;
  let release!: () => void;
  const reports: boolean[] = [];
  const stop = startNativeHeartbeat({
    intervalMs: 5, timeoutMs: 500,
    probe(value) {
      signal = value;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    async report(ready) { reports.push(ready); },
  });
  stop();
  release();
  await pause(30);
  assert.equal(signal.aborted, true);
  assert.deepEqual(reports, []);
});

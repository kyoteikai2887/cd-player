import assert from "node:assert/strict";
import test from "node:test";
import { startNativeHeartbeat } from "../../src/bridge/nativeHealth.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a lost native report cannot permanently stop heartbeat recovery", async () => {
  let count = 0;
  const stop = startNativeHeartbeat({
    intervalMs: 5, timeoutMs: 15,
    async probe() {},
    report() {
      count++;
      return count === 1 ? new Promise(() => {}) : Promise.resolve();
    },
  });
  try {
    await pause(100);
    assert.ok(count >= 2, "The first unresolved IPC reply stranded all future heartbeats");
  } finally { stop(); }
});

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

test("waking interrupts a stuck probe and requests fresh health without a false report", async () => {
  let count = 0;
  let firstSignal!: AbortSignal;
  const reports: boolean[] = [];
  const stop = startNativeHeartbeat({
    intervalMs: 1000, timeoutMs: 1000,
    probe(signal) {
      if (++count === 1) { firstSignal = signal; return new Promise(() => {}); }
      return Promise.resolve();
    },
    async report(ready) { reports.push(ready); },
  });
  try {
    stop.wake();
    stop.wake();
    await pause(60);
    assert.equal(firstSignal.aborted, true);
    assert.equal(count, 2);
    assert.deepEqual(reports, [true]);
  } finally { stop(); }
  stop.wake();
  await pause(20);
  assert.equal(count, 2);
});

test("wake and disposal interrupt a stuck report without waiting for its deadline", async () => {
  let reports = 0;
  const stop = startNativeHeartbeat({
    intervalMs: 1000, timeoutMs: 1000,
    async probe() {},
    report() { reports++; return new Promise(() => {}); },
  });
  await pause(10);
  assert.equal(reports, 1);
  stop.wake();
  await pause(60);
  assert.equal(reports, 2);
  stop();
  await pause(30);
  assert.equal(reports, 2);
});

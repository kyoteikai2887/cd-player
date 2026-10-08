import assert from "node:assert/strict";
import test from "node:test";
import { createAudioEvents } from "../../src/core/audioEvents.ts";

test("audio wakeups coalesce, retain subscription identity and cancel unsubscribed pending work", async () => {
  const events = createAudioEvents();
  let count = 0;
  const listener = () => {
    count++;
  };
  const unsubscribe = events.subscribe(listener);
  events.notify();
  events.notify();
  assert.equal(count, 0);
  unsubscribe();
  events.subscribe(listener);
  await Promise.resolve();
  assert.equal(count, 0);
  events.notify();
  events.notify();
  await Promise.resolve();
  assert.equal(count, 1);
  events.notify();
  events.dispose();
  await Promise.resolve();
  assert.equal(count, 1);
});

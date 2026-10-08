import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedDispatcher } from "../../src/bridge/boundedDispatch.ts";
import { createExitGuard } from "../../src/bridge/exitGuard.ts";
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
test("transport budget includes time already spent crossing IPC and rejects expired work", async () => {
  let calls = 0,
    commits = 0;
  const dispatcher = createBoundedDispatcher(async (_action, context) => {
    calls++;
    await wait(40);
    if (context.isActive()) commits++;
    return { ok: true, status: "applied" };
  }, 1000);
  assert.equal(
    (await dispatcher.dispatch({ type: "togglePlayback" }, 0)).ok,
    false,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await dispatcher.dispatch({ type: "togglePlayback" }, 10)).ok,
    false,
  );
  await wait(50);
  assert.equal(commits, 0);
  dispatcher.destroy();
});

test("unresponsive dispatch settles and late cooperative handler cannot commit", async () => {
  let committed = false;
  const dispatcher = createBoundedDispatcher(async (_action, context) => {
    await wait(40);
    if (context.isActive()) committed = true;
    return { ok: true, status: "applied" };
  }, 10);
  const result = await dispatcher.dispatch({ type: "togglePlayback" });
  assert.deepEqual(result, {
    ok: false,
    code: "unavailable",
    message: "播放核心未及时响应，请重试。",
  });
  await wait(50);
  assert.equal(committed, false);
  dispatcher.destroy();
});
test("disposing a connection resolves pending promises", async () => {
  const dispatcher = createBoundedDispatcher(() => new Promise(() => {}));
  const pending = dispatcher.dispatch({ type: "togglePlayback" });
  dispatcher.destroy();
  assert.equal((await pending).ok, false);
  assert.equal(
    (await dispatcher.dispatch({ type: "togglePlayback" })).ok,
    false,
  );
});
test("dirty surfaces require exit confirmation; cancel preserves dirty flags", async () => {
  const guard = createExitGuard();
  guard.report("main", true);
  assert.equal(await guard.requestExit(async () => false), false);
  assert.equal(guard.hasUnsavedChanges(), true);
  assert.equal(await guard.requestExit(async () => true), true);
  guard.report("main", false);
  assert.equal(
    await guard.requestExit(async () => {
      throw new Error();
    }),
    true,
  );
});
test("changes during an exit prompt invalidate its approval", async () => {
  const guard = createExitGuard();
  guard.report("main", true);
  assert.equal(
    await guard.requestExit(async () => {
      guard.report("mini", true);
      return true;
    }),
    false,
  );
});

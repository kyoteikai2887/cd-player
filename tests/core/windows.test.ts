import assert from "node:assert/strict";
import test from "node:test";
import { fitMiniWindow } from "../../src/core/windowGeometry.ts";
import { createWindowCoordinator } from "../../src/bridge/windowCoordinator.ts";
import type { NativeWindowPort } from "../../src/bridge/windowCoordinator.ts";
import type { Surface } from "../../src/contracts/player.ts";
import type { DispatchContext } from "../../src/bridge/boundedDispatch.ts";

function context(controller = new AbortController()): DispatchContext {
  return {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
  };
}
function fixture() {
  const visible = { main: true, mini: false };
  const calls: string[] = [];
  let confirms = 0,
    exits = 0;
  const port: NativeWindowPort = {
    shell: "tauri",
    observe: (surface: Surface) => ({
      surfaceVisible: visible[surface],
      backdrop: "none",
      alwaysOnTop: false,
      nativeCornerRadius: 8,
      effectiveReducedMotion: false,
      transparencyAllowed: true,
      capabilities: {
        nativeWindows: true,
        transparentWindow: false,
        windowDragging: true,
        alwaysOnTop: true,
      },
    }),
    async show(surface) {
      calls.push("show:" + surface);
      visible[surface] = true;
    },
    async hide(surface) {
      calls.push("hide:" + surface);
      visible[surface] = false;
    },
    async miniBounds() {
      return {
        current: { x: 10, y: 900, width: 360, height: 90 },
        workArea: { x: 0, y: 0, width: 1920, height: 1000 },
      };
    },
    async resizeMini(bounds) {
      calls.push("resize:" + bounds.y);
    },
    async confirmDiscard() {
      confirms++;
      return false;
    },
    async exit() {
      exits++;
    },
  };
  const coordinator = createWindowCoordinator(port, () => {});
  return {
    port,
    calls,
    visible,
    coordinator,
    counts: () => ({ confirms, exits }),
  };
}

test("mini lyric growth stays inside the work area and grows upward at the bottom", () => {
  const result = fitMiniWindow(
    { x: 20, y: 900, width: 360, height: 90 },
    { width: 360, height: 140 },
    { x: 0, y: 0, width: 1920, height: 1000 },
  );
  assert.deepEqual(result, { x: 20, y: 860, width: 360, height: 140 });
});
test("logical bounds support negative monitor coordinates, tiny work areas and invalid input", () => {
  assert.deepEqual(
    fitMiniWindow(
      { x: -20, y: -5, width: 360, height: 90 },
      { width: 360, height: 140 },
      { x: -1920, y: -100, width: 1920, height: 1080 },
    ),
    { x: -360, y: -5, width: 360, height: 140 },
  );
  assert.deepEqual(
    fitMiniWindow(
      { x: 999, y: 999, width: 360, height: 90 },
      { width: 360, height: 140 },
      { x: 0, y: 0, width: 100, height: 80 },
    ),
    { x: 0, y: 0, width: 100, height: 80 },
  );
  assert.throws(
    () =>
      fitMiniWindow(
        { x: NaN, y: 0, width: 1, height: 1 },
        { width: 1, height: 1 },
        { x: 0, y: 0, width: 1, height: 1 },
      ),
    RangeError,
  );
});
test("a window switch acknowledges the target before hiding the previous surface; state uses real material", async () => {
  const f = fixture();
  assert.deepEqual(await f.coordinator.setMode("mini", context()), {
    ok: true,
    status: "applied",
  });
  assert.deepEqual(f.calls, ["show:mini", "hide:main"]);
  assert.equal(f.coordinator.host("mini").backdrop, "none");
  assert.equal(
    f.coordinator.host("mini").capabilities.transparentWindow,
    false,
  );
  assert.equal(f.coordinator.host("main").surfaceVisible, false);
});
test("failed or unacknowledged target display leaves the previous window visible", async () => {
  const f = fixture();
  f.port.show = async () => {
    throw Error("OS failure");
  };
  assert.equal((await f.coordinator.setMode("mini", context())).ok, false);
  assert.equal(f.visible.main, true);
  f.port.show = async () => {};
  assert.equal((await f.coordinator.setMode("mini", context())).ok, false);
  assert.equal(f.visible.main, true);
  assert.equal(f.coordinator.host("main").windowMode, "full");
});
test("a cancelled late show never hides the previous window or commits a requested mode", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.port.show = async () => {
    controller.abort();
    f.visible.mini = true;
  };
  assert.equal(
    (await f.coordinator.setMode("mini", context(controller))).ok,
    false,
  );
  assert.equal(f.visible.main, true);
  assert.equal(f.coordinator.host("main").windowMode, "full");
  assert.equal(f.coordinator.host("mini").surfaceVisible, true); // Truthful even for a misbehaving port.
});
test("rapid window requests serialize, restore after hiding, and retain unsaved draft protection", async () => {
  const f = fixture();
  f.coordinator.reportUnsavedChanges("main", true);
  await Promise.all([
    f.coordinator.setMode("mini", context()),
    f.coordinator.setMode("full", context()),
  ]);
  assert.deepEqual(f.calls, [
    "show:mini",
    "hide:main",
    "show:main",
    "hide:mini",
  ]);
  await f.coordinator.hideToTray(context());
  assert.equal(f.visible.main, false);
  assert.equal(f.coordinator.hasUnsavedChanges(), true);
  assert.equal(await f.coordinator.requestExit(), false);
  assert.deepEqual(f.counts(), { confirms: 1, exits: 0 });
  await f.coordinator.setMode("full", context());
  assert.equal(f.visible.main, true);
});
test("resize uses actual monitor work area and cancelled operations never touch the port", async () => {
  const f = fixture();
  await f.coordinator.resizeMini({ width: 360, height: 140 }, context());
  assert.deepEqual(f.calls, ["resize:860"]);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await f.coordinator.setMode("mini", context(controller))).ok,
    false,
  );
  assert.deepEqual(f.calls, ["resize:860"]);
});
test("tray exit deduplicates prompts and rejects approval when a draft changes during confirmation", async () => {
  const f = fixture();
  f.coordinator.reportUnsavedChanges("main", true);
  let resolve!: (approved: boolean) => void;
  f.port.confirmDiscard = () =>
    new Promise<boolean>((done) => {
      resolve = done;
    });
  const first = f.coordinator.requestExit(),
    second = f.coordinator.requestExit();
  assert.equal(first, second);
  await Promise.resolve();
  await Promise.resolve();
  f.coordinator.reportUnsavedChanges("mini", true);
  resolve(true);
  assert.equal(await first, false);
  assert.equal(f.counts().exits, 0);
  f.coordinator.reportUnsavedChanges("main", false);
  f.coordinator.reportUnsavedChanges("mini", false);
  assert.equal(await f.coordinator.requestExit(), true);
  assert.equal(f.counts().exits, 1);
});

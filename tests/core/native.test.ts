import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  snapshotDelta,
  applySnapshotDelta,
  measureClockOffset,
} from "../../src/bridge/snapshotTransport.ts";
import { receiveNativeSnapshot } from "../../src/bridge/nativeBridge.ts";
import { createMockSession } from "../../src/mock/createMockBridge.ts";
import { startDesktopBackend } from "../../scripts/native-server.mjs";

test("desktop serves memorial PNG and WebP assets with image MIME and same-origin CSP", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cd-native-images-"));
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    const assets = path.join(directory, "web"), pictures = path.join(assets, "assets");
    await mkdir(pictures, { recursive: true });
    const formats = [
      ["probe.png", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=", "base64")],
      ["probe.webp", "image/webp", Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64")],
    ] as const;
    for (const [name, , content] of formats) await writeFile(path.join(pictures, name), content);
    backend = await startDesktopBackend({ directory: path.join(directory, "data"), assets });
    for (const [name, type, content] of formats) {
      const response = await fetch(`${backend.origin}/assets/${name}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), type);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-security-policy")!, /img-src 'self' data: blob:;/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    }
  } finally {
    await backend?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("position-only IPC preserves library, queue and lyrics references after JSON decoding", () => {
  const session = createMockSession({ autoTick: false }),
    bridge = session.connect("main");
  try {
    const original = bridge.getSnapshot(),
      decoded = applySnapshotDelta(
        null,
        JSON.parse(JSON.stringify(snapshotDelta(null, original))),
      );
    const next = {
      ...original,
      player: {
        ...original.player,
        positionMs: 500,
        positionSampledAt: 1200,
        sampleSequence: 2,
      },
    };
    const delta = JSON.parse(JSON.stringify(snapshotDelta(original, next)));
    assert.equal("queue" in delta.player, false);
    assert.equal("lyrics" in delta, false);
    const received = applySnapshotDelta(decoded, delta);
    assert.equal(received.library, decoded.library);
    assert.equal(received.player.queue, decoded.player.queue);
    assert.equal(received.lyrics, decoded.lyrics);
    assert.equal(received.player.positionMs, 500);
  } finally {
    session.destroy();
  }
});
test("native samples use the receiving WebView time origin and keep it on host-only updates", () => {
  const session = createMockSession({ autoTick: false });
  try {
    const original = session.connect("main").getSnapshot();
    const first = receiveNativeSnapshot(
      null,
      {
        sequence: 1,
        snapshot: {
          ...original,
          player: { ...original.player, positionSampledAt: 7000 },
        },
      },
      5000,
    );
    assert.equal(first.player.positionSampledAt, 2000);
    const next = receiveNativeSnapshot(
      first,
      {
        sequence: 2,
        snapshot: { host: { ...first.host, surfaceVisible: false } },
      },
      5000,
    );
    assert.equal(next.player, first.player);
    assert.equal(next.player.positionSampledAt, 2000);
  } finally {
    session.destroy();
  }
});
test("calibration chooses the shortest round trip, rejects empty and invalid probes", async () => {
  const timestamps = [0, 20, 30, 32, 40, 50];
  let index = 0,
    probe = 0;
  const remote = [110, 131, 145];
  assert.equal(
    await measureClockOffset(
      async () => remote[probe++]!,
      () => timestamps[index++]!,
      3,
    ),
    100,
  );
  await assert.rejects(
    measureClockOffset(
      async () => 1,
      () => 1,
      0,
    ),
  );
  await assert.rejects(
    measureClockOffset(
      async () => NaN,
      () => 1,
      1,
    ),
  );
  let moment = 10;
  await assert.rejects(
    measureClockOffset(
      async () => 1,
      () => moment--,
      1,
    ),
  );
});
test("a partial bootstrap cannot masquerade as a valid frozen snapshot", () => {
  assert.throws(() =>
    applySnapshotDelta(null, {
      contractVersion: "0.4.0",
      player: { queue: [] },
    }),
  );
});
test("an older playback sample cannot resurrect old track lyrics even with a newer transport envelope", () => {
  const session = createMockSession({ autoTick: false });
  try {
    const state = session.connect("main").getSnapshot(),
      latest = {
        ...state,
        player: {
          ...state.player,
          sampleSequence: 10,
          currentTrackId: "latest",
        },
      };
    const result = receiveNativeSnapshot(
      latest,
      {
        sequence: 100,
        snapshot: {
          player: { sampleSequence: 9, currentTrackId: "old" },
          lyrics: null,
        },
      },
      0,
    );
    assert.equal(result, latest);
    assert.equal(result.player.currentTrackId, "latest");
  } finally {
    session.destroy();
  }
});
test("production desktop backend serves only its owned static root and retains API authentication", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cd-native-"));
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    const assets = path.join(directory, "web");
    await mkdir(assets);
    await writeFile(
      path.join(assets, "desktop.html"),
      "<html>desktop-test</html>",
    );
    await writeFile(path.join(directory, "secret.txt"), "private");
    backend = await startDesktopBackend({
      directory: path.join(directory, "data"),
      assets,
      pickerExecutable: path.join(directory, "unused.exe"),
    });
    const page = await fetch(backend.origin + "/desktop.html");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /desktop-test/);
    assert.match(
      page.headers.get("content-security-policy")!,
      /object-src 'none'/,
    );
    assert.notEqual(
      (await fetch(backend.origin + "/%2e%2e%2fsecret.txt")).status,
      200,
    );
    assert.equal(
      (
        await fetch(backend.origin + "/api/action", {
          method: "POST",
          body: JSON.stringify({
            type: "updateSettings",
            patch: { background: "blue" },
          }),
        })
      ).status,
      400,
    );
    const bootstrap = await fetch(backend.origin + "/api/bootstrap");
    assert.equal(bootstrap.status, 200);
    const state = await bootstrap.json();
    assert.equal(state.view.settings.background, "light");
    assert.equal((await fetch(backend.origin + "/api/health")).status, 400);
    const health = await fetch(backend.origin + "/api/health", {
      headers: { "x-cd-token": state.token },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    await backend.close();
    backend = undefined;
    // Graceful shutdown releases the store's single-writer lock.
    backend = await startDesktopBackend({
      directory: path.join(directory, "data"),
      assets,
      pickerExecutable: path.join(directory, "unused.exe"),
    });
  } finally {
    await backend?.close();
    const safe = path.resolve(directory);
    assert.equal(path.dirname(safe), path.resolve(os.tmpdir()));
    await rm(safe, { recursive: true, force: true });
  }
});

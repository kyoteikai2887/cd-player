import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { openLocalStore } from "../../src/local/store.ts";
import { scanFolder, mergeScan } from "../../src/local/scanner.ts";
import { applyLocalWrite } from "../../src/local/actions.ts";
import { startLocalServer } from "../../src/local/server.ts";
import { createAudioFolder } from "../helpers/audioFiles.ts";

const temporaryRoots = new Set<string>();
after(async () => {
  for (const root of temporaryRoots) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    if (!relative.startsWith("cd-player-local-") || relative.includes(path.sep))
      throw new Error("Unsafe test cleanup target");
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "cd-player-local-"));
  temporaryRoots.add(root);
  const music = await createAudioFolder(path.join(root, "音楽"));
  const directory = path.join(root, "data"),
    store = await openLocalStore(directory),
    scan = await scanFolder(
      music,
      path.join(directory, "covers"),
      new AbortController().signal,
    );
  await store.transact((data) => mergeScan(data, scan));
  return { root, music, directory, store, scan };
}
test("real FLAC/MP3/WAV metadata, sidecar offsets and translations import without modifying originals", async () => {
  const { store, scan, music } = await setup();
  try {
    assert.equal(scan.tracks.length, 4);
    assert.equal(scan.warnings.length, 0);
    const flac = scan.tracks.find((t) => t.title === "窓の光")!;
    assert.equal(flac.durationMs, 3000);
    assert.equal(flac.artistCredit, "空野ミオ (CV.月野ユイ)");
    assert.deepEqual(flac.artists, ["空野ミオ"]);
    assert.equal(scan.lyrics[flac.id].lines[0].startMs, 100);
    assert.equal(scan.lyrics[flac.id].lines[0].translation, "窗边的光");
    assert.equal(
      scan.albums.find((a) => a.id === flac.albumId)!.rip!.accurateRip,
      "unknown",
    );
    assert.ok(scan.tracks.some((t) => t.discNumber === 2));
    assert.equal(
      await readFile(path.join(music, "capture.log"), "utf8"),
      "Original test log, not an AccurateRip verification.",
    );
  } finally {
    await store.close();
  }
});
test("reimport deduplicates and protects edits; missing files remain visible and unavailable; restart preserves lyrics", async () => {
  const { store, scan, music, directory } = await setup();
  const track = scan.tracks[0],
    album = scan.albums.find((a) => a.id === track.albumId)!;
  await store.transact((data) =>
    applyLocalWrite(data, {
      type: "updateAlbum",
      albumId: album.id,
      baseRevision: 0,
      patch: { title: "用户整理" },
    }),
  );
  await store.transact((data) =>
    applyLocalWrite(data, {
      type: "setLyricsOffset",
      trackId: track.id,
      baseRevision: 0,
      offsetMs: 240,
    }),
  );
  const rescan = await scanFolder(
    music,
    path.join(directory, "covers"),
    new AbortController().signal,
  );
  await store.transact((data) => mergeScan(data, rescan));
  assert.equal(store.read().library.tracks.length, 4);
  assert.equal(
    store.read().library.albums.find((a) => a.id === album.id)!.title,
    "用户整理",
  );
  await rename(
    store.read().files[track.id].path,
    store.read().files[track.id].path + ".removed",
  );
  await store.transact((data) =>
    mergeScan(data, {
      ...rescan,
      tracks: rescan.tracks.filter((t) => t.id !== track.id),
    }),
  );
  assert.equal(
    store.read().library.tracks.find((t) => t.id === track.id)!.available,
    false,
  );
  await store.close();
  const reopened = await openLocalStore(directory);
  try {
    assert.equal(reopened.read().lyricsByTrack[track.id].offsetMs, 240);
  } finally {
    await reopened.close();
  }
});
test("concurrent edits serialize: stale write rejected, corrupted store preserved, second writer rejected", async () => {
  const { store, scan, directory } = await setup(),
    track = scan.tracks[0];
  const operations = await Promise.allSettled([
    store.transact((data) =>
      applyLocalWrite(data, {
        type: "setLyricsOffset",
        trackId: track.id,
        baseRevision: 0,
        offsetMs: 100,
      }),
    ),
    store.transact((data) =>
      applyLocalWrite(data, {
        type: "setLyricsOffset",
        trackId: track.id,
        baseRevision: 0,
        offsetMs: 200,
      }),
    ),
  ]);
  assert.equal(operations.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(openLocalStore(directory));
  await store.close();
  await writeFile(path.join(directory, "library.json"), "{broken");
  await assert.rejects(openLocalStore(directory));
  assert.equal(
    await readFile(path.join(directory, "library.json"), "utf8"),
    "{broken",
  );
});
test("loopback API authenticates writes, rejects foreign origin and traversal, serves ranges and draft imports", async () => {
  const { store, scan, directory, music } = await setup();
  const track = scan.tracks.find((t) => t.title === "窓の光")!;
  let selected = async () => path.join(music, "Disc 1", "01 原创音.zh.lrc");
  const server = await startLocalServer({
    store,
    dataDirectory: directory,
    picker: () => selected(),
  });
  const headers = {
    "x-cd-token": server.token,
    "content-type": "application/json",
  };
  try {
    assert.equal(
      (
        await fetch(server.origin + "/api/action", {
          method: "POST",
          headers: { ...headers, origin: "https://foreign.example" },
          body: "{}",
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(server.origin + "/api/media/" + track.id)).status,
      400,
    );
    assert.equal(
      (await fetch(server.origin + "/api/media/..%2flibrary.json", { headers }))
        .status,
      404,
    );
    const response = await fetch(server.origin + "/api/media/" + track.id, {
      headers: { ...headers, range: "bytes=0-3" },
    });
    assert.equal(response.status, 206);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "fLaC");
    assert.equal(
      (await fetch(server.origin + "/api/audio-info/" + track.id)).status,
      400,
    );
    const audioInfo = await (
      await fetch(server.origin + "/api/audio-info/" + track.id, { headers })
    ).json();
    assert.deepEqual(audioInfo, {
      size: (await readFile(store.read().files[track.id].path)).length,
      durationMs: 3000,
      sampleRate: 44100,
      channels: 1,
    });
    assert.equal("path" in audioInfo, false);
    assert.equal(
      (
        await fetch(server.origin + "/api/audio-info/..%2flibrary.json", {
          headers,
        })
      ).status,
      404,
    );
    const result = await (
      await fetch(server.origin + "/api/task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "importLyrics",
          trackId: track.id,
          content: "translation",
          destination: "editorDraft",
        }),
      })
    ).json();
    let task;
    for (let i = 0; i < 100; i++) {
      task = await (
        await fetch(server.origin + "/api/task/" + result.taskId, { headers })
      ).json();
      if (task.state !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(task.state, "done");
    assert.equal(task.result.pendingImport.lines[0].translation, undefined);
    assert.equal(store.read().lyricsByTrack[track.id].revision, 0);
    let choose: ((value: string) => void) | undefined;
    selected = () =>
      new Promise((resolve) => {
        choose = resolve;
      });
    const pending = await (
      await fetch(server.origin + "/api/task", {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "importLyrics",
          trackId: track.id,
          content: "original",
          baseRevision: 0,
        }),
      })
    ).json();
    for (let i = 0; i < 100 && !choose; i++)
      await new Promise((r) => setTimeout(r, 1));
    await store.transact((data) =>
      applyLocalWrite(data, {
        type: "setLyricsOffset",
        trackId: track.id,
        baseRevision: 0,
        offsetMs: 123,
      }),
    );
    choose!(path.join(music, "Disc 1", "01 原创音.zh.lrc"));
    for (let i = 0; i < 100; i++) {
      task = await (
        await fetch(server.origin + "/api/task/" + pending.taskId, { headers })
      ).json();
      if (task.state !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(task.state, "failed");
    assert.equal(task.error.code, "conflict");
    assert.equal(task.result.view.lyricsByTrack[track.id].offsetMs, 123);
  } finally {
    await server.close();
    await store.close();
  }
});
test("cancellation before the atomic commit leaves the previous persisted revision intact", async () => {
  const { store, scan, directory } = await setup();
  try {
    let checks = 0;
    const original = await readFile(
      path.join(directory, "library.json"),
      "utf8",
    );
    await assert.rejects(
      store.transact(
        (data) =>
          applyLocalWrite(data, {
            type: "setLyricsOffset",
            trackId: scan.tracks[0].id,
            baseRevision: 0,
            offsetMs: 999,
          }),
        () => ++checks === 1,
      ),
    );
    assert.equal(
      await readFile(path.join(directory, "library.json"), "utf8"),
      original,
    );
    assert.equal(store.read().lyricsByTrack[scan.tracks[0].id].revision, 0);
  } finally {
    await store.close();
  }
});

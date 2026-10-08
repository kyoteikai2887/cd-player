import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { openLocalStore } from "../../src/local/store.ts";
import { startLocalServer } from "../../src/local/server.ts";
import { createLocalSession } from "../../src/bridge/createLocalSession.ts";
import { createDemoData } from "../../src/mock/fixtures.ts";
import type { LocalClient, LocalReply } from "../../src/bridge/localClient.ts";
import type { UIAction } from "../../src/contracts/player.ts";
import type { AudioEngine } from "../../src/core/audio.ts";

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "cd-player-r2-"));
  const store = await openLocalStore(directory);
  const data = createDemoData();
  await store.transact((draft) => {
    draft.library = data.library;
    draft.lyricsByTrack = data.lyricsByTrack;
  });
  const server = await startLocalServer({ store, dataDirectory: directory });
  const post = async (
    action: UIAction,
    signal?: AbortSignal,
  ): Promise<LocalReply> =>
    (
      await fetch(server.origin + "/api/action", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-cd-token": server.token,
        },
        body: JSON.stringify(action),
      })
    ).json();
  const client: LocalClient = {
    initial: store.view(),
    write: post,
    async start() {
      throw Error("Unexpected background task");
    },
    async task() {
      throw Error("Unexpected background task");
    },
  };
  const engine: AudioEngine = {
    async activate() {},
    async play() {},
    pause() {},
    async resume() {},
    seek() {},
    sample: () => ({
      trackId: null,
      positionMs: 0,
      durationMs: 0,
      playing: false,
      ended: false,
      cycle: 0,
    }),
    prepareNext() {},
    setGain() {},
    stop() {},
    destroy() {},
  };
  const session = createLocalSession({ client, engine, autoTick: false });
  return {
    session,
    post,
    async close() {
      session.destroy();
      await server.close();
      await store.close();
      const relative = path.relative(
        path.resolve(tmpdir()),
        path.resolve(directory),
      );
      assert.ok(
        relative.startsWith("cd-player-r2-") && !relative.includes(path.sep),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("real HTTP metadata conflicts publish latest album and track before their results settle", async () => {
  const { session, post, close } = await setup();
  const bridge = session.connect("main");
  try {
    for (const action of [
      {
        type: "updateAlbum",
        albumId: "album-blue",
        baseRevision: 0,
        patch: { workTitle: "external work" },
      },
      {
        type: "updateTrack",
        trackId: "track-blue",
        baseRevision: 0,
        patch: { artistCredit: "external credit" },
      },
    ] as const) {
      assert.equal((await post(action)).ok, true);
      let published = false,
        settled = false;
      const id =
        action.type === "updateAlbum" ? action.albumId : action.trackId;
      const latest = () =>
        (action.type === "updateAlbum"
          ? bridge.getSnapshot().library.albums
          : bridge.getSnapshot().library.tracks
        ).find((x) => x.id === id)!;
      const off = bridge.subscribe(() => {
        if (latest().revision === 1) {
          assert.equal(settled, false);
          published = true;
        }
      });
      const conflict = await bridge.dispatch({
        ...action,
        patch: { title: "my title" },
      });
      settled = true;
      off();
      assert.ok(!conflict.ok && conflict.code === "conflict");
      assert.equal(published, true);
      assert.equal(latest().revision, 1);
      assert.equal(
        (
          await bridge.dispatch({
            ...action,
            baseRevision: 1,
            patch: { title: "my title" },
          })
        ).ok,
        true,
      );
      const merged = latest();
      assert.equal(merged.title, "my title");
      if ("workTitle" in merged)
        assert.equal(merged.workTitle, "external work");
      else assert.equal(merged.artistCredit, "external credit");
      assert.ok(merged.userEditedFields.includes("title"));
    }
    assert.equal(bridge.getSnapshot().notices.length, 0);
  } finally {
    await close();
  }
});

test("real cross-surface lyric writes update the open document without reopening the editor", async () => {
  const { session, close } = await setup();
  const main = session.connect("main"),
    mini = session.connect("mini");
  try {
    await main.dispatch({ type: "openLyricsEditor", trackId: "track-blue" });
    await mini.dispatch({
      type: "setLyricsOffset",
      trackId: "track-blue",
      baseRevision: 0,
      offsetMs: -240,
    });
    assert.equal(main.getSnapshot().lyricsEditor!.document!.offsetMs, -240);
    assert.equal(main.getSnapshot().lyricsEditor!.document!.revision, 1);
    await mini.dispatch({
      type: "setNoLyrics",
      trackId: "track-blue",
      baseRevision: 1,
      kind: "instrumental",
    });
    assert.equal(
      main.getSnapshot().lyricsEditor!.document!.kind,
      "instrumental",
    );
    assert.equal(main.getSnapshot().lyricsEditor!.status, "ready");
    const stale = await main.dispatch({
      type: "setLyricsOffset",
      trackId: "track-blue",
      baseRevision: 1,
      offsetMs: 999,
    });
    assert.ok(!stale.ok && stale.code === "conflict");
    assert.equal(main.getSnapshot().lyricsEditor!.document!.revision, 2);
    assert.equal(main.getSnapshot().lyricsEditor!.document!.offsetMs, -240);
    await mini.dispatch({
      type: "setNoLyrics",
      trackId: "track-blue",
      baseRevision: 2,
      kind: null,
    });
    assert.equal(main.getSnapshot().lyricsEditor!.document!.kind, "synced");
  } finally {
    await close();
  }
});

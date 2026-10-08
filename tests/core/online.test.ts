import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDemoData } from "../../src/mock/fixtures.ts";
import { parseLyrics } from "../../src/core/lyrics.ts";
import {
  createOnlineHttp,
  ONLINE_USER_AGENT,
} from "../../src/local/online/http.ts";
import { createOnlineServices } from "../../src/local/online/providers.ts";
import type {
  Release,
  OnlineServices,
} from "../../src/local/online/providers.ts";
import {
  prepareMetadataReview,
  applyOnlineMetadata,
} from "../../src/local/online/metadata.ts";
import { fillOnlineLyrics } from "../../src/local/online/lyrics.ts";
import { openLocalStore } from "../../src/local/store.ts";
import { startLocalServer } from "../../src/local/server.ts";
import { applyLocalWrite } from "../../src/local/actions.ts";
import type { LocalData } from "../../src/local/model.ts";
import type { UIAction } from "../../src/contracts/player.ts";

const releaseId = "b7992822-c33d-4e71-91fe-b55d3bfbdbad";
const signal = () => new AbortController().signal;
const response = (
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
) => new Response(JSON.stringify(value), { status, headers });
const fetcher = (
  run: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch =>
  (async (url, init) => run(new URL(String(url)), init)) as typeof fetch;
function fixture() {
  const demo = createDemoData(),
    data: LocalData = {
      schemaVersion: 1,
      ...demo,
      archivedLyrics: {},
      roots: [],
      files: {},
      covers: {},
    };
  const album = data.library.albums[0],
    track = data.library.tracks.find((t) => t.albumId === album.id)!;
  data.library.albums = [album];
  data.library.tracks = [track];
  album.trackIds = [track.id];
  track.discNumber = 1;
  track.trackNumber = 1;
  album.title = "原创收藏";
  album.albumArtists = ["空野ミオ"];
  album.albumArtistCredit = "空野ミオ";
  album.catalogNumber = null;
  track.title = "窓の光";
  track.artistCredit = "空野ミオ (CV.月野ユイ)";
  track.artists = ["空野ミオ"];
  track.durationMs = 180000;
  data.lyricsByTrack = { [track.id]: parseLyrics("", track.id) };
  data.lyricsByTrack[track.id].locked = false;
  const remote: Release = {
    id: releaseId,
    title: album.title,
    date: "2026-01-02",
    country: "JP",
    "artist-credit": [{ name: "空野ミオ" }],
    "label-info": [
      { "catalog-number": "DEMO-001", label: { name: "原创唱片社" } },
    ],
    media: [
      {
        position: 1,
        tracks: [
          {
            position: 1,
            title: "窓の光 正式题名",
            length: 180001,
            "artist-credit": [
              { name: "空野ミオ (CV.月野ユイ)", joinphrase: " & " },
              { name: "月野ユイ" },
            ],
            recording: { id: "a5992822-c33d-4e71-91fe-b55d3bfbdbad" },
          },
        ],
      },
    ],
  };
  return { data, album, track, remote };
}
const noWait = async () => {};

test("malformed release data is not cached as a successful response; the next lookup can recover", async () => {
  const { album, track, remote } = fixture();
  let detailRequests = 0;
  const service = createOnlineServices({
    sleep: noWait,
    fetch: fetcher((url) => {
      if (url.searchParams.has("query"))
        return response({ releases: [{ id: releaseId }] });
      if (url.hostname === "coverartarchive.org") return response({}, 404);
      detailRequests++;
      return response(
        detailRequests === 1
          ? { ...remote, media: [{ position: 1, tracks: "corrupt" }] }
          : remote,
      );
    }),
  });
  await assert.rejects(service.metadata(album, [track], signal()), /格式无效/);
  assert.equal((await service.metadata(album, [track], signal())).length, 1);
  assert.equal(detailRequests, 2);
});

test("MusicBrainz calls identify the app, limit search, resolve full releases and request edition-specific artwork", async () => {
  const { album, track, remote } = fixture(),
    urls: string[] = [];
  const services = createOnlineServices({
    sleep: noWait,
    fetch: fetcher((url, init) => {
      urls.push(url.href);
      assert.equal(
        (init?.headers as Record<string, string>)["User-Agent"],
        ONLINE_USER_AGENT,
      );
      if (url.hostname === "coverartarchive.org") return response({}, 404);
      if (url.searchParams.has("query")) {
        assert.equal(url.searchParams.get("limit"), "5");
        return response({ releases: [{ id: releaseId }] });
      }
      return response(remote);
    }),
  });
  const found = await services.metadata(album, [track], signal());
  assert.equal(found.length, 1);
  assert.equal(found[0].match, "text");
  assert.match(
    urls.at(-1)!,
    new RegExp("/release/" + releaseId + "/front-500"),
  );
  assert.ok(!urls.some((url) => url.includes("release-group")));
});
test("Disc ID lookup precedes text and exposes a distinct physical-edition match", async () => {
  const { album, track, remote } = fixture(),
    urls: URL[] = [];
  album.rip = {
    hasLog: true,
    hasCue: false,
    accurateRip: "verified",
    discs: [
      {
        number: 1,
        hasLog: true,
        hasCue: false,
        discId: "1234567890123456789012345678",
      },
    ],
  };
  const service = createOnlineServices({
    sleep: noWait,
    fetch: fetcher((url) => {
      urls.push(url);
      if (url.pathname.includes("/discid/"))
        return response({ releases: [{ id: releaseId }] });
      if (url.hostname === "coverartarchive.org") return response({}, 404);
      return response(remote);
    }),
  });
  assert.equal(
    (await service.metadata(album, [track], signal()))[0].match,
    "discId",
  );
  assert.ok(!urls.some((url) => url.searchParams.has("query")));
});
test("catalogue search does not elevate approximate catalogue hits", async () => {
  const { album, track, remote } = fixture();
  album.catalogNumber = "OTHER";
  const service = createOnlineServices({
    sleep: noWait,
    fetch: fetcher((url) =>
      url.searchParams.has("query")
        ? response({ releases: [{ id: releaseId }] })
        : response(remote),
    ),
  });
  assert.deepEqual(await service.metadata(album, [track], signal()), []);
});
test("candidate changes preserve structured CV credits and offer no track edits when versions have different durations", () => {
  const { data, album, track, remote } = fixture();
  const good = prepareMetadataReview(data, album, [
    { release: remote, match: "text", notes: [] },
  ]);
  const artist = good.review.candidates[0].changes.find(
    (c) => c.target === "track" && c.field === "artists",
  )!;
  assert.deepEqual(artist.to, ["空野ミオ (CV.月野ユイ)", "月野ユイ"]);
  remote.media![0].tracks![0].length = track.durationMs - 60000;
  const short = prepareMetadataReview(data, album, [
    { release: remote, match: "text", notes: [] },
  ]);
  assert.ok(
    short.review.candidates[0].changes.every((c) => c.target === "album"),
  );
  assert.match(short.review.candidates[0].notes.join(""), /时长不一致/);
});
test("duplicate disc/track slots and unknown text-match lengths cannot produce track replacements", () => {
  const { data, album, track, remote } = fixture();
  delete remote.media![0].tracks![0].length;
  assert.ok(
    prepareMetadataReview(data, album, [
      { release: remote, match: "text", notes: [] },
    ]).review.candidates[0].changes.every((c) => c.target === "album"),
  );
  remote.media![0].tracks!.push({ ...remote.media![0].tracks![0] });
  data.library.tracks.push({ ...track, id: track.id + "-copy" });
  assert.ok(
    prepareMetadataReview(data, album, [
      { release: remote, match: "discId", notes: [] },
    ]).review.candidates[0].changes.every((c) => c.target === "album"),
  );
});
test("candidate application is atomic, checks the entire library revision and requires individual protected-field confirmation", () => {
  const { data, album, remote } = fixture();
  album.userEditedFields = ["catalogNumber"];
  const prepared = prepareMetadataReview(data, album, [
      { release: remote, match: "text", notes: [] },
    ]),
    candidate = prepared.review.candidates[0];
  const chosen = candidate.changes.find((c) => c.field === "catalogNumber")!;
  const action: Extract<UIAction, { type: "applyMetadataCandidate" }> = {
    type: "applyMetadataCandidate",
    albumId: album.id,
    reviewId: prepared.review.id,
    candidateId: candidate.id,
    changeIds: [chosen.id],
    confirmedProtectedChangeIds: [],
  };
  assert.throws(
    () => applyOnlineMetadata(structuredClone(data), prepared, action),
    /逐项确认/,
  );
  const stale = structuredClone(data);
  stale.library.revision++;
  assert.throws(
    () =>
      applyOnlineMetadata(stale, prepared, {
        ...action,
        confirmedProtectedChangeIds: [chosen.id],
      }),
    /资料库已变化/,
  );
  applyOnlineMetadata(data, prepared, {
    ...action,
    confirmedProtectedChangeIds: [chosen.id],
  });
  assert.equal(album.catalogNumber, "DEMO-001");
  assert.deepEqual(album.userEditedFields, ["catalogNumber"]);
  assert.equal(album.metadataStatus, "partial");
  assert.equal(album.musicBrainzReleaseId, releaseId);
});
test("candidate field ids cannot be forged, duplicated or confirmed outside the selected protected subset", () => {
  const { data, album, remote } = fixture(),
    p = prepareMetadataReview(data, album, [
      { release: remote, match: "text", notes: [] },
    ]),
    c = p.review.candidates[0];
  const base = {
    type: "applyMetadataCandidate" as const,
    albumId: album.id,
    reviewId: p.review.id,
    candidateId: c.id,
    confirmedProtectedChangeIds: [] as string[],
  };
  for (const changeIds of [[], ["forged"], [c.changes[0].id, c.changes[0].id]])
    assert.throws(
      () =>
        applyOnlineMetadata(structuredClone(data), p, { ...base, changeIds }),
      /选择无效/,
    );
  assert.throws(
    () =>
      applyOnlineMetadata(structuredClone(data), p, {
        ...base,
        changeIds: [c.changes[0].id],
        confirmedProtectedChangeIds: [c.changes[0].id],
      }),
    /选择无效/,
  );
});
test("LRCLIB uses all identity fields, exact duration checking, original synthetic lyrics and no instrumental inference", async () => {
  const { album, track } = fixture();
  const row = {
    id: 42,
    trackName: track.title,
    artistName: track.artistCredit,
    albumName: album.title,
    duration: 180,
    instrumental: false,
    syncedLyrics: "[00:00.000]原创的窗光\n[00:08.000]\n[00:10.000]第二句原创",
    plainLyrics: "original text",
  };
  const service = createOnlineServices({
    sleep: noWait,
    fetch: fetcher((url) => {
      assert.equal(url.searchParams.get("artist_name"), track.artistCredit);
      assert.equal(url.searchParams.get("duration"), "180");
      return response(row);
    }),
  });
  const doc = await service.lyrics(track, album, signal());
  assert.equal(doc?.kind, "synced");
  assert.equal(doc?.lines[1].original, "");
  assert.equal(doc?.source.original?.recordId, "42");
  row.instrumental = true;
  const instrumental = createOnlineServices({
    sleep: noWait,
    fetch: fetcher(() => response(row)),
  });
  assert.equal(await instrumental.lyrics(track, album, signal()), null);
});
for (const field of ["trackName", "artistName", "albumName", "duration"])
  test("LRCLIB rejects mismatching " + field, async () => {
    const { album, track } = fixture(),
      row: Record<string, unknown> = {
        id: 1,
        trackName: track.title,
        artistName: track.artistCredit,
        albumName: album.title,
        duration: 180,
        plainLyrics: "原创歌词",
      };
    row[field] = field === "duration" ? 177.999 : "different edition";
    const service = createOnlineServices({
      sleep: noWait,
      fetch: fetcher(() => response(row)),
    });
    assert.equal(await service.lyrics(track, album, signal()), null);
  });
test("search fallback rejects multiple exact records rather than silently selecting one", async () => {
  const { album, track } = fixture(),
    row = {
      id: 1,
      trackName: track.title,
      artistName: track.artistCredit,
      albumName: album.title,
      duration: 180,
      plainLyrics: "原创歌词",
    };
  const service = createOnlineServices({
    sleep: noWait,
    fetch: fetcher((url) =>
      url.pathname.endsWith("/get")
        ? response({}, 404)
        : response([row, { ...row, id: 2 }]),
    ),
  });
  assert.equal(await service.lyrics(track, album, signal()), null);
});
test("online lyrics fill missing content once, preserve user offset, existing original/translation and manual classifications", () => {
  const { data, track, album } = fixture(),
    candidate = parseLyrics("[00:01.000]原创歌词", track.id);
  data.lyricsByTrack[track.id].offsetMs = 120;
  const base = {
    trackId: track.id,
    trackRevision: track.revision,
    albumRevision: album.revision,
    lyricsRevision: 0,
  };
  assert.equal(fillOnlineLyrics(data, base, candidate), true);
  assert.equal(data.lyricsByTrack[track.id].offsetMs, 120);
  const original = structuredClone(data.lyricsByTrack[track.id]);
  original.lines[0].translation = "original translation";
  data.lyricsByTrack[track.id] = original;
  const next = { ...base, lyricsRevision: 1 };
  assert.equal(fillOnlineLyrics(data, next, candidate), false);
  assert.deepEqual(data.lyricsByTrack[track.id], original);
  original.kind = "instrumental";
  assert.equal(fillOnlineLyrics(data, next, candidate), false);
});
test("lyrics lookup cannot overwrite intervening edits, locks, metadata changes or a removed track", () => {
  const { data, track, album } = fixture(),
    base = {
      trackId: track.id,
      trackRevision: track.revision,
      albumRevision: album.revision,
      lyricsRevision: 0,
    };
  for (const change of [
    (d: LocalData) => d.lyricsByTrack[track.id].revision++,
    (d: LocalData) => (d.lyricsByTrack[track.id].locked = true),
    (d: LocalData) => d.library.tracks[0].revision++,
    (d: LocalData) => d.library.albums[0].revision++,
    (d: LocalData) => (d.library.tracks = []),
  ]) {
    const altered = structuredClone(data);
    change(altered);
    assert.throws(() => fillOnlineLyrics(altered, base, null));
  }
});
test("request rate limiting spaces MusicBrainz starts and honors Retry-After even for a later lookup", async () => {
  let clock = 1000;
  const starts: number[] = [],
    waits: number[] = [];
  let count = 0;
  const http = createOnlineHttp({
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetch: fetcher(() => {
      starts.push(clock);
      return ++count === 1
        ? response({}, 429, { "retry-after": "12" })
        : response({ ok: true });
    }),
  });
  await assert.rejects(
    http.json(
      "https://musicbrainz.org/ws/2/release/a",
      "musicbrainz",
      signal(),
    ),
    /繁忙/,
  );
  await http.json(
    "https://musicbrainz.org/ws/2/release/b",
    "musicbrainz",
    signal(),
  );
  await http.json(
    "https://musicbrainz.org/ws/2/release/c",
    "musicbrainz",
    signal(),
  );
  assert.equal(starts[1] - starts[0], 12000);
  assert.equal(starts[2] - starts[1], 1100);
  assert.ok(waits.includes(12000));
});
test("fresh cache works after restart without networking; cache objects cannot alias callers", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cd-player-online-cache-"),
  );
  try {
    const url = "https://lrclib.net/api/get?test=1";
    const one = createOnlineHttp({
      directory,
      sleep: noWait,
      fetch: fetcher(() => response({ a: ["original"] })),
    });
    const row = (await one.json(url, "lrclib", signal())) as { a: string[] };
    row.a[0] = "mutated";
    assert.deepEqual(await one.json(url, "lrclib", signal()), {
      a: ["original"],
    });
    const two = createOnlineHttp({
      directory,
      sleep: noWait,
      fetch: fetcher(() => {
        throw new Error("Offline");
      }),
    });
    assert.deepEqual(await two.json(url, "lrclib", signal()), {
      a: ["original"],
    });
  } finally {
    assert.ok(path.basename(directory).startsWith("cd-player-online-cache-"));
    await rm(directory, { recursive: true, force: true });
  }
});
test("transport rejects unsafe redirects, oversize responses and invalid JSON without caching them", async () => {
  const unsafe = createOnlineHttp({
    sleep: noWait,
    fetch: fetcher(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://127.0.0.1/private" },
        }),
    ),
  });
  await assert.rejects(
    unsafe.bytes(
      "https://coverartarchive.org/release/x/front-500",
      "cover",
      signal(),
      1024,
    ),
    /不支持的地址/,
  );
  const huge = createOnlineHttp({
    sleep: noWait,
    fetch: fetcher(() => new Response("xxxxx")),
  });
  await assert.rejects(
    huge.bytes("https://lrclib.net/api/get", "lrclib", signal(), 2),
    /过大/,
  );
  const malformed = createOnlineHttp({
    sleep: noWait,
    fetch: fetcher(() => new Response("{broken")),
  });
  await assert.rejects(
    malformed.json("https://lrclib.net/api/get", "lrclib", signal()),
    /无法读取/,
  );
});
test("cancellation aborts a request and a subsequent offline failure remains recoverable", async () => {
  const controller = new AbortController();
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const http = createOnlineHttp({
    sleep: noWait,
    fetch: fetcher(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          reached();
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
    ),
  });
  const pending = http.json(
    "https://lrclib.net/api/get",
    "lrclib",
    controller.signal,
  );
  await ready;
  controller.abort();
  await assert.rejects(pending, /取消/);
  const offline = createOnlineHttp({
    sleep: noWait,
    fetch: fetcher(() => {
      throw new Error("offline");
    }),
  });
  await assert.rejects(
    offline.json("https://lrclib.net/api/get", "lrclib", signal()),
    /检查网络/,
  );
});
test("per-request timeout bounds a stalled provider", async () => {
  const http = createOnlineHttp({
    timeoutMs: 25,
    sleep: noWait,
    fetch: fetcher(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("timeout")),
            { once: true },
          );
        }),
    ),
  });
  // AbortSignal.timeout is unref'ed; keep this fake-only request alive like a real socket.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      http.json("https://lrclib.net/api/get", "lrclib", signal()),
      /超时/,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

async function serverFixture(online: OnlineServices) {
  const root = await mkdtemp(path.join(tmpdir(), "cd-player-online-server-")),
    store = await openLocalStore(root),
    f = fixture();
  await store.transact((data) => Object.assign(data, f.data));
  const server = await startLocalServer({ store, dataDirectory: root, online });
  const post = async (route: string, action: UIAction) =>
    (
      await fetch(server.origin + "/api/" + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cd-token": server.token,
        },
        body: JSON.stringify(action),
      })
    ).json();
  const task = async (id: string) => {
    for (let tries = 0; tries < 200; tries++) {
      const t = await (
        await fetch(server.origin + "/api/task/" + id, {
          headers: { "x-cd-token": server.token },
        })
      ).json();
      if (t.state !== "running") return t;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Test task timed out");
  };
  return {
    ...f,
    store,
    server,
    post,
    task,
    async close() {
      await server.close();
      await store.close();
      assert.ok(path.basename(root).startsWith("cd-player-online-server-"));
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("authenticated real local transport reviews then adopts selected fields; stale/replayed review returns the latest snapshot", async () => {
  const f = fixture(),
    s = await serverFixture({
      metadata: async () => [{ release: f.remote, match: "text", notes: [] }],
      lyrics: async () => null,
    });
  try {
    const start = await s.post("task", {
      type: "lookupMetadata",
      albumId: s.album.id,
    });
    assert.equal(start.status, "started");
    assert.equal(start.metadataReview.status, "searching");
    const done = await s.task(start.taskId),
      review = done.result.metadataReview,
      candidate = review.candidates[0];
    const action: UIAction = {
      type: "applyMetadataCandidate",
      albumId: s.album.id,
      reviewId: review.id,
      candidateId: candidate.id,
      changeIds: candidate.changes
        .filter((c: { userEdited: boolean }) => !c.userEdited)
        .map((c: { id: string }) => c.id),
      confirmedProtectedChangeIds: [],
    };
    const saved = await s.post("action", action);
    assert.equal(saved.ok, true);
    assert.equal(saved.view.library.revision, s.data.library.revision + 1);
    const replay = await s.post("action", action);
    assert.equal(replay.code, "conflict");
    assert.deepEqual(replay.view, saved.view);
    const again = await s.post("task", {
      type: "lookupMetadata",
      albumId: s.album.id,
    });
    await s.task(again.taskId);
    await s.post("action", { type: "closeMetadataReview" });
    assert.equal(
      (await s.post("action", { ...action, reviewId: again.metadataReview.id }))
        .code,
      "conflict",
    );
  } finally {
    await s.close();
  }
});
test("real local transport rejects lyrics that arrive after a manual save and cancels ignored-abort late results", async () => {
  let release!: (value: ReturnType<typeof parseLyrics>) => void;
  const online: OnlineServices = {
    metadata: async () => [],
    lyrics: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const s = await serverFixture(online);
  try {
    const start = await s.post("task", {
      type: "lookupLyrics",
      trackId: s.track.id,
    });
    await s.store.transact((data) =>
      applyLocalWrite(data, {
        type: "saveLyrics",
        trackId: s.track.id,
        baseRevision: 0,
        patch: {
          ...parseLyrics("用户原文", s.track.id),
          kind: "plain",
          locked: true,
        },
      }),
    );
    release(parseLyrics("迟到原文", s.track.id));
    const done = await s.task(start.taskId);
    assert.equal(done.state, "failed");
    assert.equal(done.error.code, "conflict");
    assert.equal(
      done.result.view.lyricsByTrack[s.track.id].lines[0].original,
      "用户原文",
    );
    const locked = await s.post("task", {
      type: "lookupLyrics",
      trackId: s.track.id,
    });
    assert.equal(locked.code, "locked");
    await s.store.transact((data) =>
      applyLocalWrite(data, {
        type: "saveLyrics",
        trackId: s.track.id,
        baseRevision: 1,
        patch: {
          ...parseLyrics("", s.track.id),
          kind: "missing",
          locked: false,
        },
      }),
    );
    const cancelled = await s.post("task", {
      type: "lookupLyrics",
      trackId: s.track.id,
    });
    await s.post("task", { type: "cancelTask", taskId: cancelled.taskId });
    release(parseLyrics("取消后迟到", s.track.id));
    assert.equal((await s.task(cancelled.taskId)).state, "cancelled");
    assert.equal(s.store.read().lyricsByTrack[s.track.id].kind, "missing");
  } finally {
    await s.close();
  }
});
test("cover preview is an authenticated local resource; applying it preserves protection and serves the exact cached image", async () => {
  const f = fixture(),
    png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
  const s = await serverFixture({
    metadata: async () => [
      { release: f.remote, match: "text", notes: [], cover: png },
    ],
    lyrics: async () => null,
  });
  try {
    await s.store.transact((data) => {
      data.library.albums[0].userEditedFields.push("cover");
    });
    const start = await s.post("task", {
        type: "lookupMetadata",
        albumId: s.album.id,
      }),
      done = await s.task(start.taskId);
    const review = done.result.metadataReview,
      candidate = review.candidates[0],
      change = candidate.changes.find(
        (c: { field: string }) => c.field === "cover",
      );
    assert.match(change.to.thumbUrl, /^\/api\/online-cover\//);
    assert.deepEqual(Object.keys(change.to), ["thumbUrl"]);
    const missingAuth = await fetch(s.server.origin + change.to.thumbUrl);
    assert.equal(missingAuth.ok, false);
    const cover = await fetch(s.server.origin + change.to.thumbUrl, {
      headers: { "x-cd-token": s.server.token },
    });
    assert.equal(cover.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), png);
    const action: UIAction = {
      type: "applyMetadataCandidate",
      albumId: s.album.id,
      reviewId: review.id,
      candidateId: candidate.id,
      changeIds: [change.id],
      confirmedProtectedChangeIds: [change.id],
    };
    const saved = await s.post("action", action);
    assert.equal(saved.ok, true);
    assert.ok(saved.view.library.albums[0].userEditedFields.includes("cover"));
    const stored = await fetch(
      s.server.origin + saved.view.library.albums[0].cover.fullUrl,
      { headers: { "x-cd-token": s.server.token } },
    );
    assert.deepEqual(Buffer.from(await stored.arrayBuffer()), png);
  } finally {
    await s.close();
  }
});

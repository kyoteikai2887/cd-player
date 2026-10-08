import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createOnlineServices } from "../src/local/online/providers.ts";
import { scanFolder } from "../src/local/scanner.ts";
import { createOnlineHttp, pause } from "../src/local/online/http.ts";
import { credit } from "../src/local/online/providers.ts";
import { createDemoData } from "../src/mock/fixtures.ts";
const folder = process.argv[2];
const publicExample = folder === "--public-example";
const allLyrics = process.argv.includes('--all-lyrics');
if (!publicExample && (!folder || !path.isAbsolute(folder)))
  throw Error(
    "Provide --public-example or an explicitly approved absolute music folder.",
  );
const output = path.resolve(".cache", "online-live-" + Date.now());
await mkdir(output, { recursive: true });
const controller = new AbortController(),
  timer = setTimeout(() => controller.abort(), 90000);
const services = createOnlineServices({
  directory: path.join(output, "cache"),
});
const report = {
  defaultStoreModified: false,
  originalMusicModified: false,
  requestsExplicitOnly: true,
  publicExample,
  metadata: null,
  lyrics: null,
};
try {
  let scan;
  if (publicExample) {
    // This public release ID is from the official CAA API documentation. No local collection is read.
    const http = createOnlineHttp({
      directory: path.join(output, "public-example-cache"),
    });
    const r = await http.json(
      "https://musicbrainz.org/ws/2/release/76df3287-6cda-33eb-8e9a-044b5e15ffdd?inc=recordings%2Bartist-credits%2Blabels%2Bdiscids&fmt=json",
      "musicbrainz",
      controller.signal,
    );
    const demo = createDemoData(),
      album = demo.library.albums[0],
      medium = r.media[0];
    album.title = r.title;
    album.albumArtists = credit(r["artist-credit"]).names;
    album.albumArtistCredit = credit(r["artist-credit"]).display;
    album.catalogNumber = r["label-info"]?.[0]?.["catalog-number"] ?? null;
    album.rip = medium.discs?.[0]?.id
      ? {
          hasLog: false,
          hasCue: false,
          accurateRip: "unknown",
          discs: [
            {
              number: 1,
              hasLog: false,
              hasCue: false,
              discId: medium.discs[0].id,
            },
          ],
        }
      : undefined;
    const tracks = medium.tracks.map((t, n) => ({
      ...demo.library.tracks[0],
      id: "public-" + n,
      albumId: album.id,
      title: t.title ?? t.recording.title,
      artistCredit:
        credit(t["artist-credit"] ?? t.recording["artist-credit"])?.display ??
        album.albumArtistCredit,
      durationMs: t.length ?? t.recording.length,
      discNumber: 1,
      trackNumber: t.position,
    }));
    album.trackIds = tracks.map((t) => t.id);
    scan = { albums: [album], tracks };
    await pause(1100, controller.signal);
  } else
    scan = await scanFolder(
      folder,
      path.join(output, "covers"),
      controller.signal,
    );
  const album = scan.albums[0],
    tracks = scan.tracks.filter((t) => t.albumId === album.id);
  if (publicExample)
    await writeFile(
      path.join(output, "public-example.json"),
      JSON.stringify(
        {
          reference: "https://musicbrainz.org/doc/Cover_Art_Archive/API",
          album,
          tracks,
        },
        null,
        2,
      ),
    );
  console.log(
    JSON.stringify({
      output,
      album: album.title,
      trackCount: tracks.length,
      discs: album.rip?.discs,
    }),
  );
  try {
    const found = await services.metadata(album, tracks, controller.signal);
    report.metadata = {
      success: true,
      candidates: found.map((r) => ({
        id: r.release.id,
        title: r.release.title,
        match: r.match,
        discCount: r.release.media?.length,
        trackCount: r.release.media?.reduce((n, m) => n + m.tracks.length, 0),
        coverBytes: r.cover?.length ?? 0,
        notes: r.notes,
      })),
    };
  } catch (error) {
    report.metadata = {
      success: false,
      code: error.code,
      message: error.message,
    };
  }
  const lyricResults = [];
  for (const track of allLyrics ? tracks : tracks.slice(0, 1)) {
    try {
      const doc = await services.lyrics(track, album, controller.signal);
      lyricResults.push({ title: track.title, success: true, found: !!doc, kind: doc?.kind,
        lineCount: doc?.lines.length, source: doc?.source.original });
    } catch (error) { lyricResults.push({ title: track.title, success: false, code: error.code, message: error.message }); }
  }
  report.lyrics = allLyrics ? { tested: lyricResults.length, found: lyricResults.filter(r => r.found).length, results: lyricResults } : lyricResults[0];
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally {
  clearTimeout(timer);
}

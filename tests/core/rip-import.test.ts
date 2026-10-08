import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { scanFolder, mergeScan } from "../../src/local/scanner.ts";
import { openLocalStore } from "../../src/local/store.ts";
import { flac, pcm } from "../helpers/audioFiles.ts";

const temporaryRoots = new Set<string>();
after(async () => {
  for (const root of temporaryRoots) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(
      relative.startsWith("cd-player-rip-") && !relative.includes(path.sep),
    );
    await rm(root, { recursive: true, force: true });
  }
});
const clock = (frames: number) =>
  `${Math.floor(frames / 4500)}:${String(Math.floor(frames / 75) % 60).padStart(2, "0")}.${String(frames % 75).padStart(2, "0")}`;
function eacLog(names: string[], lengths: number[], starts?: number[]) {
  let position = 0;
  const rows = lengths.map((length, i) => {
    const start = starts?.[i] ?? position;
    position = start + length;
    return ` ${i + 1} | ${clock(start)} | ${clock(length)} | ${start} | ${position - 1}`;
  });
  return `Exact Audio Copy V1.8 from 15. July 2024\nEAC extraction logfile from 4. October 2026, 12:00\n\n原创歌手 / 双碟试验\n\nTOC of the extracted CD\nTrack | Start | Length | Start sector | End sector\n${rows.join("\n")}\n\n${names.map((name, i) => `Track  ${i + 1}\n\n Filename C:\\旧抓轨目录\\${name}.wav\n Test CRC ABCD1234\n Copy CRC ABCD1234\n Accurately ripped (confidence 7) [ABCD1234] (AR v2)\n Copy OK\n`).join("\n")}\nAll tracks accurately ripped\nNo errors occurred\nEnd of status report\n\n---- CUETools DB Plugin\nTrack | CTDB Status\n1 | (99/99) Accurately ripped\n`;
}
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "cd-player-rip-"));
  temporaryRoots.add(root);
  const music = path.join(root, "双碟试验");
  const files: string[] = [];
  for (const [disc, track, name, seconds] of [
    [1, 1, "01 第一音", 3],
    [1, 2, "02 第二音", 3],
    [2, 1, "01 第三音", 4],
  ] as const) {
    const directory = path.join(music, `CD ${disc}`);
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, name + ".flac");
    await writeFile(
      filename,
      flac(pcm(seconds), {
        ALBUM: "双碟试验",
        TITLE: name,
        TRACKNUMBER: String(track),
        DISCNUMBER: String(disc),
      }),
    );
    files.push(filename);
  }
  const log = path.join(music, "Disc One.log");
  const cue = path.join(music, "CD 2", "Disc Two.cue");
  await writeFile(
    log,
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(eacLog(["01 第一音", "02 第二音"], [225, 225]), "utf16le"),
    ]),
  );
  await writeFile(
    cue,
    'FILE "01 第三音.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n',
  );
  await mkdir(path.join(music, "unrelated"), { recursive: true });
  await writeFile(
    path.join(music, "unrelated", "other.log"),
    eacLog(["01 第三音"], [300]),
  );
  files.push(log, cue, path.join(music, "unrelated", "other.log"));
  const scan = () =>
    scanFolder(music, path.join(root, "covers"), new AbortController().signal);
  return { root, music, files, log, cue, scan };
}
const hashes = async (files: string[]) =>
  Promise.all(
    files.map(async (file) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ),
  );

test("multi-disc import associates a parent UTF-16 EAC log only with its matching disc; keeps originals and verification unknown", async () => {
  const fixture = await setup(),
    before = await hashes(fixture.files),
    scan = await fixture.scan();
  assert.equal(scan.albums.length, 1);
  assert.deepEqual(
    scan.albums[0].rip?.discs?.map((d) => ({
      number: d.number,
      hasLog: d.hasLog,
      hasCue: d.hasCue,
    })),
    [
      { number: 1, hasLog: true, hasCue: false },
      { number: 2, hasLog: false, hasCue: true },
    ],
  );
  assert.match(scan.albums[0].rip!.discs![0].discId!, /^[A-Za-z0-9._]{27}-$/);
  assert.equal(scan.albums[0].rip!.discs![1].discId, undefined);
  assert.equal(scan.albums[0].rip!.accurateRip, "unknown");
  assert.equal(scan.warnings.length, 0);
  assert.deepEqual(await hashes(fixture.files), before);
});

test("unrelated descendant logs do not mark an album or disc as having a rip log", async () => {
  const fixture = await setup();
  await rename(fixture.log, fixture.log + ".unused");
  await rename(fixture.cue, fixture.cue + ".unused");
  const scan = await fixture.scan();
  assert.equal(scan.albums[0].rip?.hasLog, false);
  assert.equal(scan.albums[0].rip?.hasCue, false);
  assert.ok(
    scan.albums[0].rip?.discs?.every(
      (d) => !d.hasLog && !d.hasCue && !d.discId,
    ),
  );
});

test("mismatched and conflicting TOCs cannot create a disc identity; reimport removes stale identity and survives restart", async () => {
  const fixture = await setup(),
    storeDirectory = path.join(fixture.root, "data");
  const store = await openLocalStore(storeDirectory);
  try {
    const scan = await fixture.scan();
    await store.transact((data) => mergeScan(data, scan));
    assert.ok(store.view().library.albums[0].rip?.discs?.[0].discId);
    // A one-frame shifted pressing has the same files/durations but a different disc ID.
    await writeFile(
      path.join(fixture.music, "alternate.log"),
      eacLog(["01 第一音", "02 第二音"], [225, 225], [1, 226]),
    );
    const conflict = await fixture.scan();
    assert.equal(conflict.albums[0].rip!.discs![0].discId, undefined);
    assert.ok(conflict.warnings.some((w) => w.includes("冲突")));
    await store.transact((data) => mergeScan(data, conflict));
    await writeFile(
      fixture.log,
      eacLog(["01 第一音", "02 第二音"], [226, 600]),
    );
    await rename(
      path.join(fixture.music, "alternate.log"),
      path.join(fixture.music, "alternate.log.unused"),
    );
    const mismatch = await fixture.scan();
    assert.equal(mismatch.albums[0].rip!.discs![0].discId, undefined);
    assert.ok(mismatch.warnings.some((w) => w.includes("对应")));
    await store.transact((data) => mergeScan(data, mismatch));
  } finally {
    await store.close();
  }
  const reopened = await openLocalStore(storeDirectory);
  try {
    assert.equal(
      reopened.view().library.albums[0].rip!.discs![0].discId,
      undefined,
    );
    assert.equal(reopened.view().library.albums[0].rip!.accurateRip, "unknown");
    assert.equal(reopened.view().library.tracks.length, 3);
  } finally {
    await reopened.close();
  }
});

test("a misplaced disc-local log cannot be adopted by a different disc", async () => {
  const fixture = await setup();
  await rename(
    fixture.log,
    path.join(fixture.music, "CD 2", "wrong-location.log"),
  );
  const scan = await fixture.scan();
  assert.equal(scan.albums[0].rip!.discs![0].hasLog, false);
  assert.equal(scan.albums[0].rip!.discs![1].hasLog, true);
  assert.ok(scan.albums[0].rip!.discs!.every((d) => !d.discId));
  assert.ok(scan.warnings.some((w) => w.includes("对应")));
});

test("parent CUE association respects relative directories, not just repeated basenames", async () => {
  const fixture = await setup();
  await rename(fixture.cue, path.join(fixture.music, "parent.cue"));
  await writeFile(
    path.join(fixture.music, "parent.cue"),
    'FILE "unrelated\\01 第三音.wav" WAVE\n TRACK 01 AUDIO\n',
  );
  let scan = await fixture.scan();
  assert.equal(scan.albums[0].rip!.hasCue, true);
  assert.ok(scan.albums[0].rip!.discs!.every((d) => !d.hasCue));
  await writeFile(
    path.join(fixture.music, "parent.cue"),
    'FILE "CD 2\\01 第三音.wav" WAVE\n TRACK 01 AUDIO\n',
  );
  scan = await fixture.scan();
  assert.equal(scan.albums[0].rip!.discs![0].hasCue, false);
  assert.equal(scan.albums[0].rip!.discs![1].hasCue, true);
  assert.equal(scan.albums[0].rip!.discs![1].discId, undefined);
});

test("ambiguous parent logs are not assigned to both discs even when names, durations and track numbers coincide", async () => {
  const fixture = await setup();
  await rename(
    path.join(fixture.music, "CD 2", "01 第三音.flac"),
    path.join(fixture.music, "CD 2", "01 第三音.flac.unused"),
  );
  for (const [number, name] of [
    [1, "01 第一音"],
    [2, "02 第二音"],
  ] as const)
    await writeFile(
      path.join(fixture.music, "CD 2", name + ".flac"),
      flac(pcm(3), {
        ALBUM: "双碟试验",
        TITLE: name,
        TRACKNUMBER: String(number),
        DISCNUMBER: "2",
      }),
    );
  const scan = await fixture.scan();
  assert.equal(scan.albums[0].rip!.hasLog, true);
  assert.ok(scan.albums[0].rip!.discs!.every((d) => !d.hasLog && !d.discId));
  assert.ok(scan.warnings.some((w) => w.includes("唯一对应")));
});

test("oversized and unsupported-encoding sidecars retain presence without aborting audio import or fabricating identity", async () => {
  const fixture = await setup();
  await writeFile(fixture.log, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  await writeFile(fixture.cue, Buffer.from([0xff, 0xff, 0]));
  const scan = await fixture.scan();
  assert.equal(scan.tracks.length, 3);
  assert.equal(scan.albums[0].rip!.hasLog, true);
  assert.equal(scan.albums[0].rip!.discs![1].hasCue, true);
  assert.ok(scan.albums[0].rip!.discs!.every((d) => !d.discId));
  assert.ok(scan.warnings.some((w) => w.includes("超过 2MB")));
  assert.ok(scan.warnings.some((w) => w.includes("编码不支持")));
});

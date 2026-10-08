import test from "node:test";
import assert from "node:assert/strict";
import type { Track } from "../../src/contracts/player.ts";
import {
  decodeRipText,
  parseEacLog,
  musicBrainzDiscId,
  logMatchesDisc,
} from "../../src/local/rip.ts";

const log = `Exact Audio Copy V1.8 from 15. July 2024
EAC extraction logfile from 4. October 2026, 12:00
TOC of the extracted CD
Track | Start | Length | Start sector | End sector
1 | 0:00.00 | 0:03.00 | 0 | 224
2 | 0:03.00 | 0:04.00 | 225 | 524

Track  1
 Filename E:\\旧目录\\01 光.wav
 Test CRC AABBCCDD
 Copy CRC AABBCCDD
 Accurately ripped (confidence 7) [AABBCCDD] (AR v2)
 Copy OK
Track  2
 Filename E:\\旧目录\\02 空.wav
 Copy OK
End of status report

---- CUETools DB Plugin
Track  99
 Filename misleading.wav
 (99/99) Accurately ripped
`;
const tracks = [
  { id: "a", trackNumber: 1, durationMs: 3000 },
  { id: "b", trackNumber: 2, durationMs: 4000 },
] as Track[];
const files = {
  a: { path: "D:\\音乐\\01 光.flac" },
  b: { path: "D:\\音乐\\02 空.flac" },
};

test("MusicBrainz official TOC vector has the documented disc ID", () => {
  assert.equal(
    musicBrainzDiscId({
      starts: [0, 15213, 32164, 46442, 63264, 80339],
      leadOut: 95312,
    }),
    "49HHV7Eb8UKF3aQiNmu1GR8vKTY-",
  );
});
test("disc identity rejects empty, unordered, fractional and overflowing TOCs", () => {
  for (const toc of [
    { starts: [], leadOut: 0 },
    { starts: [0, 0], leadOut: 10 },
    { starts: [1, 0], leadOut: 10 },
    { starts: [0.5], leadOut: 10 },
    { starts: [0], leadOut: 0xffffffff },
    { starts: Array(100).fill(0), leadOut: 10 },
  ])
    assert.equal(musicBrainzDiscId(toc), null);
});
test("UTF-8/UTF-16 BOMs preserve multilingual names; malformed encodings are rejected", () => {
  const text = "光と空中文";
  const le = Buffer.from(text, "utf16le"),
    be = Buffer.from(le).swap16();
  for (const bytes of [
    Buffer.from(text),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), be]),
  ])
    assert.equal(decodeRipText(bytes), text);
  assert.equal(decodeRipText(Buffer.from([0xff, 0xff, 0])), null);
  assert.equal(decodeRipText(Buffer.from([0xff, 0xfe, 0x12])), null);
});
test("EAC parser uses CD-frame durations and stops before plugins", () => {
  const parsed = parseEacLog(log.replaceAll("\n", "\r\n"))!;
  assert.deepEqual(parsed.toc, { starts: [0, 225], leadOut: 525 });
  assert.deepEqual(
    parsed.tracks.map((t) => [t.number, t.durationMs]),
    [
      [1, 3000],
      [2, 4000],
    ],
  );
  assert.equal(parsed.tracks[0].filename, "E:\\旧目录\\01 光.wav");
  assert.ok(logMatchesDisc(parsed, tracks, files));
});
test("truncated, appended, plugin-only and image logs do not produce a disc identity", () => {
  for (const value of [
    log.replace("End of status report", ""),
    log + log,
    "---- CUETools DB Plugin\nAll tracks accurately ripped\nNo errors occurred",
    log.replace("Track  2\n Filename", "Range\n Filename"),
  ])
    assert.equal(parseEacLog(value), null);
});
test("TOC corruption cannot be papered over by success strings", () => {
  for (const value of [
    log.replace("| 224", "| 223"),
    log.replace("0:03.00 | 0:04.00", "0:03.75 | 0:04.00"),
    log.replace("2 | 0:03.00", "3 | 0:03.00"),
    log.replace(
      "0:03.00 | 0:04.00 | 225 | 524",
      "0:03.01 | 0:04.00 | 226 | 525",
    ),
  ])
    assert.equal(parseEacLog(value), null);
});
test("matching rejects missing, duplicated, renumbered, renamed and wrong-duration audio", () => {
  const parsed = parseEacLog(log)!;
  for (const altered of [
    tracks.slice(0, 1),
    [...tracks, tracks[0]],
    [{ ...tracks[0], trackNumber: 2 }, tracks[1]],
    [{ ...tracks[0], durationMs: 3100 }, tracks[1]],
  ])
    assert.equal(logMatchesDisc(parsed, altered, files), false);
  assert.equal(
    logMatchesDisc(parsed, tracks, { ...files, a: { path: "01 光修改.flac" } }),
    false,
  );
  assert.equal(logMatchesDisc(parsed, tracks, {}), false);
});
test("matching permits frame-rounding and NFC names without requiring obsolete original drive paths", () => {
  const parsed = parseEacLog(log.replace("01 光.wav", "01 é.wav"))!;
  assert.ok(
    logMatchesDisc(parsed, [{ ...tracks[0], durationMs: 3013 }, tracks[1]], {
      ...files,
      a: { path: "Z:/新位置/01 e\u0301.FLAC" },
    }),
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { flac, pcm } from "../tests/helpers/audioFiles.ts";
import { openLocalStore } from "../src/local/store.ts";

// Exercises the same bundled Node/backend as the Windows prototype, using rescan to avoid a GUI picker.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(root, ".cache", "rip-import-" + Date.now());
const input = process.argv.slice(2);
assert.ok(
  input.length === 0 ||
    (input.length === 2 && input[0] === "--music" && path.isAbsolute(input[1])),
  "Usage: node scripts/rip-import-smoke.mjs [--music <absolute single-album folder>]",
);
const realMusic = input.length === 2;
const music = realMusic
    ? await realpath(input[1])
    : path.join(workspace, "original-synthetic-music"),
  directory = path.join(workspace, "data");
const originals = [];
if (realMusic) {
  // Read-only, flat single-album audit. Never copy recordings into the test workspace or release package.
  const entries = await readdir(music, { withFileTypes: true });
  assert.ok(
    entries.every((entry) => entry.isFile()),
    "The audit expects a flat album folder without links or subdirectories",
  );
  originals.push(
    ...entries.map((entry) => path.join(music, entry.name)).sort(),
  );
} else {
  for (const [disc, track, name, seconds] of [
    [1, 1, "01 第一音", 3],
    [1, 2, "02 第二音", 3],
    [2, 1, "01 第三音", 4],
  ]) {
    const folder = path.join(music, "CD " + disc);
    await mkdir(folder, { recursive: true });
    const filename = path.join(folder, name + ".flac");
    await writeFile(
      filename,
      flac(pcm(seconds), {
        ALBUM: "原创双碟联调",
        TITLE: name,
        DISCNUMBER: String(disc),
        TRACKNUMBER: String(track),
      }),
    );
    originals.push(filename);
  }
  const log = `Exact Audio Copy V1.8 from 15. July 2024
EAC extraction logfile from 4. October 2026, 12:00
TOC of the extracted CD
Track | Start | Length | Start sector | End sector
1 | 0:00.00 | 0:03.00 | 0 | 224
2 | 0:03.00 | 0:03.00 | 225 | 449
Track  1
 Filename C:\\旧目录\\01 第一音.wav
 Accurately ripped (confidence 7) [12345678] (AR v2)
 Copy OK
Track  2
 Filename C:\\旧目录\\02 第二音.wav
 Accurately ripped (confidence 7) [12345678] (AR v2)
 Copy OK
All tracks accurately ripped
No errors occurred
End of status report
`;
  const logFile = path.join(music, "Disc One.log"),
    cueFile = path.join(music, "CD 2", "Disc Two.cue");
  await writeFile(
    logFile,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(log, "utf16le")]),
  );
  await writeFile(
    cueFile,
    'FILE "01 第三音.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n',
  );
  originals.push(logFile, cueFile);
}
const trackCount = originals.filter((file) =>
  /\.(flac|wav|mp3)$/i.test(file),
).length;
assert.ok(trackCount > 0);
const hashes = () =>
  Promise.all(
    originals.map(async (file) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ),
  );
const before = await hashes();
let store = await openLocalStore(directory);
try {
  await store.transact((data) => {
    data.roots.push(music);
  });
} finally {
  await store.close();
}
const child = spawn(
  path.join(root, ".native-runtime/node.exe"),
  [
    path.join(root, ".native-runtime/server.mjs"),
    "--data",
    directory,
    "--assets",
    path.join(root, "dist"),
    "--picker",
    path.join(root, ".native-runtime/file-picker.exe"),
  ],
  { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let errors = "";
child.stderr.on("data", (data) => {
  errors += data;
});
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
const timeout = setTimeout(() => child.kill(), 30000);
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push({ name, passed: true });
};
let rip;
try {
  const lines = createInterface({ input: child.stdout });
  const origin = await new Promise((resolve, reject) => {
    lines.once("line", (line) => {
      try {
        resolve(JSON.parse(line).origin);
      } catch (error) {
        reject(error);
      }
    });
    exited.then(
      (code) => reject(new Error("Backend exited before startup: " + code)),
      reject,
    );
  });
  const bootstrap = await (await fetch(origin + "/api/bootstrap")).json();
  const headers = {
    "x-cd-token": bootstrap.token,
    "content-type": "application/json",
  };
  const rescan = async () => {
    const response = await fetch(origin + "/api/task", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "rescanLibrary" }),
    });
    assert.equal(response.status, 200);
    const task = await response.json();
    for (let i = 0; i < 200; i++) {
      const current = await (
        await fetch(origin + "/api/task/" + task.taskId, { headers })
      ).json();
      if (current.state !== "running") {
        assert.equal(current.state, "done", JSON.stringify(current));
        return current.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error("Rescan did not settle");
  };
  const imported = await rescan(),
    library = imported.view.library;
  rip = library.albums[0].rip;
  check(
    "real bundled backend imports one album with the expected track and disc order",
    () => {
      assert.equal(library.albums.length, 1);
      assert.equal(library.tracks.length, trackCount);
      if (realMusic) {
        assert.deepEqual(
          library.albums[0].discs.map((d) => d.number),
          [1],
        );
        assert.deepEqual(
          library.albums[0].trackIds.map(
            (id) => library.tracks.find((t) => t.id === id).trackNumber,
          ),
          Array.from({ length: trackCount }, (_, i) => i + 1),
        );
        assert.ok(library.albums[0].cover);
        return;
      }
      assert.deepEqual(
        library.albums[0].discs.map((d) => d.number),
        [1, 2],
      );
      assert.deepEqual(
        library.albums[0].trackIds.map(
          (id) => library.tracks.find((t) => t.id === id).discNumber,
        ),
        [1, 1, 2],
      );
    },
  );
  check(
    "EAC log matches relocated WAV-to-FLAC filenames; sidecars attach to the correct discs",
    () => {
      if (realMusic) {
        assert.deepEqual(
          rip.discs.map((d) => [d.number, d.hasLog, d.hasCue]),
          [[1, true, originals.some((file) => /\.cue$/i.test(file))]],
        );
      } else
        assert.deepEqual(
          rip.discs.map((d) => [d.number, d.hasLog, d.hasCue]),
          [
            [1, true, false],
            [2, false, true],
          ],
        );
      assert.ok(rip.discs[0].discId);
      if (!realMusic) assert.equal(rip.discs[1].discId, undefined);
      assert.equal(rip.accurateRip, "unknown");
      assert.deepEqual(imported.warnings, []);
    },
  );
  const repeated = await rescan();
  check("repeat scan preserves identity without duplicate tracks", () => {
    assert.deepEqual(repeated.view.library.albums[0].rip, rip);
    assert.equal(repeated.view.library.tracks.length, trackCount);
  });
  const track = library.tracks[0];
  const audio = await fetch(origin + "/api/media/" + track.id, {
    headers: { ...headers, range: "bytes=0-3" },
  });
  check(
    "newly imported track is served by the authenticated media range API",
    () => assert.equal(audio.status, 206),
  );
  assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), "fLaC");
} finally {
  child.stdin.end("shutdown\n");
  const exit = await exited.finally(() => clearTimeout(timeout));
  assert.equal(exit, 0, errors);
}
store = await openLocalStore(directory);
try {
  check(
    "restart releases the writer lock and keeps per-disc rip identity",
    () => {
      assert.deepEqual(store.view().library.albums[0].rip, rip);
      assert.equal(store.view().library.tracks.length, trackCount);
    },
  );
} finally {
  await store.close();
}
assert.deepEqual(await hashes(), before);
checks.push({
  name: `all ${originals.length} original files retain their SHA256`,
  passed: true,
});
const version = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).version;
const report = path.join(workspace, "report.json");
await writeFile(
  report,
  JSON.stringify(
    {
      version,
      passed: true,
      checks,
      rip,
      exit: 0,
      backend: "bundled .native-runtime/server.mjs and node.exe",
      originalsUnchanged: true,
      realMusicTested: realMusic,
      originalFiles: originals.length,
      trackCount,
      defaultUserDataModified: false,
      warnings: [],
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    { report, passed: true, checks: checks.length, version },
    null,
    2,
  ),
);

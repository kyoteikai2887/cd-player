import path from "node:path";
import { fileURLToPath } from "node:url";
import { open, readFile, writeFile, stat, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Mp3Encoder } from "@breezystack/lamejs";
import { createAudioFolder, pcm } from "../tests/helpers/audioFiles.ts";
import { openLocalStore } from "../src/local/store.ts";
import { scanFolder, mergeScan } from "../src/local/scanner.ts";
import { canBufferAudio } from "../src/core/adaptiveAudio.ts";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const directory = path.join(
  project,
  ".cache",
  "audio-long-compressed-" + Date.now(),
);
const music = path.join(directory, "original-fixtures");
const seconds = 600,
  sampleRate = 44100,
  channels = 2;
const encoderArg = process.argv.indexOf("--flac");
const flacEncoder = encoderArg >= 0 ? process.argv[encoderArg + 1] : null;
const fixtureArg = process.argv.indexOf("--fixtures");
const prepared = fixtureArg >= 0 ? process.argv[fixtureArg + 1] : null;
if (
  !prepared &&
  (!flacEncoder ||
    !path.isAbsolute(flacEncoder) ||
    !(await stat(flacEncoder)).isFile())
) {
  throw new Error(
    "Provide an installed FLAC encoder using --flac <absolute path>. Only synthetic files are encoded.",
  );
}
await createAudioFolder(music, 6);
const flacFile = path.join(music, "01 Long FLAC.flac");
const mp3File = path.join(music, "02 Long MP3.mp3");
if (prepared) {
  if (!path.isAbsolute(prepared))
    throw new Error("Prepared synthetic fixture directory must be absolute.");
  for (const filename of [flacFile, mp3File]) {
    await copyFile(path.join(prepared, path.basename(filename)), filename);
  }
  console.log("Reused the two prepared synthetic long compressed fixtures.");
} else {
  const sourceWav = path.join(directory, "synthetic-long-source.wav");
  const wavHandle = await open(sourceWav, "wx");
  try {
    const bytes = sampleRate * seconds * channels * 2;
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(bytes + 36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(bytes, 40);
    await wavHandle.write(header);
    const tone = pcm(1),
      second = Buffer.alloc(sampleRate * channels * 2);
    for (let i = 0; i < sampleRate; i++) {
      second.writeInt16LE(tone[i], i * 4);
      second.writeInt16LE(tone[i], i * 4 + 2);
    }
    for (let i = 0; i < seconds; i++) await wavHandle.write(second);
  } finally {
    await wavHandle.close();
  }
  const flacProcess = spawn(
    flacEncoder,
    [
      "--silent",
      "-6",
      "-V",
      "--seekpoint=10s",
      "-T",
      "TITLE=01 Long FLAC",
      "-o",
      flacFile,
      sourceWav,
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "inherit"] },
  );
  const flacTimer = setTimeout(() => flacProcess.kill(), 120000);
  const flacExit = await new Promise((resolve, reject) => {
    flacProcess.once("error", reject);
    flacProcess.once("exit", resolve);
  }).finally(() => clearTimeout(flacTimer));
  if (flacExit !== 0)
    throw new Error("Synthetic FLAC encoding/verification failed");
  console.log("Created verified 10-minute stereo FLAC fixture.");
  const mp3Handle = await open(mp3File, "wx");
  try {
    const encoder = new Mp3Encoder(channels, sampleRate, 192),
      second = pcm(1, 520);
    const write = async (part) => {
      if (part.length)
        await mp3Handle.write(
          Buffer.from(part.buffer, part.byteOffset, part.byteLength),
        );
    };
    for (let i = 0; i < seconds; i++) {
      for (let j = 0; j < second.length; j += 1152) {
        const chunk = second.subarray(j, j + 1152);
        await write(encoder.encodeBuffer(chunk, chunk));
      }
      if ((i + 1) % 120 === 0)
        console.log(`Encoded ${i + 1} seconds of original MP3 fixture.`);
    }
    await write(encoder.flush());
  } finally {
    await mp3Handle.close();
  }
}
const digest = async (filename) =>
  createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
const originals = await Promise.all(
  [flacFile, mp3File].map(async (filename) => ({
    filename,
    sha256: await digest(filename),
  })),
);
const dataDirectory = path.join(directory, "data");
const store = await openLocalStore(dataDirectory);
let fixtures;
try {
  const scan = await scanFolder(
    music,
    path.join(dataDirectory, "covers"),
    new AbortController().signal,
  );
  if (scan.warnings.length || scan.tracks.length !== 6)
    throw new Error(JSON.stringify(scan.warnings));
  fixtures = scan.tracks
    .filter((t) => t.title === "01 Long FLAC" || t.title === "02 Long MP3")
    .map((t) => {
      const info = {
        size: scan.files[t.id].size,
        durationMs: t.durationMs,
        sampleRate,
        channels,
      };
      if (
        t.durationMs < 599000 ||
        t.durationMs > 601000 ||
        canBufferAudio(info)
      ) {
        throw new Error(
          "Long fixture did not exceed the automatic decoded PCM budget: " +
            JSON.stringify(info),
        );
      }
      return {
        title: t.title,
        ...info,
        wouldBuffer: false,
        decodedPCMBytesAt48kHz:
          Math.ceil((t.durationMs / 1000) * 48000) * channels * 4,
      };
    });
  if (fixtures.length !== 2)
    throw new Error("Long compressed metadata missing");
  await store.transact((data) => mergeScan(data, scan));
} finally {
  await store.close();
}
const reports = [];
for (const mode of ["adaptive", "streaming"]) {
  console.log("Starting long compressed native checks: " + mode);
  const report = path.join(directory, mode + ".json");
  const child = spawn(
    path.join(project, "src-tauri/target/debug/cd-player-desktop.exe"),
    [
      "--smoke-data",
      dataDirectory,
      "--smoke-report",
      report,
      "--smoke-audio",
      "--smoke-long-compressed",
      ...(mode === "streaming" ? ["--smoke-stream-only"] : []),
    ],
    {
      cwd: project,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const timer = setTimeout(() => child.kill(), 100000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => clearTimeout(timer));
  const result = JSON.parse(await readFile(report, "utf8"));
  const reopened = await openLocalStore(dataDirectory);
  await reopened.close();
  reports.push({ ...result, mode, exit, report });
  if (
    !result.passed ||
    !result.longCompressed ||
    result.checks.length !== 14 ||
    exit !== 0
  ) {
    throw new Error(JSON.stringify(reports, null, 2));
  }
}
for (const original of originals)
  if ((await digest(original.filename)) !== original.sha256)
    throw new Error("Synthetic input was modified");
const result = {
  passed: true,
  prototypeVersion: JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  ).version,
  reports,
  fixtures,
  installedFlacEncoderRequiredForFixtureGeneration: !prepared,
  sourceHashesUnchanged: true,
  originalUserMusicUsed: false,
  limits: [
    "10-minute files were sampled and sought, not played fully from start to finish",
    "Short successors exercise mixed backends; full-process peak memory and subjective quality not measured",
  ],
};
const summaryPath = path.join(directory, "report.json");
await writeFile(summaryPath, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    {
      passed: true,
      fixtures,
      checksPerMode: reports.map((r) => r.checks.length),
      summaryPath,
    },
    null,
    2,
  ),
);

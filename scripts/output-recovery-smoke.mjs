import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createAudioFolder } from "../tests/helpers/audioFiles.ts";
import { openLocalStore } from "../src/local/store.ts";
import { scanFolder, mergeScan } from "../src/local/scanner.ts";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const directory = path.join(
  project,
  ".cache",
  "audio-output-recovery-" + Date.now(),
);
const music = path.join(directory, "original-fixtures");
await createAudioFolder(music, 8);
const dataDirectory = path.join(directory, "data");
const store = await openLocalStore(dataDirectory);
try {
  const scan = await scanFolder(
    music,
    path.join(dataDirectory, "covers"),
    new AbortController().signal,
  );
  if (scan.warnings.length || scan.tracks.length !== 4)
    throw new Error(JSON.stringify(scan.warnings));
  await store.transact((data) => mergeScan(data, scan));
} finally {
  await store.close();
}
const report = path.join(directory, "report.json");
const child = spawn(
  path.join(project, "src-tauri/target/debug/cd-player-desktop.exe"),
  ["--smoke-data", dataDirectory, "--smoke-report", report, "--smoke-recovery"],
  { cwd: project, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
);
const timer = setTimeout(() => child.kill(), 60000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
}).finally(() => clearTimeout(timer));
const result = JSON.parse(await readFile(report, "utf8"));
const reopened = await openLocalStore(dataDirectory);
await reopened.close();
const version = JSON.parse(
  await readFile(path.join(project, "package.json"), "utf8"),
).version;
const record = {
  ...result,
  prototypeVersion: version,
  exit,
  storeReopened: true,
};
await writeFile(report, JSON.stringify(record, null, 2));
if (
  !result.passed ||
  !result.recovery ||
  result.checks.length !== 8 ||
  exit !== 0
)
  throw new Error(JSON.stringify(record, null, 2));
console.log(
  JSON.stringify(
    {
      passed: true,
      checks: result.checks.length,
      realAudioContextsClosed: result.realAudioContextsClosed,
      report,
    },
    null,
    2,
  ),
);

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
  "audio-continuous-" + Date.now(),
);
const music = path.join(directory, "original-fixtures");
await createAudioFolder(music, 3);
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
const reports = [];
for (const mode of ["adaptive", "streaming"]) {
  console.log(`Starting hidden continuous playback: ${mode}`);
  const report = path.join(directory, mode + ".json");
  const child = spawn(
    path.join(project, "src-tauri/target/debug/cd-player-desktop.exe"),
    [
      "--smoke-data",
      dataDirectory,
      "--smoke-report",
      report,
      "--smoke-continuous",
      ...(mode === "streaming" ? ["--smoke-stream-only"] : []),
    ],
    {
      cwd: project,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const timer = setTimeout(() => child.kill(), 85000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => clearTimeout(timer));
  const result = JSON.parse(await readFile(report, "utf8"));
  const reopened = await openLocalStore(dataDirectory);
  await reopened.close();
  reports.push({ ...result, mode, exit, report });
  if (!result.passed || exit !== 0)
    throw new Error(JSON.stringify(reports, null, 2));
  console.log(
    `${mode}: ${result.entryCount} entries finished naturally in ${Math.round(result.elapsedMs)} ms`,
  );
}
const result = { passed: true, reports };
await writeFile(
  path.join(directory, "report.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify(
    {
      passed: true,
      modes: reports.map((r) => r.mode),
      entriesPerMode: reports.map((r) => r.entryCount),
      summaryPath: path.join(directory, "report.json"),
    },
    null,
    2,
  ),
);

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { openLocalStore } from "../src/local/store.ts";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const directory = path.join(
  project,
  ".cache",
  "native-materials-" + Date.now(),
);
await mkdir(directory, { recursive: true });
const data = path.join(directory, "data");
const report = path.join(directory, "report.json");
const child = spawn(
  path.join(project, "src-tauri/target/debug/cd-player-desktop.exe"),
  ["--smoke-data", data, "--smoke-report", report, "--smoke-materials"],
  { cwd: project, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
);
const timer = setTimeout(() => child.kill(), 45000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
}).finally(() => clearTimeout(timer));
const result = JSON.parse(await readFile(report, "utf8"));
const reopened = await openLocalStore(data);
await reopened.close();
console.log(
  JSON.stringify({ ...result, exit, report, dataLockReleased: true }, null, 2),
);
if (!result.passed || exit !== 0) process.exitCode = 1;

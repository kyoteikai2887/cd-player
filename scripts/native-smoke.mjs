import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile, cp, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { openLocalStore } from "../src/local/store.ts";
import { scanFolder, mergeScan } from "../src/local/scanner.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, '.cache/audio-check');
async function fingerprints(folder) {
  const values = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(await fingerprints(filename)))
      values[path.join(entry.name, name)] = value;
    else values[entry.name] = createHash('sha256').update(await readFile(filename)).digest('hex');
  }
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}
const originalFiles = await fingerprints(fixture);
const workspace = path.join(root, ".cache", "native-smoke-" + Date.now());
await mkdir(workspace, { recursive: true });
let music = fixture;
if (process.argv.includes('--relocated')) {
  music = path.join(workspace, 'music-original');
  await cp(fixture, music, { recursive: true });
}
const directory = path.join(workspace, "data"),
  report = path.join(workspace, "report.json");
const store = await openLocalStore(directory);
try {
  const scan = await scanFolder(
    music,
    path.join(directory, "covers"),
    new AbortController().signal,
  );
  await store.transact((data) => mergeScan(data, scan));
} finally {
  await store.close();
}
let relocation = null;
if (process.argv.includes('--relocated')) {
  const moved = path.join(workspace, 'music-moved');
  for (const target of [music, moved]) {
    const relative = path.relative(workspace, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Unsafe relocation fixture target');
  }
  await rename(music, moved);
  music = moved;
  const linked = await openLocalStore(directory);
  try {
    const before = linked.read();
    const scan = await scanFolder(moved, path.join(directory, 'covers'), new AbortController().signal);
    let result;
    await linked.transact(data => { result = mergeScan(data, scan); });
    const after = linked.read();
    if (!result.relocated || JSON.stringify(before.library.tracks.map(t => t.id).sort()) !==
      JSON.stringify(after.library.tracks.map(t => t.id).sort()) ||
      after.library.albums.length !== before.library.albums.length ||
      Object.values(after.files).some(file => !file.path.startsWith(moved + path.sep)))
      throw Error('Fixture relocation lost IDs or duplicated records');
    relocation = { relocatedAlbums: result.relocated, stableTrackIds: true, albumCountUnchanged: true,
      pathsUpdated: true, originalSyntheticFilesUnchanged: JSON.stringify(await fingerprints(moved)) === JSON.stringify(originalFiles) };
    if (!relocation.originalSyntheticFilesUnchanged) throw Error('Relocation altered music or attachments');
  } finally { await linked.close(); }
}
let staleLock = null;
if (process.argv.includes('--stale-lock')) {
  const departed = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = departed.pid;
  await new Promise((resolve, reject) => { departed.once('exit', resolve); departed.once('error', reject); });
  try { process.kill(pid, 0); throw Error('Test lock owner is still alive'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  staleLock = JSON.stringify({ pid });
  await writeFile(path.join(directory, 'writer.lock'), staleLock);
}
const executable = path.join(
  root,
  "src-tauri/target/debug/cd-player-desktop.exe",
);
const child = spawn(
  executable,
  ["--smoke-data", directory, "--smoke-report", report],
  { cwd: root, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
);
const timeout = setTimeout(() => child.kill(), 60000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
}).finally(() => clearTimeout(timeout));
let result;
try {
  result = JSON.parse(await readFile(report, "utf8"));
} catch {
  throw Error("原生自检未生成报告，退出码：" + exit);
}
console.log(JSON.stringify({ ...result, report }, null, 2));
const reopened = await openLocalStore(directory);
try {
  if (staleLock) {
    const quarantined = (await readdir(directory)).filter(name => name.startsWith('writer.lock.stale-'));
    if (quarantined.length !== 1 || await readFile(path.join(directory, quarantined[0]), 'utf8') !== staleLock)
      throw Error('Dead-owner lock was not preserved during startup recovery');
    const recovery = { passed: result.passed && exit === 0, oldLockPreserved: true,
      nativeGuardedDeadOwnerRecovery: true, normalShutdownAndReopen: true };
    await writeFile(path.join(workspace, 'startup-recovery.json'), JSON.stringify(recovery, null, 2));
    console.log('遗留锁经原生实例保护自动恢复，原锁保留，随后正常关闭并重新取得资料锁。');
  }
  if (!reopened.view().settings.miniAlwaysOnTop)
    throw Error("Native settings did not persist");
  if (result.passed && !Object.keys(reopened.read().excludedTrackIds ?? {}).length)
    throw Error('Native removal exclusions did not persist');
  if (JSON.stringify(await fingerprints(fixture)) !== JSON.stringify(originalFiles))
    throw Error('Collection removal changed original audio or sidecar files');
  if (relocation) {
    if (JSON.stringify(await fingerprints(music)) !== JSON.stringify(originalFiles)) throw Error('Relocated files changed');
    await writeFile(path.join(workspace, 'relocation.json'), JSON.stringify({ ...relocation,
      passed: result.passed && exit === 0, nativeChecksPassed: result.checks?.length ?? 0, normalShutdownAndReopen: true }, null, 2));
    console.log('关联后的合成库已通过原生联调，曲目编号保持，原音乐与附件未修改。');
  }
  console.log("后台正常关闭，资料锁已释放，设置已保存。");
  console.log('原始合成音乐与附件哈希未变，移除记录已持久化。');
} finally {
  await reopened.close();
}
if (!result.passed || exit !== 0) process.exitCode = 1;

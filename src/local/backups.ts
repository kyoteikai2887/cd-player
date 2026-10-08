import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { LocalError } from "./model.ts";
import type { LocalData } from "./model.ts";

const backupName =
  /^library-\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const checksum = (payload: string) =>
  createHash("sha256").update(payload).digest("hex");

export interface BackupRecord {
  id: string;
  createdAt: string;
  libraryRevision: number;
  tracks: number;
}

/** The same persisted shape is used by normal startup and explicit recovery. */
export function parseLocalData(text: string): LocalData {
  const data = JSON.parse(text) as LocalData;
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    data?.schemaVersion !== 1 ||
    !Array.isArray(data.library?.albums) ||
    !Array.isArray(data.library?.tracks) ||
    !record(data.lyricsByTrack) ||
    !record(data.archivedLyrics) ||
    !record(data.settings) ||
    !Array.isArray(data.roots) ||
    !record(data.files) ||
    !record(data.covers) ||
    (data.excludedTrackIds !== undefined && (!record(data.excludedTrackIds) ||
      Object.values(data.excludedTrackIds).some(value => !Number.isSafeInteger(value) || value < 0))) ||
    (data.fileIdentities !== undefined && (!record(data.fileIdentities) ||
      Object.values(data.fileIdentities).some(value => !record(value) ||
        typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) ||
        !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.albumId !== 'string' || !value.albumId ||
        !Number.isSafeInteger(value.discNumber) || value.discNumber <= 0 ||
        !Number.isSafeInteger(value.trackNumber) || value.trackNumber <= 0)))
  )
    throw new LocalError("io", "资料库结构无法识别。");
  return data;
}

async function atomicText(filename: string, text: string | Uint8Array) {
  const temporary = path.join(
    path.dirname(filename),
    "." + path.basename(filename) + "." + randomUUID() + ".tmp",
  );
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function writeLocalBackup(
  directory: string,
  data: LocalData,
  now = Date.now(),
): Promise<BackupRecord> {
  const folder = path.join(directory, "backups");
  await mkdir(folder, { recursive: true });
  const payload = JSON.stringify(data);
  parseLocalData(payload);
  const createdAt = new Date(now).toISOString();
  const id = "library-" + now + "-" + randomUUID() + ".json";
  if (!backupName.test(id)) throw new LocalError("io", "备份时间无效。");
  await atomicText(
    path.join(folder, id),
    JSON.stringify({
      format: "cd-player-backup",
      version: 1,
      createdAt,
      sha256: checksum(payload),
      payload,
    }),
  );
  return {
    id,
    createdAt,
    libraryRevision: data.library.revision,
    tracks: data.library.tracks.length,
  };
}

async function readBackup(
  directory: string,
  id: string,
): Promise<{ record: BackupRecord; payload: string }> {
  if (!backupName.test(id))
    throw new LocalError("invalidAction", "备份编号无效。");
  const filename = path.join(directory, "backups", id);
  if (!(await lstat(filename)).isFile())
    throw new LocalError("io", "备份必须是普通文件。");
  const text = await readFile(filename, "utf8");
  try {
    const backup = JSON.parse(text);
    if (
      backup.format !== "cd-player-backup" ||
      backup.version !== 1 ||
      typeof backup.payload !== "string" ||
      checksum(backup.payload) !== backup.sha256 ||
      typeof backup.createdAt !== "string" ||
      !Number.isFinite(Date.parse(backup.createdAt))
    )
      throw Error("Invalid backup");
    const data = parseLocalData(backup.payload);
    return {
      payload: backup.payload,
      record: {
        id,
        createdAt: backup.createdAt,
        libraryRevision: data.library.revision,
        tracks: data.library.tracks.length,
      },
    };
  } catch {
    throw new LocalError("io", "备份损坏或校验不一致；未恢复资料库。");
  }
}

export async function listLocalBackups(
  directory: string,
): Promise<{ valid: BackupRecord[]; invalid: string[] }> {
  let entries;
  try {
    entries = await readdir(path.join(directory, "backups"), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { valid: [], invalid: [] };
    throw error;
  }
  const valid: BackupRecord[] = [],
    invalid: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !backupName.test(entry.name)) continue;
    try {
      valid.push((await readBackup(directory, entry.name)).record);
    } catch {
      invalid.push(entry.name);
    }
  }
  valid.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  return { valid, invalid };
}

/** Called only during startup with the single-writer lock held, never while a UI session is live. */
export async function restoreLocalBackup(
  directory: string,
  id: string,
): Promise<void> {
  const { payload } = await readBackup(directory, id); // Validate before touching the current file.
  const filename = path.join(directory, "library.json");
  let previous: Buffer | null = null;
  try {
    previous = await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous !== null) {
    const recovery = path.join(directory, "recovery");
    await mkdir(recovery, { recursive: true });
    // Preserve even broken JSON verbatim; recovery never silently deletes the damaged version.
    await atomicText(
      path.join(recovery, "library-before-restore-" + randomUUID() + ".json"),
      previous,
    );
  }
  await atomicText(filename, payload);
}

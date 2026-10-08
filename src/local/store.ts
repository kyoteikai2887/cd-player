import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalSettings } from "./defaults.ts";
import { LocalError, copy } from "./model.ts";
import type { LocalData, LocalView } from "./model.ts";
import {
  parseLocalData,
  restoreLocalBackup,
  writeLocalBackup,
} from "./backups.ts";
import type { BackupRecord } from "./backups.ts";

export interface LocalStore {
  read(): LocalData;
  view(): LocalView;
  transact(
    update: (draft: LocalData) => void,
    active?: () => boolean,
  ): Promise<LocalView>;
  backup(): Promise<BackupRecord>;
  close(): Promise<void>;
}
const empty = (): LocalData => ({
  schemaVersion: 1,
  library: { revision: 0, albums: [], tracks: [] },
  lyricsByTrack: {},
  archivedLyrics: {},
  settings: createLocalSettings(),
  roots: [],
  files: {},
  covers: {},
  excludedTrackIds: {},
});

/** One writer, serialized transactions; only publish after the atomic replacement succeeds. */
export async function openLocalStore(
  directory: string,
  options: {
    restoreBackupId?: string;
    now?: () => number;
    /** Desktop host holds an OS instance guard before enabling dead-owner recovery. */
    recoverDeadOwner?: boolean;
  } = {},
): Promise<LocalStore> {
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, "library.json"),
    lockname = path.join(directory, "writer.lock");
  let lock;
  try {
    lock = await open(lockname, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new LocalError("io", "无法创建资料库锁，请检查资料目录的访问权限。");
    if (!options.recoverDeadOwner)
      throw new LocalError("unavailable", "资料库已由另一进程使用，或上次异常退出留下锁文件；请先检查运行中的播放器。");
    // Native instance guard serializes recovery. Legacy writers still compete through wx:
    // if one claims the newly vacant path, this open fails without touching its live lock.
    let original: string;
    try {
      original = await readFile(lockname, "utf8");
      const owner = JSON.parse(original).pid;
      if (!Number.isInteger(owner) || owner <= 0 || owner > 0x7fffffff)
        throw new Error("Unknown lock owner");
      try {
        process.kill(owner, 0);
        throw new Error("Lock owner is alive");
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      }
      if ((await readFile(lockname, "utf8")) !== original)
        throw new Error("Lock changed during recovery");
      await rename(lockname, path.join(directory, `writer.lock.stale-${Date.now()}-${randomUUID()}`));
      lock = await open(lockname, "wx");
    } catch {
      throw new LocalError("unavailable", "资料库正在使用，或锁的状态无法确认。请从托盘恢复正在运行的播放器；不要删除收藏文件。");
    }
  }
  let state = empty(),
    closed = false,
    persisted = false,
    lastBackupAt: number | null = null,
    tail: Promise<unknown> = Promise.resolve();
  const now = options.now ?? Date.now;
  const ownerText = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const release = async () => {
    await lock.close();
    // Never remove a replacement lock that belongs to another writer.
    if (await readFile(lockname, "utf8").catch(() => null) === ownerText)
      await unlink(lockname);
  };
  try {
    await lock.writeFile(ownerText);
    await lock.sync();
    if (options.restoreBackupId !== undefined)
      await restoreLocalBackup(directory, options.restoreBackupId);
    try {
      state = parseLocalData(await readFile(filename, "utf8"));
      persisted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new LocalError(
          "io",
          "资料库无法读取；已保留原文件，请恢复备份，未自动清空资料。",
        );
    }
  } catch (error) {
    await release();
    throw error;
  }
  const view = (): LocalView =>
    copy({
      library: state.library,
      lyricsByTrack: state.lyricsByTrack,
      settings: state.settings,
    });
  return {
    read: () => copy(state),
    view,
    transact(update, active = () => true) {
      if (closed)
        return Promise.reject(new LocalError("unavailable", "资料库已关闭。"));
      const transaction = tail.then(async () => {
        if (!active()) throw new LocalError("unavailable", "写入已取消。");
        const draft = copy(state);
        update(draft);
        const temporary = path.join(
          directory,
          "library." + randomUUID() + ".tmp",
        );
        const handle = await open(temporary, "wx");
        try {
          await handle.writeFile(JSON.stringify(draft));
          await handle.sync();
        } catch (error) {
          await handle.close();
          await unlink(temporary).catch(() => {});
          throw error;
        }
        await handle.close();
        try {
          if (!active()) throw new LocalError("unavailable", "写入已取消。");
          const timestamp = now();
          const relocated = Object.entries(state.files).some(([id, file]) =>
            draft.files[id] && draft.files[id].path !== file.path);
          if (
            persisted &&
            (relocated || lastBackupAt === null ||
              timestamp < lastBackupAt ||
              timestamp - lastBackupAt >= 10 * 60 * 1000)
          ) {
            try {
              await writeLocalBackup(directory, state, timestamp);
            } catch {
              throw new LocalError("io", "自动备份未成功，本次改动尚未保存。");
            }
            lastBackupAt = timestamp;
          }
          if (!active()) throw new LocalError("unavailable", "写入已取消。");
          await rename(temporary, filename);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
        state = draft;
        persisted = true;
        return view();
      });
      tail = transaction.catch(() => {});
      return transaction;
    },
    backup() {
      if (closed)
        return Promise.reject(new LocalError("unavailable", "资料库已关闭。"));
      const operation = tail.then(async () => {
        const timestamp = now();
        const result = await writeLocalBackup(directory, state, timestamp);
        lastBackupAt = timestamp;
        return result;
      });
      tail = operation.catch(() => {});
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      await tail;
      await release();
    },
  };
}

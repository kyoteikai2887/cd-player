import path from "node:path";
import { fileURLToPath } from "node:url";
import { openLocalStore } from "../src/local/store.ts";
import { listLocalBackups } from "../src/local/backups.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0];
const value = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw Error(name + " 缺少值。");
  return args[index + 1];
};
const directory = path.resolve(root, value("--data") ?? ".local-data");
let store;
try {
  if (command === "list") {
    const { valid, invalid } = await listLocalBackups(directory);
    for (const backup of valid)
      console.log(
        backup.id + "  " + backup.createdAt + "  " + backup.tracks + " 首曲目",
      );
    for (const id of invalid) console.log(id + "  校验失败，保留原文件");
    if (!valid.length && !invalid.length) console.log("目前没有备份。");
  } else if (command === "create") {
    store = await openLocalStore(directory);
    console.log("备份已保存：" + (await store.backup()).id);
  } else if (command === "restore") {
    const id = value("--id");
    if (!id) throw Error("请用 --id 指定 list 显示的备份编号。");
    store = await openLocalStore(directory, { restoreBackupId: id });
    console.log(
      "资料库已恢复；恢复前文件已保留在 recovery/。请重新启动播放器。",
    );
  } else {
    throw Error(
      "用法：node scripts/backup.mjs list|create|restore [--data 资料目录] [--id 备份编号]",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "备份操作失败。");
  process.exitCode = 1;
} finally {
  await store?.close();
}

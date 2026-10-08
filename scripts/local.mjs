import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { openLocalStore } from '../src/local/store.ts';
import { startLocalServer } from '../src/local/server.ts';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';
import { prepareWindowsPicker } from './prepare-picker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argument = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const directory = path.resolve(root, argument('--data', '.local-data'));
if (process.platform === 'win32') await prepareWindowsPicker(path.join(root, '.native-runtime'));
const store = await openLocalStore(directory);
let vite, server;
try {
  const folder = argument('--import');
  if (folder) {
    const scan = await scanFolder(
      path.resolve(folder),
      path.join(directory, 'covers'),
      new AbortController().signal,
    );
    await store.transact((data) => mergeScan(data, scan, { restoreRemovedAtRevision: data.library.revision }));
    for (const warning of scan.warnings) console.warn(warning);
  }
  vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'spa',
  });
  server = await startLocalServer({
    store,
    dataDirectory: directory,
    port: Number(argument('--port', 4173)),
    middleware: (req, res) => vite.middlewares(req, res),
  });
  console.log('本地播放验证：' + server.origin + '/?local=1');
  console.log(
    '资料保存在本项目 .local-data（或指定 --data 目录）；不修改原音频。',
  );
} catch (error) {
  await vite?.close();
  await store.close();
  throw error;
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await vite.close();
  await store.close();
}
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});

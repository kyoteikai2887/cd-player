import { open, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalError } from './model.ts';
import type { LocalData } from './model.ts';

export function requireVideo(data: LocalData, albumId: string, id: string, revision?: number) {
  if (!data.library.albums.some(album => album.id === albumId))
    throw new LocalError('notFound', '专辑不存在。');
  const video = data.musicVideos && Object.hasOwn(data.musicVideos, id) ? data.musicVideos[id] : undefined;
  if (!video || video.albumId !== albumId) throw new LocalError('notFound', 'MV 关联不存在。');
  if (revision !== undefined && (!Number.isSafeInteger(revision) || video.revision !== revision))
    throw new LocalError('conflict', 'MV 关联已变化，请刷新后再操作。');
  return video;
}

export function videoTitle(value: string) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new LocalError('invalidAction', 'MV 名称须为 1 至 200 个字符，不能包含控制字符。');
  return value.trim();
}

async function regularFile(filename: string, extension: string, message: string) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== extension)
    throw new LocalError('invalidAction', message);
  try {
    const resolved = await realpath(filename);
    if (path.extname(resolved).toLowerCase() !== extension || !(await stat(resolved)).isFile())
      throw new Error('Not a regular file');
    return resolved;
  } catch { throw new LocalError('fileMissing', message); }
}

/** A small header read, never a movie copy, full-file hash, or transcode. */
export async function validateMkv(filename: string) {
  const resolved = await regularFile(filename, '.mkv', '找不到 MKV 文件，请重新关联文件位置。');
  const file = await open(resolved, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header, 0, 4, 0);
    if (bytesRead !== 4 || header.readUInt32BE() !== 0x1a45dfa3)
      throw new LocalError('invalidAction', '文件不是可识别的 MKV 容器，请检查导出结果。');
  } finally { await file.close(); }
  return resolved;
}

const playerNames = new Set(['potplayermini64.exe', 'potplayermini.exe', 'potplayer64.exe', 'potplayer.exe']);
export async function validatePotPlayer(filename: string) {
  let resolved: string;
  try { resolved = await regularFile(filename, '.exe', '找不到 PotPlayer，请重新选择播放器程序。'); }
  catch (error) {
    // Keep missing video -> relink distinct from missing player -> player settings.
    if (error instanceof LocalError && error.code === 'fileMissing')
      throw new LocalError('notFound', error.message);
    throw error;
  }
  if (!playerNames.has(path.basename(resolved).toLowerCase()))
    throw new LocalError('invalidAction', '请选择 PotPlayer 的播放器程序，例如 PotPlayerMini64.exe。');
  const file = await open(resolved, 'r');
  try {
    const header = Buffer.alloc(2);
    await file.read(header, 0, 2, 0);
    if (header.toString('ascii') !== 'MZ') throw new LocalError('invalidAction', '所选文件不是 Windows 播放器程序。');
  } finally { await file.close(); }
  return resolved;
}

export async function detectPotPlayer() {
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter((p): p is string => !!p);
  for (const base of bases) for (const folder of ['DAUM/PotPlayer', 'PotPlayer'])
    for (const name of ['PotPlayerMini64.exe', 'PotPlayerMini.exe', 'PotPlayer64.exe', 'PotPlayer.exe']) {
      try { return await validatePotPlayer(path.join(base, folder, name)); } catch { /* Try the next known install location. */ }
    }
  throw new LocalError('notFound', '没有在常见安装位置找到 PotPlayer，请手动选择播放器程序。');
}

/** No shell, file association mutation, arbitrary command line, or video streaming endpoint. */
export function launchPotPlayer(executable: string, filename: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [filename, '/current', '/autoplay'], {
      shell: false, windowsHide: false, stdio: 'ignore', detached: true,
    });
    child.once('error', () => reject(new LocalError('io', 'PotPlayer 未能启动，请检查播放器设置。')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function linkVideo(data: LocalData, albumId: string, filename: string,
  previous?: { id: string; revision: number }) {
  if (!data.library.albums.some(album => album.id === albumId))
    throw new LocalError('notFound', '选择文件期间专辑已移除。');
  const old = previous ? requireVideo(data, albumId, previous.id, previous.revision) : undefined;
  const key = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
  if (Object.entries(data.musicVideos ?? {}).some(([id, video]) =>
    id !== previous?.id && video.albumId === albumId && key(video.path) === key(filename)))
    throw new LocalError('invalidAction', '此 MKV 已关联到这张专辑。');
  const id = previous?.id ?? randomUUID();
  data.musicVideos ??= {};
  data.musicVideos[id] = { albumId, path: filename, revision: old ? old.revision + 1 : 0,
    title: old?.title ?? videoTitle([...path.basename(filename, path.extname(filename))].slice(0, 200).join('')) };
  data.library.revision++;
}

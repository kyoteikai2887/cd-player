import {
  readdir,
  realpath,
  stat,
  readFile,
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseFile, selectCover } from "music-metadata";
import type { Album, Track, LyricsDocument } from "../contracts/player.ts";
import {
  parseLyrics,
  attachTranslation,
  translationStatus,
} from "../core/lyrics.ts";
import { LocalError } from "./model.ts";
import type { LocalData } from "./model.ts";
import { summarizeRip } from "./rip.ts";
import { acceptIdentityObservations, hashMusicFile, relinkScan } from './identity.ts';
import type { IdentityObservation } from './identity.ts';

export interface ScanResult {
  root: string;
  albums: Album[];
  tracks: Track[];
  lyrics: Record<string, LyricsDocument>;
  files: LocalData["files"];
  covers: LocalData["covers"];
  warnings: string[];
  identities?: NonNullable<LocalData['fileIdentities']>;
}
const key = (prefix: string, value: string) =>
  prefix + "-" + createHash("sha256").update(value).digest("hex").slice(0, 24);
const audioExtensions = new Set([".flac", ".mp3", ".wav"]);
export const inside = (filename: string, root: string) => {
  const relative = path.relative(root, filename);
  return (
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};
const positive = (value: number | null | undefined, fallback: number) =>
  Number.isInteger(value) && value! > 0 ? value! : fallback;
const language = (value?: string) =>
  value && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(value) ? value : null;
export function imageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  )
    return "image/png";
  if (
    Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}
export async function cacheCover(bytes: Uint8Array, cacheDirectory: string) {
  const mime = imageMime(bytes);
  if (!mime || bytes.length > 10 * 1024 * 1024)
    throw new LocalError(
      "invalidAction",
      "封面须为10MB以内的 JPEG、PNG 或 WebP。",
    );
  await mkdir(cacheDirectory, { recursive: true });
  const filename = path.join(
    cacheDirectory,
    createHash("sha256").update(bytes).digest("hex") + ".image",
  );
  await writeFile(filename, bytes, { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return { path: filename, mime };
}

/** Read-only scan. Symlinks/junctions are skipped; nothing is written to a music folder. */
export async function scanFolder(
  folder: string,
  cacheDirectory: string,
  signal: AbortSignal,
): Promise<ScanResult> {
  const root = await realpath(folder);
  if (!(await stat(root)).isDirectory())
    throw new LocalError("invalidAction", "请选择音乐文件夹。");
  const allFiles: string[] = [],
    warnings: string[] = [];
  const check = () => {
    if (signal.aborted) throw new LocalError("unavailable", "扫描已取消。");
  };
  async function walk(directory: string) {
    check();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new LocalError("io", "部分目录无法读取，扫描未提交；请检查权限。");
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      check();
      if (entry.isSymbolicLink()) {
        warnings.push("已跳过链接：" + entry.name);
        continue;
      }
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) allFiles.push(filename);
      if (allFiles.length > 20000)
        throw new LocalError(
          "unsupported",
          "单次扫描文件过多，请选择较小的音乐目录。",
        );
    }
  }
  await walk(root);
  const result: ScanResult = {
    root,
    albums: [],
    tracks: [],
    lyrics: {},
    files: {},
    covers: {},
    warnings,
    identities: {},
  };
  const albums = new Map<string, Album>();
  const albumDirectories = new Map<string, string>();
  for (const filename of allFiles.filter((file) =>
    audioExtensions.has(path.extname(file).toLowerCase()),
  )) {
    check();
    try {
      if ((await realpath(filename)) !== filename) {
        warnings.push("文件路径发生变化，已跳过。");
        continue;
      }
      const info = await stat(filename);
      const metadata = await parseFile(filename, { duration: true });
      const sha256 = await hashMusicFile(filename, info, signal);
      check();
      const tags = metadata.common,
        durationMs = Math.round((metadata.format.duration ?? 0) * 1000);
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
        throw new Error("No valid duration");
      const directory = path.dirname(filename);
      const discMatch = path
        .basename(directory)
        .match(/^(?:disc|disk|cd)[ _-]*(\d+)$/i);
      const albumDirectory = discMatch ? path.dirname(directory) : directory;
      const title = tags.album?.trim() || path.basename(albumDirectory);
      const albumId = key("album", albumDirectory + "\0" + title),
        id = key("track", filename);
      let album = albums.get(albumId);
      if (!album) {
        const artists = tags.albumartists?.length
          ? [...tags.albumartists]
          : tags.albumartist
            ? [tags.albumartist]
            : [];
        album = {
          id: albumId,
          title,
          revision: 0,
          albumArtists: artists,
          albumArtistCredit:
            tags.albumartist || artists.join(" / ") || "未知歌手",
          workTitle: null,
          releaseYear: tags.year ?? null,
          catalogNumber: tags.catalognumber?.[0] ?? null,
          label: tags.label?.[0] ?? null,
          language: language(tags.language),
          titleSort: tags.albumsort ?? null,
          discs: [],
          trackIds: [],
          cover: null,
          addedAt: Date.now(),
          metadataStatus: "unmatched",
          userEditedFields: [],
          rip: {
            hasLog: false,
            hasCue: false,
            accurateRip: "unknown",
          },
        };
        albums.set(albumId, album);
        albumDirectories.set(albumId, albumDirectory);
        const external = allFiles.find(
          (file) =>
            path.dirname(file) === albumDirectory &&
            /^(cover|folder|front)\.(jpg|jpeg|png|webp)$/i.test(
              path.basename(file),
            ),
        );
        const embedded = selectCover(tags.picture);
        try {
          const bytes =
            external && (await stat(external)).size <= 10 * 1024 * 1024
              ? await readFile(external)
              : embedded?.data;
          if (bytes) {
            result.covers[albumId] = await cacheCover(bytes, cacheDirectory);
            album.cover = {
              thumbUrl: "/api/cover/" + albumId,
              fullUrl: "/api/cover/" + albumId,
            };
          }
        } catch {
          warnings.push("封面无法读取或格式不支持：" + title);
        }
      }
      const discNumber = positive(
        tags.disk.no,
        discMatch ? Number(discMatch[1]) : 1,
      );
      const track: Track = {
        id,
        albumId,
        revision: 0,
        title:
          tags.title?.trim() || path.basename(filename, path.extname(filename)),
        artists: tags.artists?.length
          ? [...tags.artists]
          : tags.artist
            ? [tags.artist]
            : [],
        artistCredit: tags.artist || tags.artists?.join(" / ") || "未知歌手",
        discNumber,
        trackNumber: positive(
          tags.track.no,
          Number(path.basename(filename).match(/^\d+/)?.[0]) ||
            album.trackIds.length + 1,
        ),
        durationMs,
        available: true,
        userEditedFields: [],
        language: language(tags.language),
        versionKind: null,
        versionLabel: null,
      };
      if (!album.discs.some((d) => d.number === discNumber))
        album.discs.push({ number: discNumber });
      album.trackIds.push(id);
      result.tracks.push(track);
      result.files[id] = {
        path: filename,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
      result.identities![id] = { sha256, size: info.size, albumId, discNumber, trackNumber: track.trackNumber };
      result.lyrics[id] = parseLyrics("", id);
      const stem = filename.slice(0, -path.extname(filename).length);
      const bilingual = allFiles.includes(stem + ".bilingual.lrc");
      const sidecar = bilingual ? stem + ".bilingual.lrc" : stem + ".lrc";
      let document = parseLyrics("", id);
      if (
        allFiles.includes(sidecar) &&
        (await stat(sidecar)).size <= 2 * 1024 * 1024
      ) {
        document = parseLyrics(await readFile(sidecar, "utf8"), id, {
          source: { kind: "sidecar" },
          duplicateTimestampMode: bilingual ? "bilingual" : "merge",
        });
      }
      const translationFile = [
        stem + ".zh.lrc",
        stem + ".translation.lrc",
      ].find((file) => allFiles.includes(file));
      if (
        translationFile &&
        (await stat(translationFile)).size <= 2 * 1024 * 1024 &&
        document.kind !== "missing"
      ) {
        const translated = parseLyrics(
          await readFile(translationFile, "utf8"),
          id,
        );
        const pairing = attachTranslation(document.lines, translated.lines);
        document.lines = pairing.lines;
        document.warnings.push(...pairing.warnings);
        document.translationLanguage = translated.language;
        document.source.translation = { kind: "sidecar" };
        document.translationStatus = translationStatus(document.lines);
      }
      document.locked = document.kind !== "missing";
      result.lyrics[id] = document;
    } catch (error) {
      check();
      warnings.push("音频未能导入：" + path.basename(filename));
    }
  }
  result.albums = [...albums.values()].map((album) => ({
    ...album,
    discs: album.discs.sort((a, b) => a.number - b.number),
    trackIds: album.trackIds.sort((a, b) => {
      const left = result.tracks.find((t) => t.id === a)!,
        right = result.tracks.find((t) => t.id === b)!;
      return (
        left.discNumber - right.discNumber ||
        left.trackNumber - right.trackNumber ||
        left.title.localeCompare(right.title)
      );
    }),
  }));
  for (const album of result.albums) {
    check();
    album.rip = await summarizeRip(
      albumDirectories.get(album.id)!,
      result.tracks.filter((track) => track.albumId === album.id),
      result.files,
      allFiles,
      warnings,
      signal,
    );
  }
  check();
  return result;
}

/** Merge against the latest transaction, preserving every user-protected field and saved lyric. */
export function mergeScan(data: LocalData, input: ScanResult, options: {
  restoreRemovedAtRevision?: number; observations?: IdentityObservation[];
} = {}) {
  // A scan started before removal cannot restore its files when it eventually commits.
  const scan = structuredClone(input);
  acceptIdentityObservations(data, options.observations ?? []);
  const relocated = relinkScan(data, scan);
  if (scan.albums.some(album => !data.library.albums.some(old => old.id === album.id)) &&
    data.library.tracks.some(track => !data.fileIdentities?.[track.id] && !scan.tracks.some(incoming => incoming.id === track.id)))
    scan.warnings.push('部分旧曲目没有文件指纹，无法确认新旧位置是否为同一份音乐；旧记录已保留，请先恢复原目录并重新扫描。');
  const excluded = data.excludedTrackIds ?? {};
  const restoreAt = options.restoreRemovedAtRevision;
  if (restoreAt !== undefined && (!Number.isSafeInteger(restoreAt) || restoreAt < 0))
    throw new LocalError('invalidAction', '导入基线无效。');
  scan.tracks = scan.tracks.filter(track => {
    const identity = scan.identities?.[track.id];
    if (identity && !data.library.tracks.some(old => old.id === track.id) && Object.entries(excluded).some(([id, revision]) =>
      data.fileIdentities?.[id]?.sha256 === identity.sha256 && data.fileIdentities[id].size === identity.size &&
      (restoreAt === undefined || revision > restoreAt))) return false;
    if (!Object.hasOwn(excluded, track.id)) return true;
    if (restoreAt !== undefined && excluded[track.id] <= restoreAt) {
      delete excluded[track.id];
      return true;
    }
    return false;
  });
  const admitted = new Set(scan.tracks.map(track => track.id));
  scan.albums = scan.albums.map(album => ({ ...album, trackIds: album.trackIds.filter(id => admitted.has(id)) }))
    .filter(album => album.trackIds.length > 0);
  data.excludedTrackIds = excluded;
  const found = new Set(scan.tracks.map((track) => track.id));
  for (const track of data.library.tracks)
    if (
      data.files[track.id] &&
      inside(data.files[track.id].path, scan.root) &&
      !found.has(track.id)
    ) {
      if (track.available) {
        track.available = false;
        track.revision++;
      }
    }
  for (const incoming of scan.tracks) {
    const index = data.library.tracks.findIndex((t) => t.id === incoming.id),
      old = data.library.tracks[index];
    if (old) {
      for (const field of old.userEditedFields)
        Object.assign(incoming, { [field]: old[field] });
      incoming.userEditedFields = old.userEditedFields;
      incoming.revision = old.revision;
      if (
        JSON.stringify({ ...incoming, lyricsSummary: old.lyricsSummary }) !==
        JSON.stringify(old)
      )
        incoming.revision++;
      incoming.lyricsSummary = old.lyricsSummary;
      data.library.tracks[index] = incoming;
    } else data.library.tracks.push(incoming);
    data.files[incoming.id] = scan.files[incoming.id];
    if (scan.identities?.[incoming.id]) data.fileIdentities![incoming.id] = scan.identities[incoming.id];
    if (
      !data.lyricsByTrack[incoming.id] ||
      (data.lyricsByTrack[incoming.id].kind === "missing" &&
        data.lyricsByTrack[incoming.id].revision === 0)
    )
      data.lyricsByTrack[incoming.id] = scan.lyrics[incoming.id];
    const doc = data.lyricsByTrack[incoming.id];
    incoming.lyricsSummary = {
      kind: doc.kind,
      translation: doc.translationStatus,
      revision: doc.revision,
    };
  }
  for (const incoming of scan.albums) {
    const index = data.library.albums.findIndex((a) => a.id === incoming.id),
      old = data.library.albums[index];
    if (old) {
      for (const field of old.userEditedFields)
        Object.assign(incoming, { [field]: old[field] });
      incoming.trackIds = [...new Set([...incoming.trackIds, ...old.trackIds])];
      incoming.addedAt = old.addedAt;
      incoming.userEditedFields = old.userEditedFields;
      incoming.revision = old.revision;
      if (JSON.stringify(incoming) !== JSON.stringify(old)) incoming.revision++;
      data.library.albums[index] = incoming;
    } else data.library.albums.push(incoming);
    if (!old?.userEditedFields.includes("cover") && scan.covers[incoming.id])
      data.covers[incoming.id] = scan.covers[incoming.id];
    incoming.trackIds.sort((a, b) => {
      const left = data.library.tracks.find((t) => t.id === a)!,
        right = data.library.tracks.find((t) => t.id === b)!;
      return (
        left.discNumber - right.discNumber ||
        left.trackNumber - right.trackNumber
      );
    });
  }
  if (!data.roots.includes(scan.root)) data.roots.push(scan.root);
  if (relocated) data.roots = data.roots.filter(root => root === scan.root ||
    Object.values(data.files).some(file => inside(file.path, root)));
  data.library.revision++;
  return { relocated, warnings: scan.warnings };
}

/** A vanished root is retained for recovery, while healthy roots can still be scanned. */
export function markRootUnavailable(data: LocalData, root: string) {
  let changed = false;
  for (const track of data.library.tracks) if (track.available && data.files[track.id] && inside(data.files[track.id].path, root)) {
    track.available = false;
    track.revision++;
    changed = true;
  }
  if (changed) data.library.revision++;
}

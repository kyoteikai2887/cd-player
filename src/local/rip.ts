import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RipSummary, Track } from "../contracts/player.ts";

export interface DiscToc {
  /** CD sectors, before the standard 150-sector lead-in. */
  starts: number[];
  leadOut: number;
}
export interface EacLog {
  toc: DiscToc;
  tracks: { number: number; filename: string; durationMs: number }[];
}

/** BOM UTF-16 and strict UTF-8 only. Never silently replace undecodable filenames. */
export function decodeRipText(bytes: Uint8Array): string | null {
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
const frames = (clock: string) => {
  const parts = /^(\d+):(\d{2})\.(\d{2})$/.exec(clock);
  if (!parts || +parts[2] >= 60 || +parts[3] >= 75) return null;
  const value = +parts[1] * 4500 + +parts[2] * 75 + +parts[3];
  return Number.isSafeInteger(value) ? value : null;
};

/** English per-track EAC logs only. Plugins, image rips and incomplete logs cannot supply a TOC. */
export function parseEacLog(text: string): EacLog | null {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (
    (normalized.match(/^Exact Audio Copy V[^\n]+$/gm)?.length ?? 0) !== 1 ||
    !/^EAC extraction logfile from /m.test(normalized)
  )
    return null;
  const end = normalized.indexOf("\nEnd of status report");
  if (end < 0) return null;
  const body = normalized.slice(0, end);
  const table = body.split("TOC of the extracted CD");
  if (table.length !== 2) return null;
  const blocks = [...table[1].matchAll(/^\s*Track\s+(\d+)\s*$/gm)];
  if (!blocks.length) return null;
  const rows = table[1]
    .slice(0, blocks[0].index)
    .split("\n")
    .filter((line) => line.includes("|") && /^\s*\d/.test(line));
  if (!rows.length || rows.length > 99 || blocks.length !== rows.length)
    return null;
  const starts: number[] = [],
    lengths: number[] = [];
  let leadOut = 0;
  for (const [i, row] of rows.entries()) {
    const match =
      /^\s*(\d+)\s*\|\s*(\d+:\d{2}\.\d{2})\s*\|\s*(\d+:\d{2}\.\d{2})\s*\|\s*(\d+)\s*\|\s*(\d+)\s*$/.exec(
        row,
      );
    if (!match || +match[1] !== i + 1) return null;
    const start = +match[4],
      last = +match[5],
      length = frames(match[3]);
    if (
      !Number.isSafeInteger(last) ||
      last >= 0xffffffff - 150 ||
      length === null ||
      length <= 0 ||
      frames(match[2]) !== start ||
      last + 1 - start !== length ||
      (i > 0 && start !== leadOut)
    )
      return null;
    starts.push(start);
    lengths.push(length);
    leadOut = last + 1;
  }
  const tracks: EacLog["tracks"] = [];
  for (const [i, block] of blocks.entries()) {
    if (+block[1] !== i + 1) return null;
    const content = table[1].slice(
      block.index! + block[0].length,
      blocks[i + 1]?.index,
    );
    const names = [...content.matchAll(/^\s*Filename\s+(.+?)\s*$/gm)];
    if (names.length !== 1 || !/\.(wav|flac|mp3)$/i.test(names[0][1]))
      return null;
    tracks.push({
      number: i + 1,
      filename: names[0][1],
      durationMs: (lengths[i] * 1000) / 75,
    });
  }
  return { toc: { starts, leadOut }, tracks };
}

/** MusicBrainz's documented audio TOC algorithm; not a freedb or AccurateRip ID. */
export function musicBrainzDiscId(toc: DiscToc): string | null {
  if (
    !toc.starts.length ||
    toc.starts.length > 99 ||
    !Number.isInteger(toc.leadOut) ||
    toc.leadOut >= 0xffffffff - 150 ||
    toc.starts.some(
      (value, i) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value >= toc.leadOut ||
        (i > 0 && value <= toc.starts[i - 1]),
    )
  )
    return null;
  const hex = (value: number, digits: number) =>
    value.toString(16).toUpperCase().padStart(digits, "0");
  const input =
    "01" +
    hex(toc.starts.length, 2) +
    hex(toc.leadOut + 150, 8) +
    Array.from({ length: 99 }, (_, i) =>
      hex(i < toc.starts.length ? toc.starts[i] + 150 : 0, 8),
    ).join("");
  return createHash("sha1")
    .update(input, "ascii")
    .digest("base64")
    .replaceAll("+", ".")
    .replaceAll("/", "_")
    .replaceAll("=", "-");
}
const stem = (filename: string) =>
  path.posix
    .basename(filename.replaceAll("\\", "/"))
    .replace(/\.(wav|flac|mp3)$/i, "")
    .normalize("NFC")
    .toLowerCase();

/** Exact names (allow WAV -> FLAC), track numbers and CD-frame durations; no title-only guessing. */
export function logMatchesDisc(
  log: EacLog,
  tracks: Track[],
  files: Record<string, { path: string }>,
): boolean {
  return (
    log.tracks.length === tracks.length &&
    log.tracks.every((record) => {
      const matches = tracks.filter(
        (track) =>
          track.trackNumber === record.number &&
          files[track.id] &&
          stem(files[track.id].path) === stem(record.filename) &&
          Math.abs(track.durationMs - record.durationMs) <= 50,
      );
      return matches.length === 1;
    })
  );
}

/** Read-only sidecar association. Log-reported success does not verify the current audio bytes. */
export async function summarizeRip(
  albumDirectory: string,
  tracks: Track[],
  files: Record<string, { path: string }>,
  allFiles: string[],
  warnings: string[],
  signal: AbortSignal,
): Promise<RipSummary> {
  const groups = [...new Set(tracks.map((track) => track.discNumber))]
    .sort((a, b) => a - b)
    .map((number) => {
      const items = tracks.filter((track) => track.discNumber === number);
      return {
        number,
        tracks: items,
        directories: new Set(
          items.map((track) => path.dirname(files[track.id].path)),
        ),
        hasLog: false,
        hasCue: false,
        ids: new Set<string>(),
      };
    });
  const candidates = allFiles.filter(
    (filename) =>
      /\.(log|cue)$/i.test(filename) &&
      (path.dirname(filename) === albumDirectory ||
        groups.some((group) => group.directories.has(path.dirname(filename)))),
  );
  for (const filename of candidates) {
    signal.throwIfAborted();
    const isLog = /\.log$/i.test(filename),
      directory = path.dirname(filename);
    const local = groups.filter((group) => group.directories.has(directory));
    // A parent sidecar with several discs is present at album level, but needs content to name a disc.
    const scope = directory === albumDirectory ? groups : local;
    if (scope.length === 1) {
      if (isLog) scope[0].hasLog = true;
      else scope[0].hasCue = true;
    }
    let text: string | null = null;
    try {
      if ((await realpath(filename)) !== filename) continue;
      if ((await stat(filename)).size > 2 * 1024 * 1024) {
        warnings.push("抓轨附件超过 2MB，未解析：" + path.basename(filename));
        continue;
      }
      text = decodeRipText(await readFile(filename, { signal }));
    } catch {
      signal.throwIfAborted();
      warnings.push(
        "抓轨附件无法读取，已保留存在标记：" + path.basename(filename),
      );
      continue;
    }
    if (text === null) {
      warnings.push("抓轨附件编码不支持，未解析：" + path.basename(filename));
      continue;
    }
    if (isLog) {
      // Ordinary non-EAC logs retain the presence flag without producing spurious warnings.
      if (!/^\uFEFF?Exact Audio Copy V/m.test(text)) continue;
      const parsed = parseEacLog(text);
      if (!parsed) {
        warnings.push(
          "EAC 日志不完整或格式不支持，未提取碟片编号：" +
            path.basename(filename),
        );
        continue;
      }
      const matched = scope.filter((group) =>
        logMatchesDisc(parsed, group.tracks, files),
      );
      if (matched.length !== 1) {
        warnings.push(
          "EAC 日志无法唯一对应当前碟片，未提取编号：" +
            path.basename(filename),
        );
        continue;
      }
      matched[0].hasLog = true;
      const id = musicBrainzDiscId(parsed.toc);
      if (id) matched[0].ids.add(id);
    } else if (scope.length > 1) {
      const names = [
        ...text.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+\S+\s*$/gim),
      ].map((match) => match[1] ?? match[2]);
      const matched = scope.filter(
        (group) =>
          names.length === group.tracks.length &&
          names.every(
            (name) =>
              group.tracks.filter(
                (track) =>
                  stem(files[track.id].path) === stem(name) &&
                  path.dirname(files[track.id].path) ===
                    path.dirname(
                      path.resolve(directory, name.replaceAll("\\", path.sep)),
                    ),
              ).length === 1,
          ) &&
          new Set(names.map(stem)).size === names.length,
      );
      if (matched.length === 1) matched[0].hasCue = true;
    }
  }
  return {
    hasLog: candidates.some((filename) => /\.log$/i.test(filename)),
    hasCue: candidates.some((filename) => /\.cue$/i.test(filename)),
    accurateRip: "unknown",
    discs: groups.map((group) => {
      if (group.ids.size > 1)
        warnings.push(`第 ${group.number} 碟 EAC 日志编号冲突，未采用。`);
      return {
        number: group.number,
        hasLog: group.hasLog,
        hasCue: group.hasCue,
        ...(group.ids.size === 1 ? { discId: [...group.ids][0] } : {}),
      };
    }),
  };
}

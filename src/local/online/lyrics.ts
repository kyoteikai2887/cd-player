import type { LyricsDocument } from "../../contracts/player.ts";
import { validateLyricsEdit, translationStatus } from "../../core/lyrics.ts";
import type { LocalData } from "../model.ts";
import { LocalError, copy } from "../model.ts";

export function fillOnlineLyrics(
  data: LocalData,
  baseline: {
    trackId: string;
    trackRevision: number;
    albumRevision: number;
    lyricsRevision: number;
  },
  candidate: LyricsDocument | null,
) {
  const track = data.library.tracks.find((t) => t.id === baseline.trackId),
    latest = data.lyricsByTrack[baseline.trackId];
  const album =
    track && data.library.albums.find((a) => a.id === track.albumId);
  if (!track || !latest || !album)
    throw new LocalError("notFound", "查找期间曲目已移除。");
  if (
    latest.locked ||
    latest.revision !== baseline.lyricsRevision ||
    track.revision !== baseline.trackRevision ||
    album.revision !== baseline.albumRevision
  )
    throw new LocalError(
      "conflict",
      "查找期间歌词或资料已修改，在线结果未应用。",
    );
  if (!candidate || latest.kind !== "missing") return false;
  if (
    candidate.trackId !== track.id ||
    !["plain", "synced"].includes(candidate.kind) ||
    validateLyricsEdit({
      ...candidate,
      kind: candidate.kind as "plain" | "synced",
    }).length
  )
    throw new LocalError("unavailable", "在线歌词格式无效，未采用。");
  const document: LyricsDocument = {
    ...copy(candidate),
    trackId: track.id,
    revision: latest.revision + 1,
    offsetMs: latest.offsetMs,
    locked: false,
    lookup: "idle",
    lookupError: null,
    translationStatus: translationStatus(candidate.lines),
  };
  document.language ??= latest.language;
  data.lyricsByTrack[track.id] = document;
  track.lyricsSummary = {
    kind: document.kind,
    translation: document.translationStatus,
    revision: document.revision,
  };
  data.library.revision++;
  return true;
}

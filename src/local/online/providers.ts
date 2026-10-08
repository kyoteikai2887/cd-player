import path from "node:path";
import type {
  Album,
  Track,
  LyricsDocument,
  MetadataCandidate,
} from "../../contracts/player.ts";
import { parseLyrics, validateLyricsEdit } from "../../core/lyrics.ts";
import { LocalError } from "../model.ts";
import { createOnlineHttp, cancelled } from "./http.ts";
import type { LyricSearchRecord } from './candidates.ts';
import { searchLyricsSources, usableSearch } from './search.ts';
import type { LyricSource, LyricsSearchResult } from './search.ts';

export interface Credit {
  name: string;
  joinphrase?: string;
  artist?: { name?: string };
}
export interface ReleaseTrack {
  position: number;
  title?: string;
  length?: number;
  "artist-credit"?: Credit[];
  recording?: {
    id?: string;
    title?: string;
    length?: number;
    "artist-credit"?: Credit[];
  };
}
export interface ReleaseMedium {
  position: number;
  title?: string;
  format?: string;
  "track-count"?: number;
  discs?: { id: string }[];
  tracks?: ReleaseTrack[];
}
export interface Release {
  id: string;
  title: string;
  date?: string;
  country?: string;
  status?: string;
  disambiguation?: string;
  "artist-credit"?: Credit[];
  "label-info"?: { "catalog-number"?: string; label?: { name?: string } }[];
  "text-representation"?: { language?: string };
  media?: ReleaseMedium[];
}
export interface ReleaseResult {
  release: Release;
  match: MetadataCandidate["match"];
  cover?: Uint8Array;
  notes: string[];
}
export interface OnlineServices {
  searchLyrics?(track: Track, album: Album, signal: AbortSignal, query?: { title: string; artist: string }): Promise<LyricSearchRecord[]>;
  /** Backend diagnostic summary; the UI still uses the frozen candidate contract. */
  searchLyricsSources?(track: Track, album: Album, signal: AbortSignal, query?: { title: string; artist: string }): Promise<LyricsSearchResult>;
  metadata(
    album: Album,
    tracks: Track[],
    signal: AbortSignal,
  ): Promise<ReleaseResult[]>;
  lyrics(
    track: Track,
    album: Album,
    signal: AbortSignal,
  ): Promise<LyricsDocument | null>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2000;
export const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
export function credit(
  value: Credit[] | undefined,
): { names: string[]; display: string } | null {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 30 ||
    value.some(
      (c) =>
        !c ||
        !text(c.name) ||
        (c.joinphrase !== undefined && typeof c.joinphrase !== "string"),
    )
  )
    return null;
  return {
    names: [...new Set(value.map((c) => c.name))],
    display: value.map((c) => c.name + (c.joinphrase ?? "")).join(""),
  };
}
function release(value: unknown): Release {
  if (!value || typeof value !== "object")
    throw new LocalError("unavailable", "MusicBrainz 结果格式无效。");
  const r = value as Release;
  if (
    !text(r.id) ||
    !uuid.test(r.id) ||
    !text(r.title) ||
    !Array.isArray(r.media) ||
    !r.media.length ||
    r.media.length > 50
  )
    throw new LocalError("unavailable", "MusicBrainz 结果缺少发行版本或曲目。");
  if (
    r.media.some(
      (m) =>
        !m ||
        !Number.isInteger(m.position) ||
        m.position < 1 ||
        !Array.isArray(m.tracks) ||
        m.tracks.length > 500 ||
        (m.discs !== undefined &&
          (!Array.isArray(m.discs) ||
            m.discs.some((d) => !d || !text(d.id)))) ||
        m.tracks.some(
          (t) =>
            !t ||
            !Number.isInteger(t.position) ||
            t.position < 1 ||
            (t.length != null &&
              (typeof t.length !== "number" ||
                !Number.isFinite(t.length) ||
                t.length < 0)) ||
            (!text(t.title) && !text(t.recording?.title)),
        ),
    )
  )
    throw new LocalError("unavailable", "MusicBrainz 曲目格式无效。");
  if (
    r["label-info"] !== undefined &&
    (!Array.isArray(r["label-info"]) ||
      r["label-info"].some((l) => !l || typeof l !== "object"))
  )
    throw new LocalError("unavailable", "MusicBrainz 发行资料格式无效。");
  return r;
}
const quoted = (value: string) => '"' + value.replace(/[\\"]/g, "\\$&") + '"';

export function createOnlineServices(
  options: Parameters<typeof createOnlineHttp>[0] & { lyricSources?: readonly LyricSource[]; lyricSourceTimeoutMs?: number } = {},
): OnlineServices {
  const http = createOnlineHttp({
    ...options,
    directory: options.directory && path.join(options.directory, "responses"),
  });
  const mb = (
    route: string,
    params: Record<string, string>,
    signal: AbortSignal,
  ) =>
    http.json(
      "https://musicbrainz.org/ws/2/" +
        route +
        "?" +
        new URLSearchParams({ ...params, fmt: "json" }),
      "musicbrainz",
      signal,
      (value) => {
        if (value === null) return;
        if (
          route.startsWith("release/") &&
          uuid.test(route.slice("release/".length))
        ) {
          release(value);
          return;
        }
        const list = (value as { releases?: unknown[] })?.releases;
        if (
          !Array.isArray(list) ||
          list.some(
            (r) => !r || typeof r !== "object" || !uuid.test((r as Release).id),
          )
        )
          throw new LocalError("unavailable", "MusicBrainz 候选列表格式无效。");
      },
    );
  return {
    async metadata(album, tracks, signal) {
      const ids = new Map<string, MetadataCandidate["match"]>();
      for (const disc of (album.rip?.discs ?? []).slice(0, 5)) {
        if (!disc.discId || !/^[A-Za-z0-9._-]{28}$/.test(disc.discId)) continue;
        const result = (await mb(
          "discid/" + encodeURIComponent(disc.discId),
          { inc: "artist-credits", cdstubs: "no" },
          signal,
        )) as { releases?: Release[] } | null;
        if (result?.releases && Array.isArray(result.releases))
          for (const r of result.releases)
            if (uuid.test(r.id)) ids.set(r.id, "discId");
      }
      if (!ids.size) {
        const query = album.catalogNumber
          ? "catno:" + quoted(album.catalogNumber)
          : "release:" +
            quoted(album.title) +
            (album.albumArtists.length
              ? " AND artist:" + quoted(album.albumArtists[0])
              : "");
        const result = (await mb(
          "release/",
          { query, limit: "5" },
          signal,
        )) as { releases?: Release[] } | null;
        if (result?.releases && Array.isArray(result.releases))
          for (const r of result.releases)
            if (uuid.test(r.id))
              ids.set(r.id, album.catalogNumber ? "catalog" : "text");
      }
      const output: ReleaseResult[] = [];
      for (const [id, match] of [...ids].slice(0, 3)) {
        const raw = await mb(
          "release/" + id,
          { inc: "recordings+artist-credits+labels+discids" },
          signal,
        );
        if (!raw) continue;
        const r = release(raw);
        // Search hits require exact normalized title or catalogue; Disc IDs identify a physical edition.
        if (
          match === "catalog" &&
          !r["label-info"]?.some(
            (l) =>
              typeof l["catalog-number"] === "string" &&
              normalized(l["catalog-number"]) ===
                normalized(album.catalogNumber!),
          )
        )
          continue;
        if (match === "text" && normalized(r.title) !== normalized(album.title))
          continue;
        const notes = [r.country, r.date, r.status, r.disambiguation].filter(
          text,
        );
        if (match !== "discId")
          notes.push("按名称或品番找到；请核对发行地区、碟数和曲目版本。");
        let cover: Uint8Array | undefined;
        try {
          cover =
            (await http.bytes(
              "https://coverartarchive.org/release/" + id + "/front-500",
              "cover",
              signal,
              5 * 1024 * 1024,
            )) ?? undefined;
          if (!cover) notes.push("此发行版本没有可用的封面；保留本地封面。");
        } catch {
          cancelled(signal);
          notes.push("封面服务暂时不可用；其他资料仍可审核。");
        }
        output.push({ release: r, match, cover, notes });
      }
      cancelled(signal);
      return output;
    },
    async searchLyricsSources(track, album, signal, query) {
      return searchLyricsSources(http, track, album, signal, query, { sources: options.lyricSources, sourceTimeoutMs: options.lyricSourceTimeoutMs });
    },
    async searchLyrics(track, album, signal, query) {
      return usableSearch(await searchLyricsSources(http, track, album, signal, query,
        { sources: options.lyricSources, sourceTimeoutMs: options.lyricSourceTimeoutMs }));
    },
    async lyrics(track, album, signal) {
      if (
        !Number.isFinite(track.durationMs) ||
        track.durationMs < 1000 ||
        track.durationMs > 3600000
      )
        return null;
      const artist = track.artistCredit;
      const params = {
        track_name: track.title,
        artist_name: artist,
        album_name: album.title,
        duration: String(Math.round(track.durationMs / 1000)),
      };
      let raw = await http.json(
        "https://lrclib.net/api/get?" + new URLSearchParams(params),
        "lrclib",
        signal,
      );
      const matches = (value: unknown) => {
        if (!value || typeof value !== "object") return false;
        const r = value as Record<string, unknown>;
        return (
          text(r.trackName) &&
          text(r.artistName) &&
          text(r.albumName) &&
          normalized(r.trackName) === normalized(track.title) &&
          normalized(r.artistName) === normalized(artist) &&
          normalized(r.albumName) === normalized(album.title) &&
          typeof r.duration === "number" &&
          Number.isFinite(r.duration) &&
          Math.abs(r.duration * 1000 - track.durationMs) <= 2000
        );
      };
      if (!matches(raw)) {
        const hits = await http.json(
          "https://lrclib.net/api/search?" +
            new URLSearchParams({
              track_name: track.title,
              artist_name: artist,
              album_name: album.title,
            }),
          "lrclib",
          signal,
        );
        const clean = Array.isArray(hits)
          ? hits.slice(0, 20).filter(matches)
          : [];
        // Multiple exact records can still represent different versions/timings; no silent selection.
        raw = clean.length === 1 ? clean[0] : null;
      }
      if (!matches(raw)) return null;
      const r = raw as Record<string, unknown>;
      if (r.instrumental === true) return null; // Classification belongs to the user.
      const body =
        typeof r.syncedLyrics === "string" && r.syncedLyrics.trim()
          ? r.syncedLyrics
          : r.plainLyrics;
      if (typeof body !== "string" || !body.trim() || body.length > 500000)
        return null;
      const parsed = parseLyrics(body, track.id, {
        source: { kind: "provider", name: "LRCLIB", recordId: String(r.id) },
      });
      if (
        !["plain", "synced"].includes(parsed.kind) ||
        validateLyricsEdit({
          ...parsed,
          kind: parsed.kind as "plain" | "synced",
        }).length
      )
        throw new LocalError("unavailable", "歌词格式不符合要求，未采用。");
      cancelled(signal);
      return parsed;
    },
  };
}

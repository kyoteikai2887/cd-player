import { randomUUID } from "node:crypto";
import type {
  Album,
  AlbumEditableField,
  TrackEditableField,
  JsonValue,
  MetadataCandidate,
  MetadataReview,
  MetadataChange,
  UIAction,
} from "../../contracts/player.ts";
import { validateMetadataPatch } from "../../core/metadata.ts";
import type { LocalData } from "../model.ts";
import { LocalError, copy } from "../model.ts";
import { credit } from "./providers.ts";
import type {
  ReleaseResult,
  ReleaseMedium,
  ReleaseTrack,
} from "./providers.ts";

export interface PreparedReview {
  review: MetadataReview;
  candidates: Map<
    string,
    {
      releaseId: string;
      recordings: Record<string, string>;
      complete: boolean;
      cover?: { path: string; mime: string };
    }
  >;
  createdAt: number;
}
const isoLanguage: Record<string, string> = {
  jpn: "ja",
  eng: "en",
  zho: "zh",
  cmn: "zh",
  kor: "ko",
  fra: "fr",
  deu: "de",
  spa: "es",
  ita: "it",
};
export function prepareMetadataReview(
  data: LocalData,
  album: Album,
  results: (ReleaseResult & {
    coverPreview?: string;
    coverRecord?: { path: string; mime: string };
  })[],
): PreparedReview {
  const prepared: PreparedReview = {
    review: {
      id: randomUUID(),
      albumId: album.id,
      baseLibraryRevision: data.library.revision,
      status: results.length ? "ready" : "noResults",
      candidates: [],
      error: null,
    },
    candidates: new Map(),
    createdAt: Date.now(),
  };
  for (const result of results) {
    const r = result.release,
      ac = credit(r["artist-credit"]),
      changes: MetadataChange[] = [];
    const labels = Array.isArray(r["label-info"]) ? r["label-info"] : [];
    const catalog = labels
      .map((l) => l?.["catalog-number"])
      .filter((v): v is string => typeof v === "string" && !!v.trim());
    const label = labels
      .map((l) => l?.label?.name)
      .filter((v): v is string => typeof v === "string" && !!v.trim());
    const year =
      typeof r.date === "string" && /^\d{4}/.test(r.date)
        ? Number(r.date.slice(0, 4))
        : undefined;
    const media = r.media ?? [],
      notes = [...result.notes],
      recordings: Record<string, string> = {};
    const albumChange = (
      field: Exclude<AlbumEditableField, "cover">,
      to: JsonValue,
    ) => {
      const from = album[field] as JsonValue;
      if (
        JSON.stringify(from) !== JSON.stringify(to) &&
        validateMetadataPatch({ [field]: to }, true)
      )
        changes.push({
          id: randomUUID(),
          target: "album",
          albumId: album.id,
          field,
          from: copy(from),
          to: copy(to),
          userEdited: album.userEditedFields.includes(field),
        });
    };
    albumChange("title", r.title);
    if (ac) {
      albumChange("albumArtists", ac.names);
      albumChange("albumArtistCredit", ac.display);
    }
    if (year && year <= 9999) albumChange("releaseYear", year);
    // A release can have several labels/catalogue numbers. Preserve uncertainty in the notes.
    if (new Set(catalog).size === 1) albumChange("catalogNumber", catalog[0]);
    else if (catalog.length)
      notes.push("多个品番：" + catalog.join(" / ") + "；未自动选一个。");
    if (new Set(label).size === 1) albumChange("label", label[0]);
    const language = r["text-representation"]?.language;
    if (language && isoLanguage[language])
      albumChange("language", isoLanguage[language]);
    if (result.coverPreview && result.coverRecord)
      changes.push({
        id: randomUUID(),
        target: "album",
        albumId: album.id,
        field: "cover",
        from: album.cover
          ? {
              thumbUrl: album.cover.thumbUrl,
              ...(album.cover.width ? { width: album.cover.width } : {}),
              ...(album.cover.height ? { height: album.cover.height } : {}),
            }
          : null,
        to: { thumbUrl: result.coverPreview },
        userEdited: album.userEditedFields.includes("cover"),
      });

    const tracks = data.library.tracks.filter((t) => t.albumId === album.id),
      pairs: { local: (typeof tracks)[number]; remote: ReleaseTrack }[] = [];
    const usedMedia = new Set<number>();
    let matched = tracks.length > 0;
    for (const number of [...new Set(tracks.map((t) => t.discNumber))]) {
      const local = tracks.filter((t) => t.discNumber === number);
      const discId = album.rip?.discs?.find((d) => d.number === number)?.discId;
      const byId = discId
        ? media.filter((m) => m.discs?.some((d) => d.id === discId))
        : [];
      const candidates = byId.length
        ? byId
        : media.filter((m) => m.position === number);
      const m: ReleaseMedium | undefined =
        candidates.length === 1 ? candidates[0] : undefined;
      if (
        !m ||
        usedMedia.has(m.position) ||
        m.tracks?.length !== local.length ||
        new Set(local.map((t) => t.trackNumber)).size !== local.length ||
        new Set(m.tracks.map((t) => t.position)).size !== local.length
      ) {
        matched = false;
        break;
      }
      usedMedia.add(m.position);
      for (const t of local) {
        const remote = m.tracks.find((x) => x.position === t.trackNumber);
        const length = remote?.length ?? remote?.recording?.length;
        if (
          !remote ||
          (typeof length === "number"
            ? !Number.isFinite(length) || Math.abs(length - t.durationMs) > 2000
            : !byId.length)
        ) {
          matched = false;
          break;
        }
        pairs.push({ local: t, remote });
      }
      if (!matched) break;
    }
    if (matched && pairs.length === tracks.length) {
      for (const { local, remote } of pairs) {
        const tc = credit(
          remote["artist-credit"] ?? remote.recording?.["artist-credit"],
        );
        const patch = {
          title: remote.title ?? remote.recording!.title!,
          ...(tc ? { artists: tc.names, artistCredit: tc.display } : {}),
        };
        for (const [field, to] of Object.entries(patch)) {
          const key = field as TrackEditableField,
            from = local[key] as JsonValue;
          if (
            JSON.stringify(from) !== JSON.stringify(to) &&
            validateMetadataPatch({ [field]: to }, false)
          )
            changes.push({
              id: randomUUID(),
              target: "track",
              trackId: local.id,
              field: key,
              from: copy(from),
              to: copy(to),
              userEdited: local.userEditedFields.includes(key),
            });
        }
        const id = remote.recording?.id;
        if (id && /^[0-9a-f-]{36}$/i.test(id)) recordings[local.id] = id;
      }
    } else
      notes.push(
        "曲目数、碟号或时长不一致；未提出曲目字段修改，请人工核对版本。",
      );
    if (matched && usedMedia.size !== media.length)
      notes.push("本地只收录了此发行版本的部分碟片。");
    if (!changes.length) notes.push("可核对的字段与本地资料相同。");
    const candidate: MetadataCandidate = {
      id: randomUUID(),
      provider: "MusicBrainz / Cover Art Archive",
      match: result.match,
      title: r.title,
      albumArtistCredit: ac?.display ?? album.albumArtistCredit,
      releaseYear: year,
      catalogNumber: catalog.length === 1 ? catalog[0] : undefined,
      discCount: media.length,
      trackCount: media.reduce(
        (n, m) => n + (m.tracks?.length ?? m["track-count"] ?? 0),
        0,
      ),
      coverThumbUrl: result.coverPreview,
      notes,
      changes,
    };
    prepared.review.candidates.push(candidate);
    prepared.candidates.set(candidate.id, {
      releaseId: r.id,
      recordings,
      complete: matched && usedMedia.size === media.length,
      cover: result.coverRecord,
    });
  }
  return prepared;
}

export function applyOnlineMetadata(
  data: LocalData,
  prepared: PreparedReview,
  action: Extract<UIAction, { type: "applyMetadataCandidate" }>,
) {
  const review = prepared.review;
  if (
    review.id !== action.reviewId ||
    review.albumId !== action.albumId ||
    review.status !== "ready" ||
    Date.now() - prepared.createdAt > 30 * 60 * 1000
  )
    throw new LocalError("conflict", "候选已关闭或过期，请重新查找。");
  if (data.library.revision !== review.baseLibraryRevision)
    throw new LocalError(
      "conflict",
      "查找后资料库已变化，请保留资料并重新查找。",
    );
  const candidate = review.candidates.find((c) => c.id === action.candidateId),
    info = prepared.candidates.get(action.candidateId);
  if (
    !candidate ||
    !info ||
    !Array.isArray(action.changeIds) ||
    !action.changeIds.length ||
    !Array.isArray(action.confirmedProtectedChangeIds) ||
    new Set(action.changeIds).size !== action.changeIds.length ||
    new Set(action.confirmedProtectedChangeIds).size !==
      action.confirmedProtectedChangeIds.length ||
    action.changeIds.some(
      (id) => !candidate.changes.some((c) => c.id === id),
    ) ||
    action.confirmedProtectedChangeIds.some(
      (id) =>
        !action.changeIds.includes(id) ||
        !candidate.changes.some((c) => c.id === id && c.userEdited),
    )
  )
    throw new LocalError("invalidAction", "候选字段选择无效。");
  const selected = candidate.changes.filter((c) =>
    action.changeIds.includes(c.id),
  );
  if (
    selected.some(
      (c) => c.userEdited && !action.confirmedProtectedChangeIds.includes(c.id),
    )
  )
    throw new LocalError("locked", "手动整理过的字段需要逐项确认。");
  const album = data.library.albums.find((a) => a.id === action.albumId);
  if (!album) throw new LocalError("notFound", "专辑已移除。");
  const changedTracks = new Set<string>();
  for (const change of selected) {
    if (change.target === "album") {
      if (change.albumId !== album.id)
        throw new LocalError("invalidAction", "候选目标无效。");
      if (change.field === "cover") {
        if (!info.cover || !change.to)
          throw new LocalError("invalidAction", "候选封面已失效。");
        album.cover = {
          thumbUrl: "/api/cover/" + album.id,
          fullUrl: "/api/cover/" + album.id,
        };
        data.covers[album.id] = copy(info.cover);
      } else {
        if (!validateMetadataPatch({ [change.field]: change.to }, true))
          throw new LocalError("invalidAction", "候选字段格式无效。");
        Object.assign(album, { [change.field]: copy(change.to) });
      }
    } else {
      const track = data.library.tracks.find(
        (t) => t.id === change.trackId && t.albumId === album.id,
      );
      if (
        !track ||
        !validateMetadataPatch({ [change.field]: change.to }, false)
      )
        throw new LocalError("invalidAction", "候选曲目字段无效。");
      Object.assign(track, { [change.field]: copy(change.to) });
      if (info.recordings[track.id])
        track.musicBrainzRecordingId = info.recordings[track.id];
      changedTracks.add(track.id);
    }
  }
  for (const track of data.library.tracks)
    if (changedTracks.has(track.id)) track.revision++;
  album.revision++;
  album.musicBrainzReleaseId = info.releaseId;
  album.metadataStatus =
    info.complete && selected.length === candidate.changes.length
      ? "matched"
      : "partial";
  // Preserve field protection exactly: provider adoption must not mark ordinary fields as manual.
  data.library.revision++;
}

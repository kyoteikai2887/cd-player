import type {
  UIAction,
  LyricsDocument,
  LyricsEdit,
  UserSettings,
} from '../contracts/player.ts';
import {
  validateLyricsEdit,
  translationStatus,
  parseLyrics,
  attachTranslation,
} from '../core/lyrics.ts';
import { validateMetadataPatch } from '../core/metadata.ts';
import { planAlbumRemoval } from '../core/library.ts';
import type { LocalData } from './model.ts';
import { LocalError, copy } from './model.ts';

export function applyLocalWrite(data: LocalData, action: UIAction) {
  const requireDocument = (id: string, revision: number) => {
    const document = data.lyricsByTrack[id];
    if (!document) throw new LocalError('notFound', '曲目不存在。');
    if (document.revision !== revision)
      throw new LocalError(
        'conflict',
        '资料已变化；请保留草稿并比较最新版本。',
      );
    return document;
  };
  const save = (document: LyricsDocument) => {
    data.lyricsByTrack[document.trackId] = document;
    const track = data.library.tracks.find((t) => t.id === document.trackId)!;
    track.lyricsSummary = {
      kind: document.kind,
      translation: document.translationStatus,
      revision: document.revision,
    };
    data.library.revision++;
  };
  switch (action.type) {
    case 'removeAlbum': {
      const plan = planAlbumRemoval(data.library, action.albumId, action.baseLibraryRevision);
      if (!plan.ok) throw new LocalError(plan.code, plan.message);
      data.excludedTrackIds ??= {};
      for (const id of plan.trackIds) {
        data.excludedTrackIds[id] = plan.library.revision;
        delete data.files[id];
        delete data.lyricsByTrack[id];
        delete data.archivedLyrics[id];
      }
      delete data.covers[action.albumId];
      data.library = plan.library;
      return;
    }
    case 'saveLyrics': {
      const document = requireDocument(action.trackId, action.baseRevision),
        issues = validateLyricsEdit(action.patch);
      if (issues.length)
        throw new LocalError('invalidAction', issues[0].message);
      const originalChanged =
        document.kind !== action.patch.kind ||
        document.language !== action.patch.language ||
        JSON.stringify(document.lines.map((l) => [l.startMs, l.original])) !==
          JSON.stringify(
            action.patch.lines.map((l) => [l.startMs, l.original]),
          );
      const translationChanged =
        document.translationLanguage !== action.patch.translationLanguage ||
        JSON.stringify(
          document.lines.map((l) => [l.startMs, l.translation]),
        ) !==
          JSON.stringify(
            action.patch.lines.map((l) => [l.startMs, l.translation]),
          );
      save({
        ...document,
        ...copy(action.patch),
        revision: document.revision + 1,
        translationStatus: translationStatus(action.patch.lines),
        source:
          action.patch.kind === 'missing'
            ? {}
            : {
                original: originalChanged
                  ? { kind: 'manual' }
                  : document.source.original,
                ...(action.patch.lines.some((l) => l.translation?.trim())
                  ? {
                      translation: translationChanged
                        ? { kind: 'manual' as const }
                        : document.source.translation,
                    }
                  : {}),
              },
        warnings: [],
        lookup: 'idle',
        lookupError: null,
      });
      return;
    }
    case 'setLyricsOffset': {
      const document = requireDocument(action.trackId, action.baseRevision);
      if (!Number.isSafeInteger(action.offsetMs))
        throw new LocalError('invalidAction', '偏移须为整数毫秒。');
      save({
        ...document,
        offsetMs: action.offsetMs,
        revision: document.revision + 1,
      });
      return;
    }
    case 'setNoLyrics': {
      const document = requireDocument(action.trackId, action.baseRevision);
      if (action.kind === null) {
        save({
          ...(data.archivedLyrics[action.trackId] ??
            parseLyrics('', action.trackId)),
          revision: document.revision + 1,
        });
        delete data.archivedLyrics[action.trackId];
      } else {
        data.archivedLyrics[action.trackId] ??= copy(document);
        save({
          ...document,
          kind: action.kind,
          revision: document.revision + 1,
        });
      }
      return;
    }
    case 'updateAlbum':
    case 'updateTrack': {
      const album = action.type === 'updateAlbum';
      const entity =
        action.type === 'updateAlbum'
          ? data.library.albums.find((a) => a.id === action.albumId)
          : data.library.tracks.find((t) => t.id === action.trackId);
      if (!entity) throw new LocalError('notFound', '资料不存在。');
      if (entity.revision !== action.baseRevision)
        throw new LocalError('conflict', '资料已变化，请刷新后再保存。');
      if (!validateMetadataPatch(action.patch, album))
        throw new LocalError('invalidAction', '元数据格式无效。');
      const changed = Object.keys(action.patch).filter(
        (key) =>
          JSON.stringify(
            (entity as unknown as Record<string, unknown>)[key],
          ) !== JSON.stringify((action.patch as Record<string, unknown>)[key]),
      );
      Object.assign(entity, copy(action.patch));
      entity.revision++;
      Object.assign(entity, {
        userEditedFields: [
          ...new Set([...entity.userEditedFields, ...changed]),
        ],
      });
      for (const a of data.library.albums)
        a.trackIds.sort((x, y) => {
          const left = data.library.tracks.find((t) => t.id === x)!,
            right = data.library.tracks.find((t) => t.id === y)!;
          return (
            left.discNumber - right.discNumber ||
            left.trackNumber - right.trackNumber
          );
        });
      data.library.revision++;
      return;
    }
    case 'updateSettings': {
      const patch = action.patch;
      const allowed = [
        'lyricsMode',
        'accentColor',
        'background',
        'fontScale',
        'lyricsScale',
        'glassIntensity',
        'motion',
        'showDiscAnimation',
        'miniAlwaysOnTop',
        'miniShowLyrics',
        'ui',
      ];
      if (Object.keys(patch).some((key) => !allowed.includes(key)))
        throw new LocalError('invalidAction', '设置项无效。');
      if (
        patch.accentColor !== undefined &&
        !/^#[0-9a-f]{6}$/i.test(patch.accentColor)
      )
        throw new LocalError('invalidAction', '强调色须为 #RRGGBB。');
      for (const [key, choices] of Object.entries({
        lyricsMode: ['original', 'bilingual'],
        background: ['light', 'blue'],
        motion: ['system', 'reduced', 'full'],
      })) {
        const value = (patch as Record<string, unknown>)[key];
        if (value !== undefined && !choices.includes(String(value)))
          throw new LocalError('invalidAction', '设置枚举值无效。');
      }
      for (const key of [
        'showDiscAnimation',
        'miniAlwaysOnTop',
        'miniShowLyrics',
      ] as const)
        if (patch[key] !== undefined && typeof patch[key] !== 'boolean')
          throw new LocalError('invalidAction', '设置须为开关。');
      for (const key of ['fontScale', 'lyricsScale', 'glassIntensity'] as const)
        if (patch[key] !== undefined && !Number.isFinite(patch[key]))
          throw new LocalError('invalidAction', '设置数值无效。');
      const settings: UserSettings = {
        ...data.settings,
        ...copy(patch),
        ui: {
          main: { ...data.settings.ui.main, ...patch.ui?.main },
          mini: { ...data.settings.ui.mini, ...patch.ui?.mini },
        },
      };
      settings.fontScale = Math.min(1.3, Math.max(0.85, settings.fontScale));
      settings.lyricsScale = Math.min(1.5, Math.max(0.8, settings.lyricsScale));
      settings.glassIntensity = Math.min(
        1,
        Math.max(0, settings.glassIntensity),
      );
      data.settings = settings;
      return;
    }
    default:
      throw new LocalError('unsupported', '此本地验证版本尚未接入这个操作。');
  }
}

/** Document imports recheck their captured baseline after the native picker returns. */
export function importLocalLyrics(
  data: LocalData,
  action: Extract<UIAction, { type: 'importLyrics' }>,
  text: string,
  baseline: number,
) {
  const latest = data.lyricsByTrack[action.trackId];
  if (!latest) throw new LocalError('notFound', '曲目不存在。');
  if (latest.revision !== baseline)
    throw new LocalError('conflict', '选择文件期间歌词已变化，请重新导入。');
  let parsed = parseLyrics(text, action.trackId, {
    source: { kind: 'manual' },
    duplicateTimestampMode:
      action.content === 'bilingual' ? 'bilingual' : 'merge',
  });
  if (parsed.kind === 'missing')
    throw new LocalError('invalidAction', '文件没有有效歌词正文。');
  if (action.content === 'translation') {
    const paired = attachTranslation(latest.lines, parsed.lines);
    parsed = {
      ...latest,
      lines: paired.lines,
      warnings: [...latest.warnings, ...paired.warnings],
      source: { ...latest.source, translation: { kind: 'manual' } },
      translationLanguage: parsed.language,
    };
  }
  const edit: LyricsEdit = {
    kind: parsed.kind as LyricsEdit['kind'],
    lines: parsed.lines,
    language: parsed.language,
    translationLanguage: parsed.translationLanguage,
    offsetMs: parsed.offsetMs,
    locked: true,
  };
  const issues = validateLyricsEdit(edit);
  if (issues.length) throw new LocalError('invalidAction', issues[0].message);
  data.lyricsByTrack[action.trackId] = {
    ...parsed,
    revision: latest.revision + 1,
    locked: true,
    translationStatus: translationStatus(parsed.lines),
  };
  const doc = data.lyricsByTrack[action.trackId],
    track = data.library.tracks.find((t) => t.id === action.trackId)!;
  track.lyricsSummary = {
    kind: doc.kind,
    translation: doc.translationStatus,
    revision: doc.revision,
  };
  data.library.revision++;
}

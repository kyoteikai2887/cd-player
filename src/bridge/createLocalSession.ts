import { CONTRACT_VERSION } from "../contracts/player.ts";
import type {
  ActionResult,
  OperationError,
  PlayerBridge,
  PlayerSnapshot,
  Surface,
  UIAction,
  UISnapshot,
  LyricsDocument,
} from "../contracts/player.ts";
import type { LocalView } from "../local/model.ts";
import type { AudioEngine } from "../core/audio.ts";
import type { LocalClient } from "./localClient.ts";
import {
  emptyPlayer,
  loadQueue,
  selectQueueIndex,
  advance,
  previous,
  seek,
  setShuffle,
  editQueue,
  pruneQueueForLibrary,
} from "../core/queue.ts";
import { createBoundedDispatcher } from "./boundedDispatch.ts";
import type { DispatchContext } from "./boundedDispatch.ts";
import { createExitGuard } from "./exitGuard.ts";

export function createLocalSession(options: {
  client: LocalClient;
  engine: AudioEngine;
  autoTick?: boolean;
  now?: () => number;
  /** Private transport budget: native IPC reserves time to deliver the result. */
  actionTimeoutMs?: number;
}) {
  const { client, engine } = options,
    now = options.now ?? (() => performance.now()),
    guard = createExitGuard();
  let view = client.initial,
    mode: "full" | "mini" = "full",
    shown = true,
    disposed = false,
    serial = 0,
    editorSession = 0,
    cycle = 0;
  let state: Omit<UISnapshot, "host"> = {
    contractVersion: CONTRACT_VERSION,
    library: view.library,
    player: emptyPlayer(),
    lyrics: null,
    lyricsEditor: null,
    metadataReview: null, lyricsReview: null,
    settings: view.settings,
    tasks: [],
    notices: [],
  };
  const connections = new Set<{
    surface: Surface;
    cached: UISnapshot;
    listeners: Set<() => void>;
    destroy(): void;
  }>();
  const watchers = new Map<string, AbortController>();
  const lookups = new Map<string, { taskId: string; status: LyricsDocument['lookup']; error: OperationError | null;
    source?: LyricsDocument; decorated?: LyricsDocument }>();
  function documentFor(id: string): LyricsDocument | null {
    const source = view.lyricsByTrack[id], lookup = lookups.get(id);
    if (!source) return null;
    if (!lookup) return source;
    if (lookup.source !== source) {
      lookup.source = source; lookup.decorated = { ...source, lookup: lookup.status, lookupError: lookup.error };
    }
    return lookup.decorated!;
  }
  function lookupState(id: string, taskId: string, status: LyricsDocument['lookup'], error: OperationError | null = null) {
    if (status === 'idle') lookups.delete(id);
    else lookups.set(id, { taskId, status, error });
  }
  const ok: ActionResult = { ok: true, status: "applied" };
  const fail = (
    code: OperationError["code"],
    message: string,
  ): ActionResult => ({ ok: false, code, message });
  const host = (surface: Surface): UISnapshot["host"] => ({
    shell: "browser",
    windowMode: mode,
    surfaceVisible: shown && (mode === "mini") === (surface === "mini"),
    backdrop: "none",
    nativeCornerRadius: 0,
    alwaysOnTop: false,
    effectiveReducedMotion: state.settings.motion === "reduced",
    transparencyAllowed: false,
    coreStatus: "ready",
    capabilities: {
      nativeWindows: false,
      transparentWindow: false,
      windowDragging: false,
      alwaysOnTop: false,
    },
  });
  const snapshot = (surface: Surface, old?: UISnapshot) => {
    let h = host(surface);
    if (old && JSON.stringify(h) === JSON.stringify(old.host)) h = old.host;
    return { ...state, host: h };
  };
  function publish(patch: Partial<typeof state> = {}, sample = false) {
    state = { ...state, ...patch };
    if (sample)
      state = {
        ...state,
        player: {
          ...state.player,
          positionSampledAt: now(),
          sampleSequence: state.player.sampleSequence + 1,
        },
      };
    const lyrics = state.player.currentTrackId
      ? documentFor(state.player.currentTrackId)
      : null;
    if (state.lyrics !== lyrics) state = { ...state, lyrics };
    if (state.lyricsEditor) {
      const document = documentFor(state.lyricsEditor.trackId);
      if (state.lyricsEditor.document !== document) state = { ...state, lyricsEditor: { ...state.lyricsEditor, document } };
    }
    for (const connection of connections) {
      connection.cached = snapshot(connection.surface, connection.cached);
      for (const listener of connection.listeners) listener();
    }
  }
  function adopt(next: LocalView) {
    // Background task responses may contain a view captured before a newer committed write.
    if (next.library.revision < view.library.revision) return;
    const documents = { ...next.lyricsByTrack };
    for (const [id, document] of Object.entries(documents))
      if (JSON.stringify(document) === JSON.stringify(view.lyricsByTrack[id]))
        documents[id] = view.lyricsByTrack[id];
    view = { ...next, lyricsByTrack: documents };
    for (const id of lookups.keys()) if (!documents[id]) lookups.delete(id);
    const library =
      JSON.stringify(state.library) === JSON.stringify(next.library)
        ? state.library
        : next.library;
    const settings =
      JSON.stringify(state.settings) === JSON.stringify(next.settings)
        ? state.settings
        : next.settings;
    const editor = state.lyricsEditor?.trackId;
    const player = pruneQueueForLibrary(state.player, library);
    const queueChanged = player !== state.player;
    const currentRemoved = state.player.currentTrackId !== null && player.currentTrackId === null;
    if (currentRemoved) {
      command++;
      loadingAudio = false;
      engine.stop();
    }
    const editorRemoved = !!editor && !library.tracks.some(track => track.id === editor);
    if (editorRemoved) editorSession++;
    publish({
      library,
      settings,
      player,
      ...(state.lyricsReview && !library.tracks.some(track => track.id === state.lyricsReview!.trackId)
        ? { lyricsReview: null } : {}),
      ...(state.metadataReview && !library.albums.some(album => album.id === state.metadataReview!.albumId)
        ? { metadataReview: null } : {}),
      ...(editor
        ? {
            lyricsEditor: editorRemoved ? null : {
              ...state.lyricsEditor!,
              document: documents[editor] ?? null,
            },
          }
        : {}),
    }, currentRemoved);
    if (currentRemoved) engine.prepareNext(null);
    else if (queueChanged) prepare();
  }
  const successor = () => advance(state.player, state.library, "ended");
  function prepare() {
    const next = successor();
    engine.prepareNext(next.status === "playing" ? next.currentTrackId : null);
  }
  let activation: Promise<void> = Promise.resolve();
  let command = 0,
    loadingAudio = false;
  async function play(
    candidate: PlayerSnapshot,
    context: DispatchContext,
  ): Promise<ActionResult> {
    const request = ++command;
    loadingAudio = true;
    if (!candidate.currentTrackId || candidate.status !== "playing") {
      loadingAudio = false;
      engine.stop();
      publish({ player: candidate }, true);
      return ok;
    }
    engine.stop();
    publish({ player: { ...candidate, status: "buffering" } }, true);
    const abort = () => {
      if (!disposed && command === request) {
        engine.stop();
        publish(
          {
            player: {
              ...state.player,
              status: "error",
              error: {
                code: "unknown",
                message: "音频加载已取消或超时，请重试。",
              },
            },
          },
          true,
        );
      }
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      await activation;
      if (command !== request) return { ok: true, status: "cancelled" };
      if (!context.isActive() || disposed)
        return fail("unavailable", "播放请求已取消或超时。");
      await engine.play(
        candidate.currentTrackId,
        candidate.positionMs,
        true,
        context.signal,
      );
      if (command !== request) return { ok: true, status: "cancelled" };
      if (!context.isActive() || disposed)
        return fail("unavailable", "播放请求已取消或超时。");
      const sample = engine.sample();
      cycle = sample.cycle;
      publish(
        {
          player: {
            ...state.player,
            status: "playing",
            positionMs: sample.positionMs,
            durationMs: sample.durationMs,
            error: null,
          },
        },
        true,
      );
      engine.setGain(state.player.volume, state.player.muted);
      prepare();
      return ok;
    } catch (error) {
      if (command !== request) return { ok: true, status: "cancelled" };
      if (!disposed && command === request)
        publish(
          {
            player: {
              ...state.player,
              status: "error",
              error: {
                code: "decode",
                message:
                  error instanceof Error ? error.message : "音频无法播放。",
              },
            },
          },
          true,
        );
      return fail(
        "unavailable",
        error instanceof Error ? error.message : "音频无法播放。",
      );
    } finally {
      if (command === request) loadingAudio = false;
      context.signal.removeEventListener("abort", abort);
    }
  }
  function tick() {
    if (disposed || loadingAudio) return;
    const sample = engine.sample();
    if (!sample.trackId) return;
    if (sample.error) {
      if (state.player.status !== "error") {
        engine.pause();
        publish(
          {
            player: {
              ...state.player,
              status: "error",
              error: {
                code: sample.errorCode ?? "decode",
                message: sample.error,
              },
            },
            notices: [
              ...state.notices,
              { id: "audio-" + ++serial, tone: "error", message: sample.error },
            ],
          },
          true,
        );
      }
      return;
    }
    if (sample.cycle !== cycle) {
      const next = successor();
      cycle = sample.cycle;
      if (next.currentTrackId !== sample.trackId) {
        engine.stop();
        publish(
          {
            player: {
              ...state.player,
              status: "error",
              error: {
                code: "unknown",
                message: "播放队列与音频状态不一致，请重新选择曲目。",
              },
            },
          },
          true,
        );
        return;
      }
      publish(
        {
          player: {
            ...next,
            status: "playing",
            positionMs: sample.positionMs,
            durationMs: sample.durationMs,
          },
        },
        true,
      );
      prepare();
    } else if (
      sample.ended &&
      (state.player.status === "playing" || state.player.status === "buffering")
    ) {
      const next = successor();
      if (next.status !== "playing") {
        engine.pause();
        publish({ player: next }, true);
      } else {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 5000);
        void play(next, {
          signal: controller.signal,
          isActive: () => !controller.signal.aborted && !disposed,
        })
          .then((result) => {
            if (!result.ok && !disposed)
              publish({
                notices: [
                  ...state.notices,
                  {
                    id: "audio-" + ++serial,
                    tone: "error",
                    message: result.message,
                  },
                ],
              });
          })
          .finally(() => clearTimeout(timer));
      }
    } else if (
      state.player.status === "playing" ||
      state.player.status === "paused" ||
      state.player.status === "buffering"
    )
      publish(
        {
          player: {
            ...state.player,
            positionMs: sample.positionMs,
            durationMs: sample.durationMs,
            status: sample.buffering
              ? "buffering"
              : sample.playing
                ? "playing"
                : "paused",
          },
        },
        true,
      );
  }
  async function watch(id: string, action: UIAction, session: number, reviewId?: string) {
    const controller = new AbortController();
    watchers.set(id, controller);
    try {
      while (!disposed && !controller.signal.aborted) {
        const task = await client.task(id, controller.signal);
        if (task.state === "running") {
          publish({
            tasks: [...state.tasks.filter((t) => t.id !== id), task.task],
          });
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, 250);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
          continue;
        }
        if (task.state === "done") {
          if (task.result?.view) adopt(task.result.view);
          if (action.type === 'lookupMetadata' && task.result?.metadataReview && reviewId && state.metadataReview?.id === reviewId)
            publish({ metadataReview: task.result.metadataReview });
          if (action.type === 'searchLyricsCandidates' && task.result?.lyricsReview && reviewId && state.lyricsReview?.id === reviewId)
            publish({ lyricsReview: task.result.lyricsReview });
          if (action.type === 'lookupLyrics' && lookups.get(action.trackId)?.taskId === id) {
            lookupState(action.trackId, id, task.result?.lyricsLookup?.status ?? 'idle'); publish();
          }
          if (
            task.result?.pendingImport &&
            action.type === "importLyrics" &&
            editorSession === session &&
            state.lyricsEditor?.trackId === action.trackId
          )
            publish({
              lyricsEditor: {
                ...state.lyricsEditor,
                pendingImport: task.result.pendingImport,
              },
            });
          if (task.result?.warnings?.length)
            publish({
              notices: [
                ...state.notices,
                {
                  id: "scan-" + ++serial,
                  tone: "warning",
                  message: task.result.warnings.join("\n"),
                },
              ],
            });
        } else if (task.state === "failed") {
          if (task.result?.view) adopt(task.result.view);
          const error: OperationError = { code: (task.error?.code as OperationError['code']) ?? 'unavailable', message: task.error?.message ?? '在线查询失败。' };
          if (action.type === 'lookupMetadata') {
            if (reviewId && state.metadataReview?.id === reviewId) publish({ metadataReview: { ...state.metadataReview, status: 'failed', error } });
            break;
          }
          if (action.type === 'searchLyricsCandidates') {
            if (reviewId && state.lyricsReview?.id === reviewId) publish({ lyricsReview: { ...state.lyricsReview, status: 'failed', error } });
            break;
          }
          if (action.type === 'lookupLyrics') {
            if (lookups.get(action.trackId)?.taskId === id) { lookupState(action.trackId, id, 'failed', error); publish(); }
            break;
          }
          if (
            task.error?.code === "conflict" &&
            action.type === "importLyrics" &&
            state.lyricsEditor?.trackId === action.trackId
          )
            publish({
              lyricsEditor: {
                ...state.lyricsEditor,
                status: "conflict",
                error: { code: "conflict", message: task.error.message },
              },
            });
          publish({
            notices: [
              ...state.notices,
              {
                id: "task-" + ++serial,
                tone: "error",
                message: task.error?.message ?? "后台任务失败。",
              },
            ],
          });
        } else if (task.state === 'cancelled') {
          if (action.type === 'searchLyricsCandidates' && state.lyricsReview?.id === reviewId) publish({ lyricsReview: null });
          if (action.type === 'lookupMetadata' && reviewId && state.metadataReview?.id === reviewId) publish({ metadataReview: null });
          if (action.type === 'lookupLyrics' && lookups.get(action.trackId)?.taskId === id) { lookupState(action.trackId, id, 'idle'); publish(); }
        }
        break;
      }
    } catch (error) {
      if (!disposed && !controller.signal.aborted) {
        const failure: OperationError = { code: 'unavailable', message: '后台连接中断，请重试。' };
        if (action.type === 'searchLyricsCandidates') { if (reviewId && state.lyricsReview?.id === reviewId) publish({ lyricsReview: { ...state.lyricsReview, status: 'failed', error: failure } }); }
        else if (action.type === 'lookupMetadata') { if (reviewId && state.metadataReview?.id === reviewId) publish({ metadataReview: { ...state.metadataReview, status: 'failed', error: failure } }); }
        else if (action.type === 'lookupLyrics') { if (lookups.get(action.trackId)?.taskId === id) { lookupState(action.trackId, id, 'failed', failure); publish(); } }
        else
        publish({
          notices: [
            ...state.notices,
            {
              id: "task-" + ++serial,
              tone: "error",
              message: "后台连接中断，请重试。",
            },
          ],
        });
      }
    } finally {
      watchers.delete(id);
      if (!disposed) publish({ tasks: state.tasks.filter((t) => t.id !== id) });
    }
  }
  async function handle(
    action: UIAction,
    surface: Surface,
    context: DispatchContext,
  ): Promise<ActionResult> {
    if (disposed) return fail("unavailable", "播放核心已关闭。");
    tick();
    switch (action.type) {
      case "playAlbum": {
        const album = state.library.albums.find((a) => a.id === action.albumId);
        if (!album) return fail("notFound", "专辑不存在。");
        const index = action.startTrackId
          ? album.trackIds.indexOf(action.startTrackId)
          : album.trackIds.findIndex((id) =>
              state.library.tracks.some((t) => t.id === id && t.available),
            );
        if (index < 0) return fail("notFound", "没有可播放的起始曲目。");
        if (
          !state.library.tracks.some(
            (t) => t.id === album.trackIds[index] && t.available,
          )
        )
          return fail("fileMissing", "起始曲目文件不可用。");
        return play(
          loadQueue(
            {
              ...state.player,
              shuffle: action.shuffle ?? state.player.shuffle,
            },
            album.trackIds,
            state.library,
            index,
            "local-" + ++serial,
          ),
          context,
        );
      }
      case "playTracks": {
        if (
          !Number.isInteger(action.startIndex) ||
          action.startIndex < 0 ||
          action.startIndex >= action.trackIds.length
        )
          return fail("invalidAction", "起点无效。");
        if (
          !state.library.tracks.some(
            (t) => t.id === action.trackIds[action.startIndex] && t.available,
          )
        )
          return fail("fileMissing", "起始文件不可用。");
        return play(
          loadQueue(
            state.player,
            action.trackIds,
            state.library,
            action.startIndex,
            "local-" + ++serial,
          ),
          context,
        );
      }
      case "playQueueEntry": {
        const index = state.player.queue.findIndex(
          (e) => e.id === action.entryId,
        );
        if (index < 0) return fail("notFound", "队列项不存在。");
        const next = selectQueueIndex(state.player, index, state.library);
        if (next === state.player) return fail("fileMissing", "文件不可用。");
        return play(next, context);
      }
      case "togglePlayback": {
        if (!state.player.currentTrackId) {
          const index = state.player.queue.findIndex((e) =>
            state.library.tracks.some((t) => t.id === e.trackId && t.available),
          );
          if (index >= 0)
            return play(
              selectQueueIndex(state.player, index, state.library),
              context,
            );
          const album = state.library.albums.find((a) =>
            a.trackIds.some((id) =>
              state.library.tracks.some((t) => t.id === id && t.available),
            ),
          );
          return album
            ? handle({ type: "playAlbum", albumId: album.id }, surface, context)
            : fail("notFound", "请先导入专辑。");
        }
        if (
          state.player.status === "playing" ||
          state.player.status === "buffering"
        ) {
          command++;
          engine.pause();
          loadingAudio = false;
          publish(
            {
              player: {
                ...state.player,
                status: "paused",
                positionMs: engine.sample().trackId
                  ? engine.sample().positionMs
                  : state.player.positionMs,
              },
            },
            true,
          );
          return ok;
        }
        if (state.player.status === "paused") {
          if (engine.sample().trackId !== state.player.currentTrackId)
            return play(
              {
                ...state.player,
                status: "playing",
                positionMs:
                  state.player.positionMs >= state.player.durationMs
                    ? 0
                    : state.player.positionMs,
              },
              context,
            );
          const request = ++command;
          await activation;
          if (request !== command) return { ok: true, status: "cancelled" };
          if (!context.isActive()) return fail("unavailable", "恢复播放超时。");
          if (state.player.positionMs >= state.player.durationMs)
            engine.seek(0);
          await engine.resume(context.signal);
          if (request !== command) return { ok: true, status: "cancelled" };
          if (!context.isActive()) return fail("unavailable", "恢复播放超时。");
          publish(
            {
              player: {
                ...state.player,
                status: "playing",
                positionMs: engine.sample().positionMs,
              },
            },
            true,
          );
          prepare();
          return ok;
        }
        return play(
          {
            ...state.player,
            status: "playing",
            positionMs:
              state.player.positionMs >= state.player.durationMs
                ? 0
                : state.player.positionMs,
          },
          context,
        );
      }
      case "next":
        return play(advance(state.player, state.library, "manual"), context);
      case "previous": {
        const next = previous(state.player, state.library);
        if (next.currentEntryId === state.player.currentEntryId) {
          if (loadingAudio) return play(next, context);
          engine.seek(next.positionMs);
          publish({ player: next }, true);
          prepare();
          return ok;
        }
        return play(next, context);
      }
      case "seek":
        if (!Number.isFinite(action.positionMs))
          return fail("invalidAction", "跳转时间无效。");
        if (state.player.status === "buffering")
          return fail("unavailable", "音频仍在加载，请稍后重试。");
        engine.seek(action.positionMs);
        publish({ player: seek(state.player, action.positionMs) }, true);
        prepare();
        return ok;
      case "setVolume":
        if (!Number.isFinite(action.volume))
          return fail("invalidAction", "音量无效。");
        publish({
          player: {
            ...state.player,
            volume: Math.max(0, Math.min(1, action.volume)),
          },
        });
        engine.setGain(state.player.volume, state.player.muted);
        return ok;
      case "setMuted":
        publish({ player: { ...state.player, muted: action.muted } });
        engine.setGain(state.player.volume, state.player.muted);
        return ok;
      case "setRepeat":
        publish({ player: { ...state.player, repeat: action.repeat } });
        prepare();
        return ok;
      case "setShuffle":
        publish({ player: setShuffle(state.player, action.shuffle) });
        prepare();
        return ok;
      case "enqueue":
      case "removeFromQueue":
      case "moveQueueEntry": {
        const queue = [...state.player.queue];
        if (action.type === "enqueue") {
          if (
            action.trackIds.some(
              (id) =>
                !state.library.tracks.some((t) => t.id === id && t.available),
            )
          )
            return fail("fileMissing", "追加的文件不可用。");
          queue.splice(
            action.position === "end"
              ? queue.length
              : Math.max(0, state.player.currentQueueIndex + 1),
            0,
            ...action.trackIds.map((trackId) => ({
              id: "local-" + ++serial,
              trackId,
              originalOrder: 0,
            })),
          );
        } else {
          const index = queue.findIndex((e) => e.id === action.entryId);
          if (index < 0) return fail("notFound", "队列项不存在。");
          if (
            action.type === "moveQueueEntry" &&
            (!Number.isInteger(action.toIndex) ||
              action.toIndex < 0 ||
              action.toIndex >= queue.length)
          )
            return fail("invalidAction", "队列位置无效。");
          const [entry] = queue.splice(index, 1);
          if (action.type === "moveQueueEntry")
            queue.splice(action.toIndex, 0, entry);
        }
        const next = editQueue(state.player, queue, state.library);
        if (next.currentEntryId !== state.player.currentEntryId)
          return play(next, context);
        publish({ player: next });
        prepare();
        return ok;
      }
      case "setWindowMode":
        mode = action.mode;
        shown = true;
        publish();
        return ok;
      case "hideToTray":
        shown = false;
        publish();
        return ok;
      case "reportUnsavedChanges":
        if (action.surface !== surface)
          return fail("invalidAction", "窗口来源不匹配。");
        guard.report(surface, action.dirty);
        return ok;
      case "openLyricsEditor": {
        const document = documentFor(action.trackId);
        if (!document) return fail("notFound", "曲目不存在。");
        editorSession++;
        publish({
          lyricsEditor: {
            trackId: action.trackId,
            status: "ready",
            document,
            error: null,
            pendingImport: null,
          },
        });
        return ok;
      }
      case "closeLyricsEditor":
        editorSession++;
        publish({ lyricsEditor: null });
        return ok;
      case "dismissNotice":
        publish({
          notices: state.notices.filter((n) => n.id !== action.noticeId),
        });
        return ok;
      case "importFolder":
      case 'lookupMetadata':
      case 'lookupLyrics':
      case 'searchLyricsCandidates':
      case "rescanLibrary":
      case "importLyrics":
      case "pickCoverImage":
      case "cancelTask": {
        if (
          action.type === "importLyrics" &&
          action.destination === "editorDraft" &&
          state.lyricsEditor?.trackId !== action.trackId
        )
          return fail("invalidAction", "请先打开此曲的编辑器。");
        const reply = await client.start(action, context.signal);
        if (!context.isActive()) return fail("unavailable", "请求超时。");
        if (!reply.ok)
          return fail(
            (reply.code as OperationError["code"]) ?? "unknown",
            reply.message ?? "操作失败。",
          );
        if (action.type === 'cancelTask') {
          const task = state.tasks.find(t => t.id === action.taskId);
          if (task?.kind === 'lyrics' && task.trackId && lookups.get(task.trackId)?.taskId === action.taskId) lookupState(task.trackId, action.taskId, 'idle');
          publish({ tasks: state.tasks.map(t => t.id === action.taskId ? { ...t, status: 'cancelling' as const } : t),
            ...(task?.label === '搜索歌词候选' ? { lyricsReview: null } : {}),
            ...(task?.kind === 'metadata' ? { metadataReview: null } : {}) });
        }
        if (reply.taskId) {
          if (reply.metadataReview) publish({ metadataReview: reply.metadataReview });
          if (reply.lyricsReview) publish({ lyricsReview: reply.lyricsReview });
          if (action.type === 'lookupLyrics') { lookupState(action.trackId, reply.taskId, 'searching'); publish(); }
          if (reply.task) publish({ tasks: [...state.tasks, reply.task] });
          void watch(reply.taskId, action, editorSession, reply.metadataReview?.id ?? reply.lyricsReview?.id);
          return { ok: true, status: "started", taskId: reply.taskId };
        }
        return ok;
      }
      case "saveLyrics":
      case "setLyricsOffset":
      case "setNoLyrics":
      case "updateAlbum":
      case "updateTrack":
      case "updateSettings": {
        const reply = await client.write(action, context.signal);
        if (reply.view && !disposed) adopt(reply.view);
        if (!context.isActive()) return fail("unavailable", "保存请求超时。");
        if (!reply.ok) {
          if (
            reply.code === "conflict" &&
            "trackId" in action &&
            state.lyricsEditor?.trackId === action.trackId
          )
            publish({
              lyricsEditor: {
                ...state.lyricsEditor,
                status: "conflict",
                error: {
                  code: "conflict",
                  message: reply.message ?? "资料已变化。",
                },
              },
            });
          return fail(
            (reply.code as OperationError["code"]) ?? "unknown",
            reply.message ?? "保存失败。",
          );
        }
        if (
          action.type === "saveLyrics" &&
          state.lyricsEditor?.trackId === action.trackId
        )
          publish({
            lyricsEditor: {
              ...state.lyricsEditor,
              status: "ready",
              error: null,
              pendingImport: null,
            },
          });
        return ok;
      }
      case 'applyLyricsCandidate':
      case 'closeLyricsReview': {
        const importingSession = editorSession;
        if (action.type === 'applyLyricsCandidate' && action.destination === 'editorDraft' && state.lyricsEditor?.trackId !== action.trackId)
          return fail('invalidAction', '请先打开此曲的编辑器。');
        const reply = await client.write(action, context.signal);
        if (reply.view && !disposed) adopt(reply.view);
        if (!context.isActive()) return fail('unavailable', '歌词操作超时。');
        if (!reply.ok) return fail((reply.code as OperationError['code']) ?? 'unknown', reply.message ?? '歌词操作失败。');
        publish({ lyricsReview: null, ...(reply.pendingImport && action.type === 'applyLyricsCandidate' && editorSession === importingSession && state.lyricsEditor?.trackId === action.trackId ? { lyricsEditor: {
          ...state.lyricsEditor, pendingImport: reply.pendingImport, status: 'ready' as const, error: null } } : {}) });
        return ok;
      }
      case 'applyMetadataCandidate':
      case 'closeMetadataReview': {
        const reply = await client.write(action, context.signal);
        if (reply.view && !disposed) adopt(reply.view);
        if (!context.isActive()) return fail('unavailable', '资料请求超时。');
        if (!reply.ok) return fail((reply.code as OperationError['code']) ?? 'unavailable', reply.message ?? '资料请求失败。');
        publish({ metadataReview: null }); return ok;
      }
      case "removeAlbum": {
        const reply = await client.write(action, context.signal);
        if (reply.view && !disposed) adopt(reply.view);
        if (!context.isActive()) return fail('unavailable', '移除请求超时。');
        return reply.ok ? ok : fail((reply.code as OperationError['code']) ?? 'unknown', reply.message ?? '移除失败。');
      }
      default:
        return fail(
          "unsupported",
          "当前本地验证版本尚未接入在线查询或原生窗口功能。",
        );
    }
  }
  const ticker = options.autoTick === false ? null : setInterval(tick, 200);
  const unsubscribeAudio = engine.subscribe?.(tick);
  return {
    connect(surface: Surface): PlayerBridge & {
      dispatchWithBudget(
        action: UIAction,
        budgetMs: number,
      ): Promise<ActionResult>;
    } {
      const bounded = createBoundedDispatcher(
        (action, context) => handle(action, surface, context),
        options.actionTimeoutMs,
      );
      const connection = {
        surface,
        cached: snapshot(surface),
        listeners: new Set<() => void>(),
        destroy() {
          connections.delete(connection);
          bounded.destroy();
          connection.listeners.clear();
        },
      };
      connections.add(connection);
      const dispatchWithBudget = (action: UIAction, budgetMs: number) => {
        if (
          !connections.has(connection) ||
          !Number.isFinite(budgetMs) ||
          budgetMs <= 0 ||
          budgetMs > (options.actionTimeoutMs ?? 5000)
        )
          return bounded.dispatch(action, budgetMs);
        if (
          [
            "playAlbum",
            "playTracks",
            "playQueueEntry",
            "togglePlayback",
            "next",
            "previous",
          ].includes(action.type)
        ) {
          activation = engine.activate();
          void activation.catch(() => {});
        }
        return bounded.dispatch(action, budgetMs);
      };
      return {
        getSnapshot: () => connection.cached,
        subscribe(listener) {
          connection.listeners.add(listener);
          return () => {
            connection.listeners.delete(listener);
          };
        },
        dispatch: (action) =>
          dispatchWithBudget(action, options.actionTimeoutMs ?? 5000),
        dispatchWithBudget,
        destroy: connection.destroy,
      };
    },
    tick,
    requestExit: guard.requestExit,
    hasUnsavedChanges: guard.hasUnsavedChanges,
    destroy() {
      disposed = true;
      unsubscribeAudio?.();
      if (ticker) clearInterval(ticker);
      for (const controller of watchers.values()) controller.abort();
      for (const connection of [...connections]) connection.destroy();
      engine.destroy();
    },
  };
}

import type { OperationError } from '../contracts/player.ts';
import { CONTRACT_VERSION } from '../contracts/player.ts';
import type { ActionResult, Album, LyricsDocument, LyricsEdit, MetadataChange, PlayerBridge,
  Surface, Track, UIAction, UISnapshot } from '../contracts/player.ts';
import { createDemoData } from './fixtures.ts';
import type { DemoScenario } from './fixtures.ts';
import { emptyPlayer, loadQueue, selectQueueIndex, advance, previous, seek, setShuffle, editQueue, pruneQueueForLibrary } from '../core/queue.ts';
import { planAlbumRemoval } from '../core/library.ts';
import { attachTranslation, parseLyrics, translationStatus, validateLyricsEdit } from '../core/lyrics.ts';
import { createBoundedDispatcher } from '../bridge/boundedDispatch.ts';
import { createExitGuard } from '../bridge/exitGuard.ts';
import { validateMetadataPatch as validatePatch } from '../core/metadata.ts';
import { prepareLyricsReview, selectedLyrics } from '../local/online/candidates.ts';
import type { LyricSearchRecord, PreparedLyricsReview } from '../local/online/candidates.ts';

export interface MockOptions {
  searchLyrics?: (track: Track, signal: AbortSignal) => Promise<LyricSearchRecord[]>;
  scenario?: DemoScenario; autoTick?: boolean; now?: () => number; taskDelayMs?: number;
  importText?: (action: Extract<UIAction, { type: 'importLyrics' }>, signal: AbortSignal) => Promise<string | null>;
  lookup?: (track: Track, signal: AbortSignal) => Promise<{ document: LyricsDocument; durationMs: number } | null>;
}
export interface MockSession {
  connect(surface: Surface): PlayerBridge;
  advanceBy(ms: number): void;
  requestExit(confirmDiscard: () => Promise<boolean>): Promise<boolean>;
  destroy(): void;
}
export interface MockBridgeOptions extends MockOptions { surface?: Surface; session?: MockSession }

const applied: ActionResult = { ok: true, status: 'applied' };
const failure = (code: Extract<ActionResult, { ok: false }>['code'], message: string): ActionResult => ({ ok: false, code, message });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One simulated core can serve two mounted surfaces; standalone bridges own private data. */
export function createMockSession(options: MockOptions = {}): MockSession {
  const data = createDemoData(options.scenario);
  const documents = data.lyricsByTrack;
  let preparedLyrics: PreparedLyricsReview | null = null;
  const archived = new Map<string, LyricsDocument>();
  const now = options.now ?? (() => performance.now());
  const exitGuard = createExitGuard();
  let mode: 'full' | 'mini' = 'full', shown = true, disposed = false, serial = 0, editorSession = 0;
  let state: Omit<UISnapshot, 'host'> = { contractVersion: CONTRACT_VERSION,
    library: data.library, player: emptyPlayer(), lyrics: null, lyricsEditor: null,
    metadataReview: null, lyricsReview: null, settings: data.settings, tasks: [],
    notices: [{ id: 'demo', tone: 'info', message: '界面开发演示：模拟进度，不输出声音，不访问真实文件或服务。' }] };
  const initialTracks: Partial<Record<DemoScenario, string>> = {
    break: 'track-blue', locked: 'track-blue', spoken: 'track-spoken', plain: 'track-plain',
    missing: 'track-missing', partial: 'track-partial', instrumental: 'track-piano',
    'transparent-mini': 'track-blue', 'opaque-mini': 'track-blue',
  };
  const initialTrack = options.scenario && initialTracks[options.scenario];
  if (initialTrack) {
    state.player = { ...loadQueue(state.player, [initialTrack], state.library, 0, 'scenario'),
      status: 'paused', positionSampledAt: now(), sampleSequence: 1 };
    state.lyrics = documents[initialTrack];
  }
  if (options.scenario === 'transparent-mini' || options.scenario === 'opaque-mini') mode = 'mini';
  const connections = new Set<{ surface: Surface; cached: UISnapshot; listeners: Set<() => void>; destroy(): void }>();
  const workers = new Map<string, { controller: AbortController; deadline: ReturnType<typeof setTimeout> }>();
  const nextId = () => 'demo-' + (++serial);
  const makeHost = (surface: Surface): UISnapshot['host'] => ({
    shell: 'browser', windowMode: mode, surfaceVisible: shown && (mode === 'mini') === (surface === 'mini'),
    backdrop: 'none', alwaysOnTop: surface === 'mini' && state.settings.miniAlwaysOnTop,
    nativeCornerRadius: 0, effectiveReducedMotion: state.settings.motion === 'reduced',
    transparencyAllowed: state.settings.glassIntensity > 0,
    coreStatus: options.scenario === 'disconnected' ? 'unresponsive' : 'ready',
    capabilities: { nativeWindows: false, transparentWindow: options.scenario === 'transparent-mini',
      windowDragging: false, alwaysOnTop: false },
  });
  const materialize = (surface: Surface, old?: UISnapshot): UISnapshot => {
    let host = makeHost(surface);
    if (old && JSON.stringify(host) === JSON.stringify(old.host)) host = old.host;
    return { ...state, host };
  };
  function publish(patch: Partial<typeof state> = {}, playerChanged = false) {
    state = { ...state, ...patch };
    if (playerChanged) state = { ...state, player: { ...state.player,
      positionSampledAt: now(), sampleSequence: state.player.sampleSequence + 1 } };
    const trackId = state.player.currentTrackId;
    const lyrics = trackId ? documents[trackId] ?? null : null;
    if (state.lyrics !== lyrics) state = { ...state, lyrics };
    for (const connection of connections) {
      connection.cached = materialize(connection.surface, connection.cached);
      for (const listener of connection.listeners) listener();
    }
  }
  function writeDocument(document: LyricsDocument) {
    documents[document.trackId] = document;
    const tracks = state.library.tracks.map(track => track.id === document.trackId ? { ...track,
      lyricsSummary: { kind: document.kind, translation: document.translationStatus, revision: document.revision } } : track);
    publish({ library: { ...state.library, revision: state.library.revision + 1, tracks },
      ...(state.lyricsEditor?.trackId === document.trackId ? { lyricsEditor: { ...state.lyricsEditor,
        document, status: 'ready' as const, error: null } } : {}) });
  }
  const currentDoc = (id: string) => documents[id];
  function conflict(trackId: string): ActionResult {
    if (state.lyricsEditor?.trackId === trackId) publish({ lyricsEditor: { ...state.lyricsEditor,
      status: 'conflict', document: currentDoc(trackId), error: { code: 'conflict', message: '资料已变化；草稿请保留并比较后重新提交。' } } });
    return failure('conflict', '资料已变化，请刷新后重试。');
  }
  function finishTask(id: string) {
    const worker = workers.get(id);
    if (!worker) return;
    clearTimeout(worker.deadline); workers.delete(id);
    publish({ tasks: state.tasks.filter(task => task.id !== id) });
  }
  function startTask(kind: 'import' | 'scan' | 'metadata' | 'lyrics', label: string,
    run: (signal: AbortSignal, active: () => boolean) => Promise<void> | void,
    target: { albumId?: string; trackId?: string } = {}): ActionResult {
    const id = nextId(), controller = new AbortController();
    const active = () => !disposed && workers.has(id) && !controller.signal.aborted;
    const failTask = (message: string) => {
      if (!active()) return;
      if (target.trackId && documents[target.trackId]) documents[target.trackId] = { ...documents[target.trackId],
        lookup: kind === 'lyrics' ? 'failed' : documents[target.trackId].lookup,
        lookupError: kind === 'lyrics' ? { code: 'unavailable', message } : documents[target.trackId].lookupError };
      if (kind === 'metadata' && state.metadataReview && state.metadataReview.albumId === target.albumId) state = { ...state,
        metadataReview: { ...state.metadataReview, status: 'failed', error: { code: 'unavailable', message } } };
      publish({ notices: [...state.notices, { id: nextId(), tone: 'error', message }] });
      controller.abort(); finishTask(id);
    };
    const deadline = setTimeout(() => failTask('演示后台任务超时，请重试。'), kind === 'import' ? 120000 : 30000);
    workers.set(id, { controller, deadline });
    publish({ tasks: [...state.tasks, { id, kind, label, status: 'queued', cancellable: true, ...target }] });
    setTimeout(async () => {
      if (!active()) return;
      publish({ tasks: state.tasks.map(task => task.id === id ? { ...task, status: 'running' } : task) });
      try { await run(controller.signal, active); } catch (error) {
        failTask(error instanceof Error ? error.message : '演示任务失败。');
      } finally { finishTask(id); }
    }, options.taskDelayMs ?? 30);
    return { ok: true, status: 'started', taskId: id };
  }
  function updateEntity(action: Extract<UIAction, { type: 'updateAlbum' | 'updateTrack' }>): ActionResult {
    const isAlbum = action.type === 'updateAlbum';
    const entity = isAlbum ? state.library.albums.find(a => a.id === action.albumId) : state.library.tracks.find(t => t.id === action.trackId);
    if (!entity) return failure('notFound', '资料不存在。');
    if (entity.revision !== action.baseRevision) return failure('conflict', '资料已变化，请刷新后重试。');
    if (!validatePatch(action.patch, isAlbum)) return failure('invalidAction', '元数据修改格式无效。');
    const changed = Object.keys(action.patch).filter(key => JSON.stringify((entity as unknown as Record<string, unknown>)[key]) !== JSON.stringify((action.patch as Record<string, unknown>)[key]));
    if (!changed.length) return applied;
    const updated = { ...entity, ...clone(action.patch), revision: entity.revision + 1,
      userEditedFields: [...new Set([...entity.userEditedFields, ...changed])] };
    const albums = isAlbum ? state.library.albums.map(a => a.id === entity.id ? updated as Album : a) : state.library.albums;
    const tracks = isAlbum ? state.library.tracks : state.library.tracks.map(t => t.id === entity.id ? updated as Track : t);
    const sortedAlbums = !isAlbum && changed.some(key => ['discNumber', 'trackNumber'].includes(key)) ? albums.map(a =>
      a.id === (entity as Track).albumId ? { ...a, trackIds: [...a.trackIds].sort((x, y) => {
        const left = tracks.find(t => t.id === x)!, right = tracks.find(t => t.id === y)!;
        return left.discNumber - right.discNumber || left.trackNumber - right.trackNumber;
      }) } : a) : albums;
    publish({ library: { ...state.library, revision: state.library.revision + 1, albums: sortedAlbums, tracks } });
    return applied;
  }
  async function handle(action: UIAction, surface: Surface): Promise<ActionResult> {
    if (disposed || options.scenario === 'disconnected') return failure('unavailable', '演示播放核心未响应。');
    switch (action.type) {
      case 'removeAlbum': {
        const plan = planAlbumRemoval(state.library, action.albumId, action.baseLibraryRevision);
        if (!plan.ok) return failure(plan.code, plan.message);
        const removed = new Set(plan.trackIds);
        const taskIds = new Set(state.tasks.filter(task => task.albumId === action.albumId ||
          (task.trackId && removed.has(task.trackId))).map(task => task.id));
        for (const id of taskIds) {
          const worker = workers.get(id);
          if (worker) { worker.controller.abort(); clearTimeout(worker.deadline); workers.delete(id); }
        }
        for (const id of removed) { delete documents[id]; archived.delete(id); }
        const editorRemoved = !!state.lyricsEditor && removed.has(state.lyricsEditor.trackId);
        if (editorRemoved) editorSession++;
        const player = pruneQueueForLibrary(state.player, plan.library);
        const currentRemoved = state.player.currentTrackId !== null && player.currentTrackId === null;
        publish({ library: plan.library, player,
          ...(state.lyricsReview && removed.has(state.lyricsReview.trackId) ? { lyricsReview: null } : {}),
          tasks: state.tasks.filter(task => !taskIds.has(task.id)),
          ...(editorRemoved ? { lyricsEditor: null } : {}),
          ...(state.metadataReview?.albumId === action.albumId ? { metadataReview: null } : {}),
        }, currentRemoved);
        return applied;
      }
      case 'playAlbum': {
        const album = state.library.albums.find(a => a.id === action.albumId);
        if (!album) return failure('notFound', '专辑不存在。');
        const index = action.startTrackId ? album.trackIds.indexOf(action.startTrackId) :
          album.trackIds.findIndex(id => state.library.tracks.some(t => t.id === id && t.available));
        if (index < 0) return failure('notFound', '没有可播放的起始曲目。');
        const track = state.library.tracks.find(t => t.id === album.trackIds[index]);
        if (!track?.available) return failure('fileMissing', '曲目文件不可用。');
        publish({ player: loadQueue({ ...state.player, shuffle: action.shuffle ?? state.player.shuffle },
          album.trackIds, state.library, index, nextId()) }, true); return applied;
      }
      case 'playTracks': {
        if (!Number.isInteger(action.startIndex) || action.startIndex < 0 || action.startIndex >= action.trackIds.length) return failure('invalidAction', '起始曲目无效。');
        if (!state.library.tracks.some(t => t.id === action.trackIds[action.startIndex] && t.available)) return failure('fileMissing', '起始曲目不可用。');
        publish({ player: loadQueue(state.player, action.trackIds, state.library, action.startIndex, nextId()) }, true); return applied;
      }
      case 'playQueueEntry': {
        const index = state.player.queue.findIndex(e => e.id === action.entryId);
        if (index < 0) return failure('notFound', '队列项不存在。');
        const selected = selectQueueIndex(state.player, index, state.library);
        if (selected === state.player) return failure('fileMissing', '曲目文件不可用。');
        publish({ player: selected }, true); return applied;
      }
      case 'enqueue': {
        if (action.trackIds.some(id => !state.library.tracks.some(t => t.id === id && t.available))) return failure('fileMissing', '追加的曲目不可用。');
        const queue = [...state.player.queue], at = action.position === 'end' ? queue.length : Math.max(0, state.player.currentQueueIndex + 1);
        queue.splice(at, 0, ...action.trackIds.map(trackId => ({ id: nextId(), trackId, originalOrder: 0 })));
        publish({ player: editQueue(state.player, queue, state.library) }, true); return applied;
      }
      case 'removeFromQueue': {
        if (!state.player.queue.some(e => e.id === action.entryId)) return failure('notFound', '队列项不存在。');
        publish({ player: editQueue(state.player, state.player.queue.filter(e => e.id !== action.entryId), state.library) }, true); return applied;
      }
      case 'moveQueueEntry': {
        const queue = [...state.player.queue], index = queue.findIndex(e => e.id === action.entryId);
        if (index < 0 || !Number.isInteger(action.toIndex) || action.toIndex < 0 || action.toIndex >= queue.length) return failure('invalidAction', '队列位置无效。');
        const [entry] = queue.splice(index, 1); queue.splice(action.toIndex, 0, entry);
        publish({ player: editQueue(state.player, queue, state.library) }, true); return applied;
      }
      case 'togglePlayback':
        if (!state.player.currentTrackId) {
          if (state.player.queue.length) return handle({ type: 'playTracks', trackIds: state.player.queue.map(e => e.trackId), startIndex: 0 }, surface);
          const album = state.library.albums.find(a => a.trackIds.some(id => state.library.tracks.some(t => t.id === id && t.available)));
          return album ? handle({ type: 'playAlbum', albumId: album.id }, surface) : failure('notFound', '先导入一张专辑。');
        }
        publish({ player: { ...state.player, status: state.player.status === 'playing' ? 'paused' : 'playing' } }, true); return applied;
      case 'next': publish({ player: advance(state.player, state.library, 'manual') }, true); return applied;
      case 'previous': publish({ player: previous(state.player, state.library) }, true); return applied;
      case 'seek':
        if (!Number.isFinite(action.positionMs)) return failure('invalidAction', '时间无效。');
        publish({ player: seek(state.player, action.positionMs) }, true); return applied;
      case 'setVolume':
        if (!Number.isFinite(action.volume)) return failure('invalidAction', '音量无效。');
        publish({ player: { ...state.player, volume: Math.min(1, Math.max(0, action.volume)) } }, true); return applied;
      case 'setMuted': publish({ player: { ...state.player, muted: action.muted } }, true); return applied;
      case 'setRepeat': publish({ player: { ...state.player, repeat: action.repeat } }, true); return applied;
      case 'setShuffle': publish({ player: setShuffle(state.player, action.shuffle) }, true); return applied;
      case 'setWindowMode': mode = action.mode; shown = true; publish(); return applied;
      case 'hideToTray': shown = false; publish(); return applied;
      case 'beginWindowDrag': return failure('unsupported', '浏览器演示没有原生窗口拖动。');
      case 'reportUnsavedChanges':
        if (action.surface !== surface) return failure('invalidAction', '窗口来源不匹配。');
        exitGuard.report(surface, action.dirty); return applied;
      case 'updateSettings': {
        const patch = action.patch;
        if (patch.accentColor !== undefined && !/^#[0-9a-f]{6}$/i.test(patch.accentColor)) return failure('invalidAction', '强调色必须是 #RRGGBB。');
        for (const key of ['fontScale', 'lyricsScale', 'glassIntensity'] as const) {
          if (patch[key] !== undefined && !Number.isFinite(patch[key])) return failure('invalidAction', '设置数值无效。');
        }
        const settings = { ...state.settings, ...clone(patch), ui: {
          main: { ...state.settings.ui.main, ...patch.ui?.main },
          mini: { ...state.settings.ui.mini, ...patch.ui?.mini },
        } };
        settings.fontScale = Math.min(1.3, Math.max(0.85, settings.fontScale));
        settings.lyricsScale = Math.min(1.5, Math.max(0.8, settings.lyricsScale));
        settings.glassIntensity = Math.min(1, Math.max(0, settings.glassIntensity));
        publish({ settings }); return applied;
      }
      case 'openLyricsEditor': {
        const document = currentDoc(action.trackId);
        if (!document) return failure('notFound', '曲目不存在。');
        editorSession++; publish({ lyricsEditor: { trackId: action.trackId, status: 'ready',
          document, error: null, pendingImport: null } }); return applied;
      }
      case 'closeLyricsEditor': editorSession++; publish({ lyricsEditor: null }); return applied;
      case 'saveLyrics': {
        const document = currentDoc(action.trackId);
        if (!document) return failure('notFound', '歌词文档不存在。');
        if (document.revision !== action.baseRevision) return conflict(action.trackId);
        const issues = validateLyricsEdit(action.patch);
        if (issues.length) return failure('invalidAction', issues[0].message);
        const originalChanged = action.patch.kind !== document.kind || action.patch.language !== document.language ||
          JSON.stringify(action.patch.lines.map(l => [l.startMs, l.original])) !== JSON.stringify(document.lines.map(l => [l.startMs, l.original]));
        const translationChanged = action.patch.translationLanguage !== document.translationLanguage ||
          JSON.stringify(action.patch.lines.map(l => [l.startMs, l.translation])) !== JSON.stringify(document.lines.map(l => [l.startMs, l.translation]));
        const saved: LyricsDocument = { ...document, ...clone(action.patch), revision: document.revision + 1,
          translationStatus: translationStatus(action.patch.lines), source: action.patch.kind === 'missing' ? {} :
            { original: originalChanged ? { kind: 'manual' } : document.source.original,
              ...(action.patch.lines.some(l => l.translation?.trim()) ? { translation: translationChanged ? { kind: 'manual' as const } : document.source.translation } : {}) },
          warnings: [], lookup: 'idle', lookupError: null };
        writeDocument(saved);
        if (state.lyricsEditor?.trackId === action.trackId) publish({ lyricsEditor: { ...state.lyricsEditor,
          status: 'ready', document: saved, error: null, pendingImport: null } });
        return applied;
      }
      case 'setLyricsOffset': {
        const document = currentDoc(action.trackId);
        if (!document) return failure('notFound', '歌词文档不存在。');
        if (document.revision !== action.baseRevision) return conflict(action.trackId);
        if (!Number.isSafeInteger(action.offsetMs)) return failure('invalidAction', '偏移必须是整数毫秒。');
        writeDocument({ ...document, offsetMs: action.offsetMs, revision: document.revision + 1 }); return applied;
      }
      case 'setNoLyrics': {
        const document = currentDoc(action.trackId);
        if (!document) return failure('notFound', '歌词文档不存在。');
        if (document.revision !== action.baseRevision) return conflict(action.trackId);
        if (action.kind === null) {
          const restored = archived.get(action.trackId) ?? parseLyrics('', action.trackId);
          writeDocument({ ...restored, revision: document.revision + 1 }); archived.delete(action.trackId);
        } else {
          if (!archived.has(action.trackId)) archived.set(action.trackId, document);
          writeDocument({ ...document, kind: action.kind, revision: document.revision + 1 });
        }
        return applied;
      }
      case 'importLyrics': {
        const document = currentDoc(action.trackId);
        if (!document) return failure('notFound', '歌词文档不存在。');
        const draft = action.destination === 'editorDraft', session = editorSession;
        if (draft && state.lyricsEditor?.trackId !== action.trackId) return failure('invalidAction', '请先打开此曲的编辑器。');
        if (draft && state.tasks.some(t => t.kind === 'import' && t.trackId === action.trackId)) return failure('unavailable', '请等待当前导入完成。');
        const baseline = action.baseRevision ?? document.revision;
        if (!draft && document.revision !== baseline) return conflict(action.trackId);
        return startTask('import', '演示歌词导入', async (signal, active) => {
          const text = options.importText ? await options.importText(action, signal) :
            action.content === 'translation' ? '[00:00.000]窗外是一片蓝色天空\n[00:08.000]翻开今天的这一页' :
              '[00:00.000]窓の向こうに青い空\n[00:08.000]今日のページを開こう';
          if (!active() || text === null || draft && (editorSession !== session || state.lyricsEditor?.trackId !== action.trackId)) return;
          const parsed = parseLyrics(text, action.trackId, { duplicateTimestampMode: action.content === 'bilingual' ? 'bilingual' : 'merge' });
          if (parsed.kind === 'missing') throw new Error('导入文件没有有效歌词正文。');
          if (draft) {
            publish({ lyricsEditor: { ...state.lyricsEditor!, pendingImport: { id: nextId(), content: action.content,
              kind: parsed.kind as 'synced' | 'plain', lines: parsed.lines, language: parsed.language, warnings: parsed.warnings } } });
            return;
          }
          const latest = currentDoc(action.trackId);
          if (latest.revision !== baseline) throw new Error('导入期间文档已变化，请重新导入。');
          let imported = parsed;
          if (action.content === 'translation') {
            const paired = attachTranslation(latest.lines, parsed.lines);
            imported = { ...latest, lines: paired.lines, warnings: [...latest.warnings, ...paired.warnings],
              source: { ...latest.source, translation: { kind: 'manual' } }, translationLanguage: parsed.language };
          }
          const edit: LyricsEdit = { kind: imported.kind as LyricsEdit['kind'], language: imported.language,
            translationLanguage: imported.translationLanguage, lines: imported.lines, offsetMs: imported.offsetMs, locked: true };
          const issues = validateLyricsEdit(edit);
          if (issues.length) throw new Error(issues[0].message);
          writeDocument({ ...imported, locked: true, revision: latest.revision + 1, translationStatus: translationStatus(imported.lines) });
        }, { trackId: action.trackId });
      }
      case 'searchLyricsCandidates': {
        const track = state.library.tracks.find(t => t.id === action.trackId), doc = currentDoc(action.trackId);
        const album = track && state.library.albums.find(a => a.id === track.albumId);
        if (!track || !album || !doc) return failure('notFound', '曲目不存在。');
        if (doc.locked) return failure('locked', '歌词已锁定。');
        if (action.query && (!action.query.title.trim() || action.query.title.length > 2000 || action.query.artist.length > 2000)) return failure('invalidAction', '请输入有效曲名与歌手。');
        const pending = prepareLyricsReview(track, album, doc, [], action.query), id = pending.review.id;
        const result = startTask('lyrics', '搜索歌词候选', async (signal, active) => {
          try {
            const records = options.searchLyrics ? await options.searchLyrics(track, signal) : [{
              provider: '虚构演示源', recordId: 'demo-original', title: track.title, artistCredit: track.artistCredit,
              albumTitle: '另一张原创专辑', durationMs: track.durationMs + 1000,
              document: parseLyrics('[00:00]候选预览的第一句\n[00:08]候选预览的第二句', track.id, { source: { kind: 'provider', name: '虚构演示源', recordId: 'demo-original' } }),
            }, { provider: '虚构演示源', recordId: 'demo-tv', title: track.title + ' (TV Size)', artistCredit: track.artistCredit,
              albumTitle: '原创短版专辑', durationMs: 90000,
              document: parseLyrics('[00:00]这是原创短版候选\n[00:06]先确认版本再使用', track.id) }];
            if (!active() || state.lyricsReview?.id !== id) return;
            preparedLyrics = prepareLyricsReview(track, album, doc, records, action.query); preparedLyrics.review.id = id;
            publish({ lyricsReview: preparedLyrics.review });
          } catch {
            if (active() && state.lyricsReview?.id === id) publish({ lyricsReview: { ...state.lyricsReview, status: 'failed', error: { code: 'unavailable', message: '歌词搜索未完成，请重试。' } } });
          }
        }, { trackId: track.id, albumId: album.id });
        if (result.ok) { preparedLyrics = null; publish({ lyricsReview: { ...pending.review, status: 'searching' } }); }
        return result;
      }
      case 'closeLyricsReview': {
        preparedLyrics = null; publish({ lyricsReview: null });
        const task = state.tasks.find(t => t.label === '搜索歌词候选');
        if (task) { const worker = workers.get(task.id); worker?.controller.abort(); finishTask(task.id); }
        return applied;
      }
      case 'applyLyricsCandidate': {
        if (!preparedLyrics) return failure('conflict', '候选已关闭或过期，请重新查找。');
        let candidate: LyricsDocument;
        try { candidate = selectedLyrics({ ...data, library: state.library, lyricsByTrack: documents }, preparedLyrics, action); }
        catch (error) { const e = error as { code: OperationError['code']; message: string }; return failure(e.code, e.message); }
        if (action.destination === 'editorDraft') {
          if (state.lyricsEditor?.trackId !== action.trackId) return failure('invalidAction', '请先打开此曲的编辑器。');
          publish({ lyricsReview: null, lyricsEditor: { ...state.lyricsEditor, pendingImport: { id: nextId(), content: 'original',
            kind: candidate.kind as 'plain' | 'synced', lines: candidate.lines, language: candidate.language, warnings: candidate.warnings } } });
        } else {
          const latest = currentDoc(action.trackId);
          if (latest.kind !== 'missing') return failure('invalidAction', '已有歌词，请在编辑器里将候选导入草稿。');
          writeDocument({ ...candidate, revision: latest.revision + 1, offsetMs: latest.offsetMs, language: candidate.language ?? latest.language, locked: false });
          publish({ lyricsReview: null });
        }
        preparedLyrics = null; return applied;
      }
      case 'lookupLyrics': {
        const document = currentDoc(action.trackId), track = state.library.tracks.find(t => t.id === action.trackId);
        if (!document || !track) return failure('notFound', '曲目不存在。');
        if (document.locked) return failure('locked', '歌词已锁定；替换请使用编辑器或导入。');
        if (['instrumental', 'spoken'].includes(document.kind)) return applied;
        const baseline = document.revision;
        documents[action.trackId] = { ...document, lookup: 'searching', lookupError: null }; publish();
        return startTask('lyrics', '演示歌词查找', async (signal, active) => {
          const candidate = options.lookup ? await options.lookup(track, signal) : { durationMs: track.durationMs,
            document: parseLyrics('[00:00.000]新しいページ\n[00:00.000]新的一页\n[00:08.000]青い空\n[00:08.000]蓝色天空',
              track.id, { source: { kind: 'provider', name: '虚构演示源' }, language: 'ja',
                translationLanguage: 'zh-Hans', duplicateTimestampMode: 'bilingual' }) };
          if (!active()) return;
          const latest = currentDoc(track.id);
          if (latest.revision !== baseline || latest.locked) throw new Error('查找期间歌词已修改或锁定，结果未应用。');
          if (!candidate || !['synced', 'plain'].includes(candidate.document.kind) || !Number.isFinite(candidate.durationMs) || Math.abs(candidate.durationMs - track.durationMs) > Math.max(2000, track.durationMs * 0.01)) {
            documents[track.id] = { ...latest, lookup: 'notFound', lookupError: null }; publish(); return;
          }
          const candidateEdit: LyricsEdit = { kind: candidate.document.kind as LyricsEdit['kind'], lines: candidate.document.lines,
            language: candidate.document.language, translationLanguage: candidate.document.translationLanguage,
            offsetMs: 0, locked: false };
          const candidateIssues = validateLyricsEdit(candidateEdit);
          if (candidateIssues.length) throw new Error('查找结果格式无效，未应用：' + candidateIssues[0].message);
          let lines = latest.lines, kind = latest.kind, source = latest.source;
          if (latest.kind === 'missing' && ['synced', 'plain'].includes(candidate.document.kind)) {
            lines = candidate.document.lines.map(l => ({ ...l })); kind = candidate.document.kind; source = candidate.document.source;
          } else {
            const translations = candidate.document.lines.filter(l => l.translation?.trim() &&
              latest.lines.some(o => o.startMs !== null && l.startMs !== null && Math.abs(o.startMs - l.startMs) <= 100 && o.original === l.original))
              .map(l => ({ ...l, original: l.translation!, translation: undefined }));
            const paired = attachTranslation(latest.lines, translations);
            lines = paired.lines.map((line, index) => latest.lines[index].translation?.trim() ? latest.lines[index] : line);
            if (JSON.stringify(lines) !== JSON.stringify(latest.lines)) source = { ...source, translation: candidate.document.source.translation };
          }
          const changed = JSON.stringify(lines) !== JSON.stringify(latest.lines);
          const updated = { ...latest, kind, lines: changed ? lines : latest.lines, source,
            language: latest.kind === 'missing' ? candidate.document.language : latest.language,
            translationLanguage: changed && translationStatus(lines) !== 'missing' ? candidate.document.translationLanguage : latest.translationLanguage,
            translationStatus: translationStatus(lines), lookup: 'idle' as const, lookupError: null, revision: latest.revision + (changed ? 1 : 0) };
          if (changed) writeDocument(updated); else { documents[track.id] = updated; publish(); }
        }, { trackId: action.trackId });
      }
      case 'updateAlbum': case 'updateTrack': return updateEntity(action);
      case 'pickCoverImage': {
        const album = state.library.albums.find(a => a.id === action.albumId);
        if (!album) return failure('notFound', '专辑不存在。');
        if (album.revision !== action.baseRevision) return failure('conflict', '资料已变化。');
        return startTask('import', '演示封面选择', (_signal, active) => {
          if (!active()) return;
          const latest = state.library.albums.find(a => a.id === album.id)!;
          if (latest.revision !== action.baseRevision) throw new Error('选择期间资料已变化。');
          publish({ library: { ...state.library, revision: state.library.revision + 1, albums: state.library.albums.map(a =>
            a.id === album.id ? { ...a, revision: a.revision + 1, cover: { thumbUrl: '/covers/white.svg', fullUrl: '/covers/white.svg' },
              userEditedFields: [...new Set([...a.userEditedFields, 'cover' as const])] } : a) } });
        }, { albumId: album.id });
      }
      case 'lookupMetadata': {
        const album = state.library.albums.find(a => a.id === action.albumId);
        if (!album) return failure('notFound', '专辑不存在。');
        const review = { id: nextId(), albumId: album.id, baseLibraryRevision: state.library.revision,
          status: 'searching' as const, candidates: [], error: null };
        publish({ metadataReview: review });
        return startTask('metadata', '演示元数据候选', (_signal, active) => {
          if (!active() || state.metadataReview?.id !== review.id) return;
          const changes: MetadataChange[] = [
            { id: nextId(), target: 'album', albumId: album.id, field: 'title', from: album.title,
              to: album.title + ' (資料確認)', userEdited: album.userEditedFields.includes('title') },
            { id: nextId(), target: 'album', albumId: album.id, field: 'cover', from: album.cover ? { thumbUrl: album.cover.thumbUrl } : null,
              to: { thumbUrl: '/covers/white.svg', width: 600, height: 600 }, userEdited: album.userEditedFields.includes('cover') },
          ];
          publish({ metadataReview: { ...review, status: 'ready', candidates: [{ id: nextId(), provider: '虚构演示源', match: 'text',
            title: album.title, albumArtistCredit: album.albumArtistCredit, discCount: album.discs.length,
            trackCount: album.trackIds.length, notes: ['演示候选，不是在线匹配结果。'], changes }] } });
        }, { albumId: album.id });
      }
      case 'applyMetadataCandidate': {
        const review = state.metadataReview;
        if (!review || review.id !== action.reviewId || review.albumId !== action.albumId) return failure('conflict', '候选审阅已失效。');
        if (review.baseLibraryRevision !== state.library.revision) return failure('conflict', '资料已变化，请重新查找。');
        const candidate = review.candidates.find(c => c.id === action.candidateId);
        if (!candidate || action.changeIds.some(id => !candidate.changes.some(c => c.id === id)) ||
          action.confirmedProtectedChangeIds.some(id => !action.changeIds.includes(id) || !candidate.changes.some(c => c.id === id && c.userEdited))) return failure('invalidAction', '候选字段选择无效。');
        const selected = candidate.changes.filter(c => action.changeIds.includes(c.id));
        if (selected.some(c => c.userEdited && !action.confirmedProtectedChangeIds.includes(c.id))) return failure('locked', '受保护字段需要逐项确认。');
        const library = clone(state.library);
        for (const change of selected) {
          if (change.target !== 'album') return failure('unsupported', '本演示候选仅包含专辑字段。');
          const album = library.albums.find(a => a.id === change.albumId);
          if (!album) return failure('notFound', '目标资料不存在。');
          if (change.field === 'cover') album.cover = change.to ? { ...change.to, fullUrl: change.to.thumbUrl } : null;
          else {
            const patch = { [change.field]: change.to };
            if (!validatePatch(patch, true)) return failure('invalidAction', '候选数据格式无效。');
            Object.assign(album, patch);
          }
          album.revision++;
          if (change.userEdited && !album.userEditedFields.includes(change.field)) album.userEditedFields.push(change.field);
          album.metadataStatus = 'matched';
        }
        library.revision++;
        publish({ library, metadataReview: null }); return applied;
      }
      case 'closeMetadataReview': publish({ metadataReview: null }); return applied;
      case 'importFolder': return failure('unsupported', '演示不会读取真实文件夹，原生导入由 Codex 后续接入。');
      case 'rescanLibrary': return startTask('scan', '演示重新扫描', (_signal, active) => {
        if (active()) publish({ library: { ...state.library, revision: state.library.revision + 1,
          tracks: state.library.tracks.map(t => t.available ? t : { ...t, available: true }) } });
      });
      case 'cancelTask': {
        const worker = workers.get(action.taskId);
        if (!worker) return failure('notFound', '任务已结束。');
        const task = state.tasks.find(t => t.id === action.taskId);
        worker.controller.abort(); finishTask(action.taskId);
        if (task?.label === '搜索歌词候选') { preparedLyrics = null; publish({ lyricsReview: null }); }
        if (task?.kind === 'lyrics' && task.trackId && documents[task.trackId]) {
          documents[task.trackId] = { ...documents[task.trackId], lookup: 'idle', lookupError: null }; publish();
        }
        if (task?.kind === 'metadata' && state.metadataReview?.albumId === task.albumId) publish({ metadataReview: null });
        return applied;
      }
      case 'dismissNotice': publish({ notices: state.notices.filter(n => n.id !== action.noticeId) }); return applied;
      default: return failure('invalidAction', '不支持的操作。');
    }
  }
  let lastTick = now();
  function advanceBy(ms: number) {
    if (disposed || state.player.status !== 'playing' || !Number.isFinite(ms) || ms < 0 || options.scenario === 'disconnected') return;
    const player = state.player;
    publish({ player: player.positionMs + ms >= player.durationMs ? advance(player, state.library, 'ended') :
      seek(player, player.positionMs + ms) }, true);
  }
  const ticker = options.autoTick === false ? null : setInterval(() => {
    const current = now(), elapsed = Math.max(0, current - lastTick); lastTick = current; advanceBy(elapsed);
  }, 200);
  return {
    connect(surface) {
      const bounded = createBoundedDispatcher(action => handle(action, surface));
      const connection = { surface, cached: materialize(surface), listeners: new Set<() => void>(),
        destroy() { connections.delete(connection); bounded.destroy(); connection.listeners.clear(); } };
      connections.add(connection);
      return { getSnapshot: () => connection.cached, subscribe(listener) { connection.listeners.add(listener);
        return () => { connection.listeners.delete(listener); }; }, dispatch: bounded.dispatch, destroy: connection.destroy };
    },
    advanceBy, requestExit: exitGuard.requestExit,
    destroy() { disposed = true; if (ticker) clearInterval(ticker);
      for (const connection of [...connections]) connection.destroy();
      for (const [id, worker] of workers) { worker.controller.abort(); clearTimeout(worker.deadline); workers.delete(id); } },
  };
}
export function createMockBridge(options: MockBridgeOptions = {}): PlayerBridge {
  const session = options.session ?? createMockSession(options);
  const bridge = session.connect(options.surface ?? 'main');
  return options.session ? bridge : { ...bridge, destroy() { bridge.destroy(); session.destroy(); } };
}

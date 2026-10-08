/**
 * Static state matrix for the preview (Claude, R1 + R1.1). Each scenario is a plain UISnapshot
 * built from the fictional fixtures; nothing here runs a clock, a queue or persistence.
 */
import { CONTRACT_VERSION } from '../src/contracts/player.ts';
import type { HostInfo, LyricsDocument, LyricsEditorState, MetadataReview, Surface, UISnapshot, UserSettings } from '../src/contracts/player.ts';
import { emptyPlayer, loadQueue } from '../src/core/queue.ts';
import { createDemoData } from '../src/mock/fixtures.ts';
import type { DemoScenario } from '../src/mock/fixtures.ts';
import type { UIBoot } from '../src/ui/lib/env.ts';
import { applyDraftAction, applyImport } from '../src/ui/lib/lyricsDraft.ts';
import type { DraftAction, LyricsDraft } from '../src/ui/lib/lyricsDraft.ts';
import { memorialPlatesPatch } from '../src/ui/lib/memorial.ts';
import { themePatch } from '../src/ui/lib/theme.ts';
import { addCoverAlbum, COVER_LABEL } from './stageCovers.ts';
import { candidateRecords, manyRecords, multiSourceRecords, reviewFor } from './lyricsCandidates.ts';
import type { CoverKind } from './stageCovers.ts';
import type { ThemeName } from '../src/ui/lib/theme.ts';

export interface Scenario {
  id: string;
  group: string;
  title: string;
  note?: string;
  surface: Surface;
  width: number;
  height: number;
  /** Paint a desktop wallpaper behind transparent mini windows. */
  desktop?: boolean;
  boot?: UIBoot;
  build(): UISnapshot;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

/** Applies a theme the way the settings sheet does (same patch), for previews and paired screenshots. */
export function withTheme(snapshot: UISnapshot, theme: ThemeName): UISnapshot {
  const patch = themePatch(theme);
  return { ...snapshot, settings: { ...snapshot.settings, ...(patch.background ? { background: patch.background } : {}),
    ui: { ...snapshot.settings.ui, main: { ...snapshot.settings.ui.main, ...patch.ui?.main } } } };
}

export function host(patch: Partial<HostInfo> = {}, capabilities: Partial<HostInfo['capabilities']> = {}): HostInfo {
  return {
    shell: 'browser', windowMode: 'full', surfaceVisible: true, backdrop: 'none', alwaysOnTop: false,
    nativeCornerRadius: 0, effectiveReducedMotion: false, transparencyAllowed: true, coreStatus: 'ready',
    ...patch,
    capabilities: { nativeWindows: false, transparentWindow: false, windowDragging: false, alwaysOnTop: false, ...capabilities },
  };
}

interface BaseOptions {
  data?: DemoScenario;
  settings?: Partial<UserSettings>;
  host?: Partial<HostInfo>;
  capabilities?: Partial<HostInfo['capabilities']>;
}

function base(options: BaseOptions = {}) {
  const data = createDemoData(options.data);
  const snapshot: UISnapshot = {
    contractVersion: CONTRACT_VERSION,
    host: host(options.host, options.capabilities),
    library: data.library,
    player: emptyPlayer(),
    lyrics: null, lyricsEditor: null, metadataReview: null, lyricsReview: null,
    settings: { ...data.settings, ...options.settings },
    notices: [], tasks: [],
  };
  return { snapshot, data };
}

interface PlayOptions extends BaseOptions {
  trackId: string;
  positionMs?: number;
  status?: UISnapshot['player']['status'];
  lyrics?: (doc: LyricsDocument) => LyricsDocument | null;
}

/** A paused (or briefly "playing") snapshot of an album queue at a fixed position. */
function playing(options: PlayOptions) {
  const { snapshot, data } = base(options);
  const track = data.library.tracks.find(t => t.id === options.trackId)!;
  const album = data.library.albums.find(a => a.id === track.albumId)!;
  const start = album.trackIds.indexOf(track.id);
  const loaded = loadQueue(snapshot.player, album.trackIds, data.library, start, 'pv');
  snapshot.player = { ...loaded, status: options.status ?? 'paused', positionMs: options.positionMs ?? 0,
    positionSampledAt: now(), sampleSequence: 1 };
  const doc = data.lyricsByTrack[track.id] ?? null;
  snapshot.lyrics = doc && options.lyrics ? options.lyrics(doc) : doc;
  return { snapshot, data };
}

interface EditOptions extends BaseOptions {
  trackId: string;
  /** Track that is playing (paused unless status says otherwise); none when omitted. */
  play?: string;
  positionMs?: number;
  status?: UISnapshot['player']['status'];
  doc?: (doc: LyricsDocument) => LyricsDocument;
  editorStatus?: LyricsEditorState['status'];
}
/** A snapshot with the lyrics editor open for `trackId`. */
function editing(options: EditOptions): UISnapshot {
  const { snapshot, data } = options.play
    ? playing({ ...options, trackId: options.play })
    : base(options);
  const original = data.lyricsByTrack[options.trackId];
  const document = options.doc ? options.doc(original) : original;
  return { ...snapshot, lyricsEditor: { trackId: options.trackId, status: options.editorStatus ?? 'ready', document,
    error: options.editorStatus === 'conflict' ? { code: 'conflict', message: '资料已变化。' } : null, pendingImport: null } };
}
/** Applies draft edits by line position, the way a user would in the editor. */
const edits = (...steps: ((draft: LyricsDraft) => DraftAction)[]) => (draft: LyricsDraft) =>
  steps.reduce((d, step) => applyDraftAction(d, step(d)), draft);
const line = (i: number) => (d: LyricsDraft) => d.lines[i].id;

const W = 1280, H = 800;
const S = (s: Omit<Scenario, 'width' | 'height' | 'surface'> & Partial<Pick<Scenario, 'width' | 'height' | 'surface'>>): Scenario =>
  ({ surface: 'main', width: W, height: H, ...s });

const demoNotice = { id: 'n-demo', tone: 'info' as const, message: '界面开发演示：模拟进度，不输出声音，不访问真实文件或服务。' };

function review(albumId: string, protectedTitle: boolean): MetadataReview {
  const { data } = base();
  const album = data.library.albums.find(a => a.id === albumId)!;
  return {
    id: 'rv-1', albumId, baseLibraryRevision: 0, status: 'ready', error: null,
    candidates: [
      {
        id: 'c-1', provider: '虚构资料库', match: 'discId', title: album.title, albumArtistCredit: album.albumArtistCredit,
        releaseYear: 2026, catalogNumber: 'DEMO-001', discCount: 1, trackCount: 3, coverThumbUrl: '/covers/blue.svg',
        notes: ['光盘 ID 来自抓轨日志中的完整目录。'],
        changes: [
          { id: 'ch-1', target: 'album', albumId, field: 'title', from: protectedTitle ? '蒼い窓辺 OST（自分で整理）' : album.title, to: '蒼い窓辺 オリジナル・サウンドトラック', userEdited: protectedTitle },
          { id: 'ch-2', target: 'album', albumId, field: 'label', from: null, to: '架空レコード', userEdited: false },
          { id: 'ch-4', target: 'album', albumId, field: 'cover', from: { thumbUrl: '/covers/blue.svg' }, to: { thumbUrl: '/covers/white.svg', width: 600, height: 600 }, userEdited: true },
          { id: 'ch-5', target: 'track', trackId: 'track-tv', field: 'versionLabel', from: 'TV size', to: 'TV Size ver.', userEdited: false },
        ],
      },
      {
        id: 'c-2', provider: '虚构资料库', match: 'text', title: '蒼い窓辺 Original Soundtrack (通常盤)', albumArtistCredit: album.albumArtistCredit,
        releaseYear: 2026, catalogNumber: 'DEMO-002', discCount: 1, trackCount: 4, notes: ['曲目数不同（4 首，本地 3 首）。'],
        changes: [{ id: 'ch-9', target: 'album', albumId, field: 'catalogNumber', from: 'DEMO-001', to: 'DEMO-002', userEdited: false }],
      },
    ],
  };
}

export const SCENARIOS: Scenario[] = [
  // ── 收藏 ─────────────────────────────────────────────
  S({ id: 'library', group: '收藏', title: '专辑书架（播放中）', build: () => {
    const { snapshot } = playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' });
    return { ...snapshot, notices: [demoNotice] };
  } }),
  S({ id: 'library-works', group: '收藏', title: '按作品分组', boot: { libraryTab: 'works' },
    build: () => playing({ trackId: 'track-soda', positionMs: 30000 }).snapshot }),
  S({ id: 'library-artists', group: '收藏', title: '按艺术家分组', boot: { libraryTab: 'artists' }, build: () => base().snapshot }),
  S({ id: 'library-search', group: '收藏', title: '搜索：CV 名字', boot: { query: '月野' }, build: () => base().snapshot }),
  S({ id: 'library-search-kana', group: '收藏', title: '搜索：平假名找片假名', note: '“そーだ”可以找到“ソーダ”。', boot: { query: 'そーだ' }, build: () => base().snapshot }),
  S({ id: 'library-search-none', group: '收藏', title: '搜索没有结果', boot: { query: 'まぼろし' }, build: () => base().snapshot }),
  S({ id: 'library-empty', group: '收藏', title: '空资料库（首次启动）', build: () => base({ data: 'empty' }).snapshot }),
  S({ id: 'library-large', group: '收藏', title: '300 首（20 张）', build: () => base({ data: 'large' }).snapshot }),
  S({ id: 'library-tasks', group: '收藏', title: '后台任务与通知', build: () => {
    const { snapshot } = playing({ trackId: 'track-soda', positionMs: 52000 });
    return { ...snapshot,
      tasks: [{ id: 't1', kind: 'import', status: 'running', label: '正在导入“Anime OST 2024”', progress: 0.42, cancellable: true },
        { id: 't2', kind: 'metadata', status: 'queued', label: '查找专辑资料', cancellable: true }],
      notices: [
        { id: 'n1', tone: 'warning', message: '有 2 首曲目的文件暂时找不到，可能是外接硬盘没有连接。', action: { label: '重新扫描', action: { type: 'rescanLibrary' } } },
        { id: 'n2', tone: 'error', message: '“星海航路”的资料查找没有完成：网络暂时不可用。' },
      ] };
  } }),
  S({ id: 'library-offline', group: '收藏', title: '播放核心没有响应', build: () => base({ host: { coreStatus: 'unresponsive' } }).snapshot }),
  S({ id: 'library-blue', group: '收藏', title: '浅蓝背景', build: () => playing({ trackId: 'track-blue', positionMs: 64000, settings: { background: 'blue' } }).snapshot }),
  S({ id: 'library-accent', group: '收藏', title: '自定义强调色（樱色）', build: () => playing({ trackId: 'track-spring', positionMs: 20000, settings: { accentColor: '#E0628F' } }).snapshot }),
  S({ id: 'library-960', group: '收藏', title: '最小窗口 960×600', width: 960, height: 600,
    build: () => playing({ trackId: 'track-blue', positionMs: 64000 }).snapshot }),
  S({ id: 'library-font', group: '收藏', title: '界面字号 130%', build: () => playing({ trackId: 'track-blue', positionMs: 64000, settings: { fontScale: 1.3 } }).snapshot }),

  // ── 专辑 ─────────────────────────────────────────────
  S({ id: 'album', group: '专辑', title: '专辑详情（正在播放）', boot: { route: { name: 'album', albumId: 'album-blue' } },
    build: () => playing({ trackId: 'track-tv', positionMs: 31000, status: 'playing' }).snapshot }),
  S({ id: 'album-multidisc', group: '专辑', title: '两张碟、碟片副标题、纯音乐', boot: { route: { name: 'album', albumId: 'album-starsea' } },
    build: () => base().snapshot }),
  S({ id: 'album-drama', group: '专辑', title: '广播剧：念白与角色 CV 署名', boot: { route: { name: 'album', albumId: 'album-radio' } },
    build: () => base().snapshot }),
  S({ id: 'album-nocover', group: '专辑', title: '没有封面', boot: { route: { name: 'album', albumId: 'album-no-cover' } },
    build: () => base().snapshot }),
  S({ id: 'album-unavailable', group: '专辑', title: '文件不可用', boot: { route: { name: 'album', albumId: 'album-blue' } },
    build: () => base({ data: 'unavailable' }).snapshot }),
  S({ id: 'album-edited', group: '专辑', title: '手动修改过的资料', boot: { route: { name: 'album', albumId: 'album-spring' } },
    build: () => base().snapshot }),
  S({ id: 'album-960', group: '专辑', title: '960×600', width: 960, height: 600, boot: { route: { name: 'album', albumId: 'album-soda' } },
    build: () => playing({ trackId: 'track-soda', positionMs: 20000 }).snapshot }),

  // ── 正在播放 ─────────────────────────────────────────
  S({ id: 'np', group: '正在播放', title: '双语歌词（播放中）', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-blue', positionMs: 79000, status: 'playing' }).snapshot }),
  S({ id: 'np-original', group: '正在播放', title: '只看原文', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-blue', positionMs: 79000, settings: { lyricsMode: 'original' } }).snapshot }),
  S({ id: 'np-break', group: '正在播放', title: '间奏：不高亮任何一句', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-blue', positionMs: 61000 }).snapshot }),
  S({ id: 'np-partial', group: '正在播放', title: '部分翻译', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-spring', positionMs: 20000 }).snapshot }),
  S({ id: 'np-no-translation', group: '正在播放', title: '双语模式但没有译文', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-rain-blue', positionMs: 30000 }).snapshot }),
  S({ id: 'np-plain', group: '正在播放', title: '未同步歌词', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-soda-promise', positionMs: 40000 }).snapshot }),
  S({ id: 'np-instrumental', group: '正在播放', title: '纯音乐', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-sea-morning', positionMs: 40000 }).snapshot }),
  S({ id: 'np-spoken', group: '正在播放', title: '念白（广播剧）', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-radio-drama', positionMs: 420000 }).snapshot }),
  S({ id: 'np-missing', group: '正在播放', title: '暂无歌词', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-sea-chart', positionMs: 40000 }).snapshot }),
  S({ id: 'np-searching', group: '正在播放', title: '正在查找歌词', boot: { route: { name: 'nowPlaying' } }, build: () => {
    const { snapshot } = playing({ trackId: 'track-sea-chart', positionMs: 40000, lyrics: d => ({ ...d, lookup: 'searching' }) });
    return { ...snapshot, tasks: [{ id: 'tl', kind: 'lyrics', status: 'running', label: '查找歌词', cancellable: true, trackId: 'track-sea-chart' }] };
  } }),
  S({ id: 'np-notfound', group: '正在播放', title: '没有找到歌词', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-sea-chart', positionMs: 40000, lyrics: d => ({ ...d, lookup: 'notFound' }) }).snapshot }),
  S({ id: 'np-failed', group: '正在播放', title: '歌词查找失败', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-sea-chart', positionMs: 40000,
      lyrics: d => ({ ...d, lookup: 'failed', lookupError: { code: 'network', message: '歌词服务暂时无法访问。' } }) }).snapshot }),
  S({ id: 'np-search-keep', group: '正在播放', title: '查找译文时保留原文', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-rain-blue', positionMs: 30000, lyrics: d => ({ ...d, lookup: 'searching' }) }).snapshot }),
  S({ id: 'np-loading', group: '正在播放', title: '歌词载入中', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-soda', positionMs: 1000, lyrics: () => null }).snapshot }),
  S({ id: 'np-locked', group: '正在播放', title: '已锁定、偏移 +0.3s、解析提示', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-soda', positionMs: 50000, lyrics: d => ({ ...d, offsetMs: 300,
      warnings: ['有 1 行译文的时间和原文相差超过 0.1 秒，没有自动配对。', '文件 offset 已折算进时间轴。'] }) }).snapshot }),
  S({ id: 'np-buffering', group: '正在播放', title: '缓冲中', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-blue', positionMs: 15000, status: 'buffering' }).snapshot }),
  S({ id: 'np-error', group: '正在播放', title: '播放出错', boot: { route: { name: 'nowPlaying' } }, build: () => {
    const { snapshot } = playing({ trackId: 'track-blue', positionMs: 15000 });
    return { ...snapshot, player: { ...snapshot.player, status: 'error', error: { code: 'decode', message: '这首曲目无法解码，文件可能已损坏。', trackId: 'track-blue' } } };
  } }),
  S({ id: 'np-album', group: '正在播放', title: '本专辑', boot: { route: { name: 'nowPlaying' }, nowPlayingTab: 'album' },
    build: () => playing({ trackId: 'track-sea-chart', positionMs: 40000 }).snapshot }),
  S({ id: 'np-queue', group: '正在播放', title: '播放队列', boot: { route: { name: 'nowPlaying' }, nowPlayingTab: 'queue' },
    build: () => playing({ trackId: 'track-soda-promise', positionMs: 40000 }).snapshot }),
  S({ id: 'np-queue-dup', group: '正在播放', title: '队列：同一首加入两次、随机与循环（R2）', boot: { route: { name: 'nowPlaying' }, nowPlayingTab: 'queue' },
    note: '同一首歌加入两次是两个独立条目（按条目 ID 区分）。左侧把手拖动排序，把手上按 ↑/↓ 或行内 Alt+↑/↓ 也可以移动。',
    build: () => {
      const { snapshot } = playing({ trackId: 'track-soda-promise', positionMs: 40000, status: 'playing' });
      const extra = [['pv-dup-a', 'track-soda'], ['pv-dup-b', 'track-blue'], ['pv-dup-c', 'track-soda-promise']]
        .map(([id, trackId], k) => ({ id, trackId, originalOrder: snapshot.player.queue.length + k }));
      return { ...snapshot, player: { ...snapshot.player, queue: [...snapshot.player.queue, ...extra], shuffle: true, repeat: 'all' } };
    } }),
  S({ id: 'np-queue-ended', group: '正在播放', title: '队列已播完：从头播放（R2）', boot: { route: { name: 'nowPlaying' }, nowPlayingTab: 'queue' },
    build: () => {
      const { snapshot } = playing({ trackId: 'track-soda-off', positionMs: 248000 });
      return { ...snapshot, player: { ...snapshot.player, positionMs: snapshot.player.durationMs } };
    } }),
  S({ id: 'np-disc', group: '正在播放', title: '显示光盘（可选）', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-soda', positionMs: 50000, settings: { showDiscAnimation: true } }).snapshot }),
  S({ id: 'np-blue', group: '正在播放', title: '浅蓝背景', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-blue', positionMs: 79000, settings: { background: 'blue' } }).snapshot }),
  S({ id: 'np-large-lyrics', group: '正在播放', title: '歌词字号 140%', boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-blue', positionMs: 79000, settings: { lyricsScale: 1.4 } }).snapshot }),
  S({ id: 'np-960', group: '正在播放', title: '960×600（单栏）', width: 960, height: 600, boot: { route: { name: 'nowPlaying' } },
    build: () => playing({ trackId: 'track-radio-ed', positionMs: 33000 }).snapshot }),
  S({ id: 'np-idle', group: '正在播放', title: '没有在播放', boot: { route: { name: 'nowPlaying' } }, build: () => base().snapshot }),

  // ── 面板 ─────────────────────────────────────────────
  S({ id: 'settings', group: '面板', title: '设置', boot: { overlay: 'settings' },
    build: () => playing({ trackId: 'track-blue', positionMs: 64000 }).snapshot }),
  S({ id: 'metadata', group: '面板', title: '资料候选：逐项确认', boot: { route: { name: 'album', albumId: 'album-blue' } },
    build: () => ({ ...base().snapshot, metadataReview: review('album-blue', true) }) }),
  S({ id: 'metadata-searching', group: '面板', title: '资料候选：查找中', boot: { route: { name: 'album', albumId: 'album-rain' } },
    build: () => ({ ...base().snapshot, metadataReview: { id: 'rv-2', albumId: 'album-rain', baseLibraryRevision: 0, status: 'searching', candidates: [], error: null } }) }),

  // ── 歌词编辑（R2）────────────────────────────────────
  ...editorScenarios(),

  // ── 资料编辑（R2）────────────────────────────────────
  ...metadataScenarios(),

  // ── 迷你 ─────────────────────────────────────────────
  S({ id: 'mini', group: '迷你', title: '迷你：透明窗口', surface: 'mini', width: 384, height: 116, desktop: true,
    build: () => playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing',
      host: { shell: 'tauri', windowMode: 'mini' }, capabilities: { transparentWindow: true, nativeWindows: true, windowDragging: true } }).snapshot }),
  S({ id: 'mini-lyrics', group: '迷你', title: '迷你：显示当前歌词', surface: 'mini', width: 384, height: 164, desktop: true,
    build: () => playing({ trackId: 'track-blue', positionMs: 79000, settings: { miniShowLyrics: true },
      host: { shell: 'tauri', windowMode: 'mini' }, capabilities: { transparentWindow: true, nativeWindows: true } }).snapshot }),
  S({ id: 'mini-controls', group: '迷你', title: '迷你：悬停时的窗口按钮', surface: 'mini', width: 384, height: 116, desktop: true,
    boot: { miniShowControls: true },
    build: () => playing({ trackId: 'track-spring', positionMs: 20000, host: { shell: 'tauri', windowMode: 'mini', alwaysOnTop: true },
      capabilities: { transparentWindow: true, nativeWindows: true } }).snapshot }),
  S({ id: 'mini-opaque', group: '迷你', title: '迷你：不透明（Win11 圆角 8）', surface: 'mini', width: 360, height: 92, desktop: true,
    build: () => playing({ trackId: 'track-soda', positionMs: 50000, host: { shell: 'tauri', windowMode: 'mini', nativeCornerRadius: 8 },
      capabilities: { transparentWindow: false, nativeWindows: true } }).snapshot }),
  S({ id: 'mini-opaque-square', group: '迷你', title: '迷你：不透明（无圆角）', surface: 'mini', width: 360, height: 140, desktop: true,
    build: () => playing({ trackId: 'track-radio-ed', positionMs: 33000, settings: { miniShowLyrics: true },
      host: { shell: 'tauri', windowMode: 'mini', nativeCornerRadius: 0 }, capabilities: { transparentWindow: false, nativeWindows: true } }).snapshot }),
  S({ id: 'mini-idle', group: '迷你', title: '迷你：没有在播放', surface: 'mini', width: 384, height: 116, desktop: true,
    build: () => base({ host: { shell: 'tauri', windowMode: 'mini' }, capabilities: { transparentWindow: true, nativeWindows: true } }).snapshot }),
  S({ id: 'mini-blue', group: '迷你', title: '迷你：浅蓝背景', surface: 'mini', width: 384, height: 164, desktop: true,
    build: () => playing({ trackId: 'track-soda', positionMs: 50000, settings: { background: 'blue', miniShowLyrics: true },
      host: { shell: 'tauri', windowMode: 'mini' }, capabilities: { transparentWindow: true, nativeWindows: true } }).snapshot }),

  ...comparisons(),
  ...legibility(),
  ...removal(),
  ...lyricCandidates(),
  ...memorial(),
];

function editorScenarios(): Scenario[] {
  const g = '歌词编辑';
  const np = { route: { name: 'nowPlaying' as const } };
  const blueAlbum = { route: { name: 'album' as const, albumId: 'album-blue' } };
  const dirtyBlue = edits(
    d => ({ type: 'text', id: line(2)(d), field: 'original', value: '今日のページをひらこう' }),
    d => ({ type: 'text', id: line(2)(d), field: 'translation', value: '翻开属于今天的这一页' }),
    d => ({ type: 'time', id: line(4)(d), effectiveMs: 33800 }),
  );
  /** An older saved version: someone else changed line 2 and the offset after this draft started. */
  const older = (doc: LyricsDocument): LyricsDocument => ({ ...createDemoData().lyricsByTrack[doc.trackId], revision: doc.revision - 1 });
  const latest = (doc: LyricsDocument): LyricsDocument => ({ ...doc, revision: doc.revision + 1, offsetMs: 200,
    lines: doc.lines.map((l, i) => i === 1 ? { ...l, translation: '把一点点光放在掌心' } : i === 9 ? { ...l, startMs: 85600 } : l) });
  return [
    S({ id: 'ed', group: g, title: '双语同步歌词（正在播放这首）', boot: np,
      note: '时间显示为“听到的时间”（startMs + 偏移）。左侧细线标出此刻正在唱的一行；行工具在悬停或聚焦时出现。',
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000, status: 'playing' }) }),
    S({ id: 'ed-dirty', group: g, title: '未保存修改与就地校验', boot: { ...np, lyricsEditor: { edit: dirtyBlue, showIssues: true } },
      note: '第 3 行改了原文与译文；第 5 行的时间早于上一行，保存前就地标出，保存按钮会先校验。',
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000 }) }),
    S({ id: 'ed-tap', group: g, title: '打轴：当前曲目', boot: { ...np, lyricsEditor: { mode: 'tap', cursorIndex: 9 } },
      note: '空格在光标行记下“此刻听到的时间 − 偏移”，光标自动下移。撤销上一点用 Ctrl+Z。',
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 70400, status: 'playing' }) }),
    S({ id: 'ed-tap-other', group: g, title: '打轴：不是正在播放的曲目', boot: { ...blueAlbum, lyricsEditor: { mode: 'tap', edit: edits(() => ({ type: 'kind', kind: 'synced' })) } },
      note: '打开编辑器不会换曲；需要用户明确点“播放这首”。',
      build: () => editing({ trackId: 'track-plain', play: 'track-blue', positionMs: 64000 }) }),
    S({ id: 'ed-negative', group: g, title: '负时间、间奏与整体偏移', boot: np,
      note: '第一行在 0 之前（−0:00.40），空白同步行是间奏边界；偏移不为 0 时可“合并到时间轴”。',
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 52000,
        doc: d => ({ ...d, offsetMs: 300, lines: [{ id: 'pre', startMs: -700, original: '（イントロ）', translation: '（前奏）' }, ...d.lines] }) }) }),
    S({ id: 'ed-conflict', group: g, title: '保存冲突：草稿保留', boot: { ...np, lyricsEditor: { base: older, edit: dirtyBlue } },
      note: '别处保存了新版本。草稿原样保留；可以比较、载入最新，或明确地用草稿覆盖（以最新版本号重新提交）。',
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000, editorStatus: 'conflict', doc: latest }) }),
    S({ id: 'ed-compare', group: g, title: '冲突比较：原文、译文、时间、偏移', boot: { ...np, lyricsEditor: { base: older, edit: dirtyBlue, view: 'compare' } },
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000, editorStatus: 'conflict', doc: latest }) }),
    S({ id: 'ed-overwrite', group: g, title: '冲突：确认用草稿覆盖', boot: { ...np, lyricsEditor: { base: older, edit: dirtyBlue, confirm: 'overwrite' } },
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000, editorStatus: 'conflict', doc: latest }) }),
    S({ id: 'ed-import', group: g, title: '导入译文：配对结果与警告', boot: { ...np, lyricsEditor: {
      edit: edits(...[0, 1, 2, 3].map(i => (d: LyricsDraft) => ({ type: 'text' as const, id: d.lines[i].id, field: 'translation' as const, value: '' }))),
      note: { message: '已按时间配对 13 行译文。', warnings: ['2 行译文无法安全配对，请人工核对。'], canAlign: false } } },
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 30000 }) }),
    S({ id: 'ed-import-plain', group: g, title: '导入纯文本译文：等待确认按行对齐', boot: { ...blueAlbum, lyricsEditor: {
      note: { message: '原文或译文没有时间，无法按时间配对。可以确认后按行对齐。', warnings: ['未同步译文需要用户明确进行人工配对。'], canAlign: true }, confirm: 'align' } },
      build: () => editing({ trackId: 'track-plain', play: 'track-blue', positionMs: 64000 }) }),
    S({ id: 'ed-plain', group: g, title: '纯文本歌词', boot: blueAlbum,
      build: () => editing({ trackId: 'track-soda-promise', play: 'track-blue', positionMs: 64000 }) }),
    S({ id: 'ed-empty', group: g, title: '还没有歌词', boot: { route: { name: 'album', albumId: 'album-starsea' } },
      build: () => editing({ trackId: 'track-sea-chart' }) }),
    S({ id: 'ed-marked', group: g, title: '已标记为纯音乐', boot: { route: { name: 'album', albumId: 'album-starsea' } },
      build: () => editing({ trackId: 'track-sea-morning' }) }),
    S({ id: 'ed-close', group: g, title: '关闭前：保存或放弃', boot: { ...np, lyricsEditor: { edit: dirtyBlue, closing: true } },
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000 }) }),
    S({ id: 'ed-loading', group: g, title: '载入中', boot: np, build: () => {
      const snapshot = playing({ trackId: 'track-blue', positionMs: 79000 }).snapshot;
      return { ...snapshot, lyricsEditor: { trackId: 'track-blue', status: 'loading', document: null, error: null, pendingImport: null } };
    } }),
    S({ id: 'ed-960', group: g, title: '960×600', width: 960, height: 600, boot: { ...np, lyricsEditor: { edit: dirtyBlue } },
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000, status: 'playing' }) }),
  ];
}

function metadataScenarios(): Scenario[] {
  const g = '资料编辑';
  const at = (albumId: string) => ({ route: { name: 'album' as const, albumId } });
  return [
    S({ id: 'meta-album', group: g, title: '专辑资料（有手动修改的字段）', note: '锁形“手动”标记的字段，自动查找资料不会覆盖。封面经桥接选择后立即保存。',
      boot: { ...at('album-spring'), metadataEditor: { albumId: 'album-spring' } }, build: () => base().snapshot }),
    S({ id: 'meta-track', group: g, title: '曲目：多位歌手与 CV 署名', boot: { ...at('album-radio'), metadataEditor: { albumId: 'album-radio', select: 'track-radio-ed' } },
      build: () => base().snapshot }),
    S({ id: 'meta-dirty', group: g, title: '未保存修改与就地校验', note: '必填项为空、年份格式不对时就地标出，保存按钮先校验；两首曲号相同只提醒不拦截。',
      boot: { ...at('album-blue'), metadataEditor: { albumId: 'album-blue', select: 'track-tv',
        editAlbum: f => ({ ...f, releaseYear: '２０２６年' }),
        editTrack: (f, t) => t.id === 'track-tv' ? { ...f, artistCredit: '', trackNumber: '1', versionLabel: 'TV size ver.' } : f } },
      build: () => base().snapshot }),
    S({ id: 'meta-multi', group: g, title: '两张碟与碟片标题', boot: { ...at('album-starsea'), metadataEditor: { albumId: 'album-starsea' } },
      build: () => base().snapshot }),
    S({ id: 'meta-conflict', group: g, title: '保存冲突：逐字段比较', note: '别处改了厂牌和年份，你也改了厂牌：标出“双方都改”，由你决定载入最新或覆盖。',
      boot: { ...at('album-blue'), metadataEditor: { albumId: 'album-blue', compare: 'album',
        staleAlbum: a => ({ ...a, revision: a.revision - 1, label: '架空レコード', releaseYear: 2026 }),
        editAlbum: f => ({ ...f, label: '架空レコード（自主制作）', catalogNumber: 'DEMO-001A' }) } },
      build: () => {
        const { snapshot } = base();
        return { ...snapshot, library: { ...snapshot.library, albums: snapshot.library.albums.map(a => a.id === 'album-blue'
          ? { ...a, revision: a.revision + 1, label: '架空レコード東京', releaseYear: 2025 } : a) } };
      } }),
    S({ id: 'meta-close', group: g, title: '关闭前：保存或放弃', boot: { ...at('album-soda'), metadataEditor: { albumId: 'album-soda', select: 'track-soda-tv', closing: true,
      editTrack: (f, t) => t.id === 'track-soda-tv' ? { ...f, versionLabel: 'TV size ver.' } : f } },
      build: () => base().snapshot }),
    S({ id: 'meta-960', group: g, title: '960×600', width: 960, height: 600,
      boot: { ...at('album-blue'), metadataEditor: { albumId: 'album-blue', select: 'track-blue' } }, build: () => base().snapshot }),
  ];
}

/**
 * R1.1 paired scenarios: the same track, layout and size in each theme, so materials can be
 * compared fairly. 纸白 is included as the reference.
 */
function comparisons(): Scenario[] {
  const themes: [ThemeName, string][] = [['light', '纸白'], ['blue', '阿根廷蓝'], ['charcoal', '灰黑']];
  const out: Scenario[] = [];
  const miniHost = (backdrop: HostInfo['backdrop']) => ({ host: { shell: 'tauri' as const, windowMode: 'mini' as const, backdrop,
    nativeCornerRadius: backdrop === 'none' ? 0 as const : 8 as const },
    capabilities: { transparentWindow: true, nativeWindows: true, windowDragging: true } });
  for (const [theme, label] of themes) {
    const t = (snapshot: UISnapshot) => withTheme(snapshot, theme);
    const g = '主题对比';
    out.push(
      S({ id: `cmp-stage-${theme}`, group: g, title: `收藏首屏（舞台）1280×800 · ${label}`,
        note: '播放器里的专辑登上舞台：封面化作背景的光，盘面印着封面、播放时转动。',
        build: () => t(playing({ trackId: 'track-soda', positionMs: 64000, status: 'playing' }).snapshot) }),
      S({ id: `cmp-stage-960-${theme}`, group: g, title: `收藏首屏 960×600 · ${label}`, width: 960, height: 600,
        build: () => t(base().snapshot) }),
      S({ id: `cmp-mica-${theme}`, group: g, title: `主窗口在 Mica 上 · ${label}`, desktop: true,
        note: '宿主报告 backdrop: mica：纸面变薄透出系统材质，舞台与封面仍是实的。浏览器里用示意桌面代替 Mica。',
        build: () => t(playing({ trackId: 'track-soda', positionMs: 64000, status: 'playing',
          host: { shell: 'tauri', backdrop: 'mica' }, capabilities: { transparentWindow: true } }).snapshot) }),
      S({ id: `cmp-mica-shelf-${theme}`, group: g, title: `Mica 上书架滚到顶栏下 · ${label}`, desktop: true, boot: { scrollTop: 401 },
        note: 'Mica 下纸面是半透明的。顶栏先用纸色把模糊补成不透明，滚到下面的统计行和封面只留下模糊的颜色，不再透出清晰的字。',
        build: () => t(coverSnapshot('night', 'playing', { data: 'large',
          host: { shell: 'tauri', backdrop: 'mica' }, capabilities: { transparentWindow: true } }).snapshot) }),
      S({ id: `cmp-library-${theme}`, group: g, title: `收藏 1280×800 · ${label}`, boot: { scrollTop: 150 },
        note: '书架已向下滚动：顶栏与播放胶囊浮在封面上方，可以看到玻璃的透光与层次。',
        build: () => t(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' }).snapshot) }),
      S({ id: `cmp-library-960-${theme}`, group: g, title: `收藏 960×600 · ${label}`, width: 960, height: 600, boot: { scrollTop: 120 },
        build: () => t(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' }).snapshot) }),
      S({ id: `cmp-np-${theme}`, group: g, title: `正在播放 1280×800 · ${label}`, boot: { route: { name: 'nowPlaying' } },
        build: () => t(playing({ trackId: 'track-blue', positionMs: 79000, status: 'playing' }).snapshot) }),
      S({ id: `cmp-np-960-${theme}`, group: g, title: `正在播放 960×600 · ${label}`, width: 960, height: 600, boot: { route: { name: 'nowPlaying' } },
        build: () => t(playing({ trackId: 'track-blue', positionMs: 79000, status: 'playing' }).snapshot) }),
      S({ id: `cmp-album-${theme}`, group: g, title: `专辑详情 1280×800 · ${label}`, boot: { route: { name: 'album', albumId: 'album-soda' } },
        build: () => t(playing({ trackId: 'track-soda-tv', positionMs: 31000, status: 'playing' }).snapshot) }),
      S({ id: `cmp-settings-${theme}`, group: g, title: `设置 1280×800 · ${label}`, boot: { overlay: 'settings' },
        build: () => t(playing({ trackId: 'track-blue', positionMs: 64000 }).snapshot) }),
      S({ id: `cmp-mini-${theme}`, group: g, title: `迷你 360×92（Acrylic 提案）· ${label}`, surface: 'mini', width: 360, height: 92, desktop: true,
        note: 'R2.1 提案：宿主提供 Acrylic 时，卡片铺满 360×92 客户区，不留透明边，圆角与阴影由系统窗口提供（8px）。浏览器里用 CSS 模糊示意，不代表原生效果。',
        build: () => t(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing', ...miniHost('acrylic') }).snapshot) }),
      S({ id: `cmp-mini-lyrics-${theme}`, group: g, title: `迷你 360×140（歌词，Acrylic 提案）· ${label}`, surface: 'mini', width: 360, height: 140, desktop: true,
        build: () => t(playing({ trackId: 'track-blue', positionMs: 79000, settings: { miniShowLyrics: true }, ...miniHost('acrylic') }).snapshot) }),
      S({ id: `cmp-mini-solid-${theme}`, group: g, title: `迷你：没有原生材质时 · ${label}`, surface: 'mini', width: 384, height: 116, desktop: true,
        note: '透明窗口但宿主没有提供 Acrylic：卡片接近不透明，保证文字在任何桌面上都可读。',
        build: () => t(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing', ...miniHost('none') }).snapshot) }),
      S({ id: `cmp-solid-${theme}`, group: g, title: `玻璃强度 0（实色）· ${label}`, boot: { scrollTop: 150 },
        build: () => t(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing', settings: { glassIntensity: 0 } }).snapshot) }),
      S({ id: `cmp-editor-${theme}`, group: g, title: `歌词编辑 1280×800 · ${label}`, boot: { route: { name: 'nowPlaying' } },
        build: () => t(editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000, status: 'playing' })) }),
      S({ id: `cmp-editor-960-${theme}`, group: g, title: `歌词编辑 960×600（冲突）· ${label}`, width: 960, height: 600,
        boot: { route: { name: 'nowPlaying' }, lyricsEditor: { base: doc => ({ ...doc, revision: doc.revision - 1, offsetMs: 0 }),
          edit: edits(d => ({ type: 'text', id: d.lines[2].id, field: 'original', value: '今日のページをひらこう' })) } },
        build: () => t(editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 79000, editorStatus: 'conflict',
          doc: doc => ({ ...doc, revision: doc.revision + 1, offsetMs: 200 }) })) }),
      S({ id: `cmp-meta-${theme}`, group: g, title: `资料编辑 1280×800 · ${label}`,
        boot: { route: { name: 'album', albumId: 'album-radio' }, metadataEditor: { albumId: 'album-radio', select: 'track-radio-ed',
          editTrack: (f, tr) => tr.id === 'track-radio-ed' ? { ...f, versionLabel: 'Drama ver.' } : f } },
        build: () => t(base().snapshot) }),
      S({ id: `cmp-meta-960-${theme}`, group: g, title: `资料编辑 960×600 · ${label}`, width: 960, height: 600,
        boot: { route: { name: 'album', albumId: 'album-spring' }, metadataEditor: { albumId: 'album-spring' } },
        build: () => t(base().snapshot) }),
      S({ id: `cmp-notrans-${theme}`, group: g, title: `系统关闭透明效果 · ${label}`, boot: { route: { name: 'nowPlaying' } },
        build: () => t(playing({ trackId: 'track-blue', positionMs: 79000, host: { transparencyAllowed: false } }).snapshot) }),
    );
  }
  return out;
}

/**
 * R2.2: text over a cover's light. Original covers at the extremes (near-black with thin white
 * type, near-white, mid grey, saturated red, bright yellow) on the stage in each playback state,
 * and the near-black one through the album page, the player capsule and the mini window.
 */
function coverSnapshot(kind: CoverKind, mode: 'playing' | 'paused' | 'new', options: BaseOptions = {}) {
  const { snapshot } = base(options);
  const { albumId } = addCoverAlbum(snapshot.library, kind);
  if (mode !== 'new') {
    const album = snapshot.library.albums.find(a => a.id === albumId)!;
    const loaded = loadQueue(snapshot.player, album.trackIds, snapshot.library, 0, 'pv');
    snapshot.player = { ...loaded, status: mode, positionMs: 64000, positionSampledAt: now(), sampleSequence: 1 };
  }
  return { snapshot, albumId };
}

function legibility(): Scenario[] {
  const themes: [ThemeName, string][] = [['light', '纸白'], ['blue', '阿根廷蓝'], ['charcoal', '灰黑']];
  const MODE = { playing: '播放中', paused: '已暂停', new: '未播放（新入架）' } as const;
  const stage: [CoverKind, keyof typeof MODE][] = [['night', 'paused'], ['night', 'playing'], ['snow', 'playing'], ['ash', 'new'], ['ember', 'paused'], ['citrus', 'new']];
  const out: Scenario[] = [];
  const g = '封面与文字';
  for (const [theme, label] of themes) {
    const t = (snapshot: UISnapshot) => withTheme(snapshot, theme);
    for (const [kind, mode] of stage) {
      out.push(S({ id: `stage-${kind}-${mode}-${theme}`, group: g, title: `舞台 · ${COVER_LABEL[kind]}封面 · ${MODE[mode]} · ${label}`,
        note: '状态、作品名、署名和资料在磨砂底面上，按全黑与全白封面推算颜色，任何封面上都不低于 4.5:1。',
        build: () => t(coverSnapshot(kind, mode).snapshot) }));
    }
    out.push(
      S({ id: `stage-night-960-${theme}`, group: g, title: `舞台 960×600 · 近黑封面 · 已暂停 · ${label}`, width: 960, height: 600,
        build: () => t(coverSnapshot('night', 'paused').snapshot) }),
      S({ id: `album-night-${theme}`, group: g, title: `专辑页 · 近黑封面 · ${label}`, boot: { route: { name: 'album', albumId: 'album-pv-night' } },
        build: () => t(coverSnapshot('night', 'playing').snapshot) }),
      S({ id: `album-snow-${theme}`, group: g, title: `专辑页 · 近白封面 · ${label}`, boot: { route: { name: 'album', albumId: 'album-pv-snow' } },
        build: () => t(coverSnapshot('snow', 'paused').snapshot) }),
      S({ id: `capsule-night-${theme}`, group: g, title: `播放胶囊 · 近黑封面 · ${label}`, boot: { scrollTop: 420 },
        build: () => t(coverSnapshot('night', 'playing').snapshot) }),
      S({ id: `mini-night-${theme}`, group: g, title: `迷你 · 近黑封面 · ${label}`, surface: 'mini', width: 384, height: 116, desktop: true,
        build: () => t(coverSnapshot('night', 'playing', { host: { shell: 'tauri', windowMode: 'mini' }, capabilities: { transparentWindow: true } }).snapshot) }),
      S({ id: `mini-snow-${theme}`, group: g, title: `迷你 · 近白封面 · ${label}`, surface: 'mini', width: 384, height: 116, desktop: true,
        build: () => t(coverSnapshot('snow', 'playing', { host: { shell: 'tauri', windowMode: 'mini' }, capabilities: { transparentWindow: true } }).snapshot) }),
    );
  }
  return out;
}

/**
 * R2.2: removing an album from the collection. The live demo (#/live) runs the real flow against
 * the DemoBridge; these frames hold each state of the confirmation still.
 */
function removal(): Scenario[] {
  const g = '从收藏移除';
  const at = (albumId: string, seed: Omit<NonNullable<UIBoot['removeAlbum']>, 'albumId'> = {}) =>
    ({ route: { name: 'album' as const, albumId }, removeAlbum: { albumId, ...seed } });
  /** Blue playing, with two tracks of another album queued after it. */
  const mixedQueue = () => {
    const { snapshot } = playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' });
    const ids = [...snapshot.library.albums.find(a => a.id === 'album-blue')!.trackIds, 'track-plain', 'track-missing'];
    const loaded = loadQueue(snapshot.player, ids, snapshot.library, 0, 'pvq');
    snapshot.player = { ...loaded, status: 'playing', positionMs: 64000, positionSampledAt: now(), sampleSequence: 1 };
    return snapshot;
  };
  const themed = (theme: ThemeName) => (snapshot: UISnapshot) => withTheme(snapshot, theme);
  return [
    S({ id: 'remove-playing', group: g, title: '确认：它正在播放', boot: at('album-blue'),
      note: '入口在专辑页“更多专辑操作 → 从收藏移除…”。确认框写明文件保留、资料会备份、播放会停止。',
      build: mixedQueue }),
    S({ id: 'remove-other', group: g, title: '确认：播放的是别的专辑，队列里有它', boot: at('album-white'), build: mixedQueue }),
    S({ id: 'remove-idle', group: g, title: '确认：没有在播放', boot: at('album-spring'), build: () => base().snapshot }),
    S({ id: 'remove-drafts', group: g, title: '确认：有未保存的修改会被放弃', boot: at('album-blue', { drafts: ['「窓辺の青」的歌词', '专辑与曲目资料'] }),
      build: () => playing({ trackId: 'track-blue', positionMs: 64000 }).snapshot }),
    S({ id: 'remove-missing', group: g, title: '确认：有曲目文件找不到', boot: at('album-blue'), build: () => base({ data: 'unavailable' }).snapshot }),
    S({ id: 'remove-conflict', group: g, title: '冲突：确认前收藏有了新的保存', boot: at('album-blue', { conflict: true }),
      note: '核心先发布最新快照再回 conflict：确认框显示最新内容，按钮改为“再次确认移除”，不会自动重试。',
      build: () => playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' }).snapshot }),
    S({ id: 'remove-error', group: g, title: '失败：就地显示，可重试或取消', boot: at('album-blue', { error: '备份没有写入成功，收藏没有改动。请检查磁盘空间后再试。' }),
      build: () => playing({ trackId: 'track-blue', positionMs: 64000 }).snapshot }),
    S({ id: 'remove-pending', group: g, title: '进行中', boot: at('album-blue', { pending: true }),
      build: () => playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' }).snapshot }),
    S({ id: 'remove-960', group: g, title: '960×600', width: 960, height: 600, boot: at('album-blue'), build: mixedQueue }),
    S({ id: 'remove-blue', group: g, title: '阿根廷蓝', boot: at('album-soda'),
      build: () => themed('blue')(playing({ trackId: 'track-soda', positionMs: 64000, status: 'playing' }).snapshot) }),
    S({ id: 'remove-charcoal', group: g, title: '灰黑', boot: at('album-blue'), build: () => themed('charcoal')(mixedQueue()) }),
    S({ id: 'remove-night-charcoal', group: g, title: '灰黑 · 近黑封面', boot: at('album-pv-night', { drafts: ['「零時の索引」的歌词'] }),
      build: () => themed('charcoal')(coverSnapshot('night', 'paused').snapshot) }),
    S({ id: 'remove-night-light', group: g, title: '纸白 · 近黑封面', boot: at('album-pv-night'),
      build: () => coverSnapshot('night', 'paused').snapshot }),
  ];
}

function lyricCandidates(): Scenario[] {
  const g = '歌词候选';
  /** The track's review, built the way the core builds it; `status` and `records` pick the state. */
  const withReview = (snapshot: UISnapshot, trackId: string, records: 'five' | 'many' | 'none' | 'sources' = 'five',
    status?: 'searching' | 'failed', query?: { title: string; artist: string }): UISnapshot => {
    const track = snapshot.library.tracks.find(t => t.id === trackId)!;
    const album = snapshot.library.albums.find(a => a.id === track.albumId)!;
    const doc = (snapshot.lyrics?.trackId === trackId ? snapshot.lyrics : null) ?? snapshot.lyricsEditor?.document ?? createDemoData().lyricsByTrack[trackId];
    const list = records === 'none' ? [] : records === 'many' ? manyRecords(track, album)
      : records === 'sources' ? multiSourceRecords(track, album) : candidateRecords(track, album);
    const review = reviewFor(track, album, doc, status ? [] : list, query);
    return { ...snapshot, lyricsReview: status === 'searching' ? { ...review, status: 'searching' }
      : status === 'failed' ? { ...review, status: 'failed', error: { code: 'network', message: '歌词服务暂时无法访问。' } } : review };
  };
  const notFound = (d: LyricsDocument) => ({ ...d, lookup: 'notFound' as const });
  /** "次のページへ" has no lyrics and the strict lookup found nothing; it is playing. */
  const missing = (status: UISnapshot['player']['status'] = 'playing') =>
    playing({ trackId: 'track-missing', positionMs: 40000, status, lyrics: notFound }).snapshot;
  const np = { route: { name: 'nowPlaying' as const }, nowPlayingTab: 'lyrics' as const };
  const at = (seed: NonNullable<UIBoot['lyricsReview']>) => ({ ...np, lyricsReview: seed });
  const themed = (theme: ThemeName) => (snapshot: UISnapshot) => withTheme(snapshot, theme);
  return [
    S({ id: 'lr-entry', group: g, title: '入口：自动查找没有命中', boot: np,
      note: '严格查找保持原样；没有命中时，主按钮改为“搜索其他版本”。歌词菜单里也有“搜索歌词候选…”。',
      build: () => missing('paused') }),
    S({ id: 'lr-searching', group: g, title: '搜索中', boot: np,
      note: '搜索词是核心实际使用的曲名与歌手，可以修改；修改只影响这次搜索，不改曲目资料。',
      build: () => withReview(missing(), 'track-missing', 'five', 'searching') }),
    S({ id: 'lr-ready', group: g, title: '候选：同一版本，跟随播放', boot: np,
      note: '正在播放这首时，同步候选按共享时钟高亮当前句，只在这里预览，不替换正在显示的歌词，也不改偏移。',
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-tv', group: g, title: '候选：TV Size（版本、专辑、时长不同）', boot: at({ candidateIndex: 3 }),
      note: '曲名里多出的版本标记会被标出；时间轴条一眼能看出它只有一半长。核心的提示原样列出。',
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-credit', group: g, title: '候选：署名不同、来自其他专辑', boot: at({ candidateIndex: 1 }),
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-movie', group: g, title: '候选：Movie Edit（来自另一个来源）', boot: at({ candidateIndex: 2 }),
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-plain', group: g, title: '候选：纯文本、来源没有时长', boot: at({ candidateIndex: 4 }),
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-existing', group: g, title: '已有歌词：只能在编辑器中导入', boot: at({ candidateIndex: 0 }),
      note: '这首已有同步歌词，候选不能直接替换；按钮会先打开编辑器，再导入草稿，由用户保存。',
      build: () => withReview(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' }).snapshot, 'track-blue') }),
    S({ id: 'lr-editor', group: g, title: '编辑器里：导入到编辑草稿', boot: { lyricsReview: { candidateIndex: 0 } },
      note: '从编辑器“导入 → 从在线候选导入…”打开。采用后进入草稿，沿用导入原文的规则，保存前不写入。',
      build: () => withReview(editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 64000 }), 'track-blue') }),
    S({ id: 'lr-other-track', group: g, title: '不是正在播放的曲目', boot: { lyricsReview: { candidateIndex: 0 } },
      note: '不会偷偷换曲；需要对照时由用户点“播放这首对照”。',
      build: () => withReview(editing({ trackId: 'track-missing', play: 'track-blue', positionMs: 64000 }), 'track-missing') }),
    S({ id: 'lr-many', group: g, title: '12 份候选（上限）', boot: np, build: () => withReview(missing(), 'track-missing', 'many') }),
    S({ id: 'lr-none', group: g, title: '没有找到候选', boot: np, build: () => withReview(missing(), 'track-missing', 'none') }),
    S({ id: 'lr-failed', group: g, title: '搜索失败', boot: np,
      note: '失败只说明这次没有完成，不等于库里没有这首；可以重试。',
      build: () => withReview(missing(), 'track-missing', 'five', 'failed') }),
    S({ id: 'lr-typed', group: g, title: '改了搜索词，还没搜索', boot: at({ query: { title: '次のページへ', artist: '' } }),
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-conflict', group: g, title: '采用被拒：候选过期或资料改了',
      boot: at({ failure: { code: 'conflict', message: '歌词候选已过期或资料已修改，请重新查找。' } }),
      note: '什么都没写入，草稿也不动；不拿旧候选自动重试，主按钮改为“重新搜索”。',
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-locked', group: g, title: '采用被拒：歌词已锁定',
      boot: at({ failure: { code: 'locked', message: '歌词已锁定。' } }),
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-960', group: g, title: '960×600', width: 960, height: 600, boot: at({ candidateIndex: 2 }),
      build: () => withReview(missing(), 'track-missing') }),
    S({ id: 'lr-blue', group: g, title: '阿根廷蓝', boot: at({ candidateIndex: 2 }),
      build: () => themed('blue')(withReview(missing(), 'track-missing')) }),
    S({ id: 'lr-charcoal', group: g, title: '灰黑', boot: at({ candidateIndex: 2 }),
      build: () => themed('charcoal')(withReview(missing(), 'track-missing')) }),
    S({ id: 'lr-charcoal-ready', group: g, title: '灰黑 · 跟随播放', boot: np,
      build: () => themed('charcoal')(withReview(missing(), 'track-missing')) }),

    // core.19: four sources, translations a source sent, a source that did not answer.
    S({ id: 'lr-sources', group: g, title: '四个来源 · 部分来源未完成', boot: np,
      note: '每份候选都有的提示（这里是 QQ 音乐部分查询未完成）在列表上方只说一次。带译文的候选有“带译文”标签。',
      build: () => withReview(missing(), 'track-missing', 'sources') }),
    S({ id: 'lr-bilingual', group: g, title: '候选译文：双语预览，跟随播放', boot: at({ bilingual: true }),
      note: '默认只看原文；来源附带译文时才出现“原文 / 双语”。只显示来源实际给出的译文，已按时间对应，仍需核对。',
      build: () => withReview(missing(), 'track-missing', 'sources') }),
    S({ id: 'lr-tr-partial', group: g, title: '候选译文：有两行没能配对、来源没有专辑和时长', boot: at({ bilingual: true, candidateIndex: 3 }),
      build: () => withReview(missing(), 'track-missing', 'sources') }),
    S({ id: 'lr-tr-none', group: g, title: '候选没有译文：不出现切换', boot: at({ bilingual: true, candidateIndex: 1 }),
      build: () => withReview(missing(), 'track-missing', 'sources') }),
    S({ id: 'lr-bilingual-blue', group: g, title: '阿根廷蓝 · 双语预览', boot: at({ bilingual: true }),
      build: () => themed('blue')(withReview(missing(), 'track-missing', 'sources')) }),
    S({ id: 'lr-bilingual-charcoal', group: g, title: '灰黑 · 双语预览', boot: at({ bilingual: true }),
      build: () => themed('charcoal')(withReview(missing(), 'track-missing', 'sources')) }),
    S({ id: 'lr-bilingual-960', group: g, title: '960×600 · 双语预览', width: 960, height: 600, boot: at({ bilingual: true }),
      build: () => withReview(missing(), 'track-missing', 'sources') }),
    S({ id: 'lr-import-tr', group: g, title: '导入后：候选的译文在草稿里直接可见',
      note: '编辑器打开着这首、草稿还是空的，导入一份带译文的候选：译文列自动打开，提示里写明有多少行带译文。',
      boot: importBoot('track-missing', 0),
      build: () => editing({ trackId: 'track-missing', play: 'track-missing', positionMs: 40000 }) }),
    S({ id: 'lr-import-mixed', group: g, title: '导入后：原有译文与候选译文',
      note: '草稿里原有的译文按时间对上的保留，没对上的行用候选自带的译文；提示里分别写出行数。',
      boot: importBoot('track-blue', 2),
      build: () => editing({ trackId: 'track-blue', play: 'track-blue', positionMs: 64000 }) }),
  ];
}

/**
 * The editor right after an online candidate was imported into its draft: the same applyImport the
 * editor runs on a pendingImport, applied to the opened draft, with the note it would show.
 */
function importBoot(trackId: string, recordIndex: number): UIBoot {
  const { snapshot } = base();
  const track = snapshot.library.tracks.find(t => t.id === trackId)!;
  const album = snapshot.library.albums.find(a => a.id === track.albumId)!;
  const record = multiSourceRecords(track, album)[recordIndex];
  const doc = record.document;
  const pending = { id: 'pv-import', content: 'original' as const, kind: doc.kind as 'synced' | 'plain', lines: doc.lines, language: doc.language, warnings: doc.warnings };
  const note = { message: '', warnings: [] as string[], canAlign: false };
  return { lyricsEditor: {
    edit: draft => { const outcome = applyImport(draft, pending); note.message = outcome.message; note.warnings = outcome.warnings; return outcome.draft; },
    get note() { return note; },
  } };
}

/**
 * Memorial theme (Claude, core.23): black glass and Claude's orange — black for Codex, orange for
 * Claude — which Codex makes the default for new collections. It is the ordinary charcoal theme
 * with this accent, so the other themes and the user's own colour work as before. Each place the
 * crystal transport appears, over the album light and over the extremes of a cover.
 */
export const MEMORIAL_ACCENT = '#DB7A3D';
/** ui.main.memorialPlates, as the settings switch writes it. */
function plates(snapshot: UISnapshot, on: boolean): UISnapshot {
  const patch = memorialPlatesPatch(on);
  return { ...snapshot, settings: { ...snapshot.settings, ui: { ...snapshot.settings.ui, main: { ...snapshot.settings.ui.main, ...patch.ui?.main } } } };
}

function memorial(): Scenario[] {
  const g = '黑橙纪念';
  const memo = (snapshot: UISnapshot): UISnapshot => {
    const themed = withTheme(snapshot, 'charcoal');
    return { ...themed, settings: { ...themed.settings, accentColor: MEMORIAL_ACCENT } };
  };
  const mini: BaseOptions = { host: { shell: 'tauri', windowMode: 'mini' }, capabilities: { transparentWindow: true, nativeWindows: true } };
  return [
    S({ id: 'memorial-library', group: g, title: '收藏舞台与播放条（播放中）',
      build: () => memo(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' }).snapshot) }),
    S({ id: 'memorial-paused', group: g, title: '收藏舞台与播放条（已暂停）',
      build: () => memo(playing({ trackId: 'track-blue', positionMs: 64000 }).snapshot) }),
    S({ id: 'memorial-np', group: g, title: '正在播放', boot: { route: { name: 'nowPlaying' } },
      build: () => memo(playing({ trackId: 'track-blue', positionMs: 79000, status: 'playing' }).snapshot) }),
    S({ id: 'memorial-album', group: g, title: '专辑页', boot: { route: { name: 'album', albumId: 'album-blue' } },
      build: () => memo(playing({ trackId: 'track-blue', positionMs: 64000 }).snapshot) }),
    S({ id: 'memorial-mini', group: g, title: '迷你', surface: 'mini', width: 384, height: 116, desktop: true,
      build: () => memo(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing', ...mini }).snapshot) }),
    S({ id: 'memorial-mini-paused', group: g, title: '迷你（已暂停）', surface: 'mini', width: 384, height: 116, desktop: true,
      build: () => memo(playing({ trackId: 'track-spring', positionMs: 20000, ...mini }).snapshot) }),
    S({ id: 'memorial-snow', group: g, title: '舞台 · 近白封面',
      build: () => memo(coverSnapshot('snow', 'paused').snapshot) }),
    S({ id: 'memorial-night', group: g, title: '舞台 · 近黑封面',
      build: () => memo(coverSnapshot('night', 'playing').snapshot) }),
    S({ id: 'memorial-capsule', group: g, title: '播放胶囊滚过书架', boot: { scrollTop: 420 },
      build: () => memo(coverSnapshot('snow', 'playing').snapshot) }),
    S({ id: 'memorial-instrumental', group: g, title: '纪念铭牌 · 纯音乐的歌词区', boot: { route: { name: 'nowPlaying' } },
      note: '曲目标记为纯音乐时，器材铭牌代替音符图标；舞台右下角的玻璃蚀刻在“收藏舞台”场景里。设置 → 外观 → 纪念铭牌可以关掉。',
      build: () => memo(playing({ trackId: 'track-sea-morning', positionMs: 40000, status: 'playing' }).snapshot) }),
    S({ id: 'memorial-plates-off', group: g, title: '纪念铭牌关闭（舞台）',
      build: () => plates(memo(playing({ trackId: 'track-blue', positionMs: 64000, status: 'playing' }).snapshot), false) }),
    S({ id: 'memorial-plates-off-np', group: g, title: '纪念铭牌关闭（纯音乐）', boot: { route: { name: 'nowPlaying' } },
      build: () => plates(memo(playing({ trackId: 'track-sea-morning', positionMs: 40000 }).snapshot), false) }),
  ];
}

/**
 * UI CONTRACT v0.4.0, 2026-10-04 (Asia/Tokyo).
 * Extends v0.3.0 with explicit lyric candidate previews and guarded adoption.
 * See docs/CONTRACT_LYRICS_CANDIDATES_ZH.md for the versioned UI handoff.
 * This is an integration baseline, not a shipped V1.0 player.
 * Times are milliseconds; snapshots are immutable. See docs/CONTRACT_BEHAVIOR_ZH.md.
 */
export const CONTRACT_VERSION = '0.4.0' as const;

export type Surface = 'main' | 'mini';
export type WindowMode = 'full' | 'mini';
export type LyricsMode = 'original' | 'bilingual';
export type RepeatMode = 'off' | 'all' | 'one';
export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'buffering' | 'error';
export type TranslationStatus = 'available' | 'partial' | 'missing';
export type LyricsKind = 'synced' | 'plain' | 'instrumental' | 'spoken' | 'missing';
export type VersionKind = 'full' | 'short' | 'live' | 'instrumental' | 'offVocal' | 'remix' | 'other';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface HostInfo {
  /** Tauri 2 is the preferred candidate; the UI remains independent of it. */
  shell: 'browser' | 'tauri' | 'other';
  windowMode: WindowMode;
  /** Specific to the receiving surface, not a global app visibility flag. */
  surfaceVisible: boolean;
  /** Actual effective material, including OS/performance fallback. */
  backdrop: 'none' | 'mica' | 'acrylic';
  alwaysOnTop: boolean;
  nativeCornerRadius: 0 | 8;
  effectiveReducedMotion: boolean;
  transparencyAllowed: boolean;
  coreStatus: 'ready' | 'unresponsive';
  capabilities: {
    nativeWindows: boolean;
    transparentWindow: boolean;
    windowDragging: boolean;
    alwaysOnTop: boolean;
  };
}

export interface AlbumEditableFields {
  title: string;
  albumArtists: string[];
  albumArtistCredit: string;
  workTitle: string | null;
  releaseYear: number | null;
  catalogNumber: string | null;
  label: string | null;
  language: string | null;
  titleSort: string | null;
  discs: { number: number; title?: string }[];
}
export interface TrackEditableFields {
  title: string;
  artists: string[];
  artistCredit: string;
  discNumber: number;
  trackNumber: number;
  language: string | null;
  versionKind: VersionKind | null;
  versionLabel: string | null;
}
export type AlbumEditableField = keyof AlbumEditableFields | 'cover';
export type TrackEditableField = keyof TrackEditableFields;

export interface CoverImage {
  /** Safe URLs supplied by the bridge; never paths constructed by the UI. */
  thumbUrl: string;
  fullUrl: string;
  width?: number;
  height?: number;
  dominantColor?: string;
}
export interface RipSummary {
  hasLog: boolean;
  hasCue: boolean;
  /** A log's existence is not evidence that AccurateRip verified the disc. */
  accurateRip: 'verified' | 'partial' | 'notVerified' | 'unknown';
  discs?: { number: number; hasLog: boolean; hasCue: boolean; discId?: string }[];
}
export interface Album extends AlbumEditableFields {
  id: string;
  revision: number;
  /** Authoritative disc/track order; display grouping does not mutate it. */
  trackIds: string[];
  cover: CoverImage | null;
  addedAt: number; // Unix epoch milliseconds, unlike performance.now().
  metadataStatus: 'matched' | 'partial' | 'unmatched';
  userEditedFields: AlbumEditableField[];
  musicBrainzReleaseId?: string;
  rip?: RipSummary;
}
export interface Track extends TrackEditableFields {
  id: string;
  albumId: string;
  revision: number;
  durationMs: number;
  available: boolean;
  userEditedFields: TrackEditableField[];
  musicBrainzRecordingId?: string;
  lyricsSummary?: {
    kind: LyricsKind;
    translation: TranslationStatus;
    revision: number;
  };
  /** Audio paths/handles stay in the core's private model, outside UI data. */
}
export interface LibrarySnapshot {
  revision: number;
  albums: Album[];
  tracks: Track[];
}
export interface QueueEntry {
  id: string; // Unique entry ID even if the same track is queued twice.
  trackId: string;
  originalOrder: number;
}
export interface PlaybackError {
  code: 'decode' | 'fileMissing' | 'device' | 'unknown';
  message: string;
  trackId?: string;
}
export interface PlayerSnapshot {
  status: PlaybackStatus;
  currentTrackId: string | null;
  currentEntryId: string | null;
  currentQueueIndex: number; // -1 when no entry is active.
  positionMs: number;
  durationMs: number;
  /** Receiving webview's monotonic time base, converted by its local bridge. */
  positionSampledAt: number;
  /** Increasing within an engine session; the bridge discards older samples. */
  sampleSequence: number;
  volume: number; // 0..1 UI slider; only the core applies a gain curve.
  muted: boolean;
  queue: QueueEntry[];
  repeat: RepeatMode;
  shuffle: boolean;
  error: PlaybackError | null;
}

export interface LyricLine {
  id: string;
  /** null = untimed. Negative normalized times are valid. */
  startMs: number | null;
  /** A timed empty/whitespace-only original is a break that clears highlighting. */
  original: string;
  translation?: string;
}
export interface LyricsSource {
  kind: 'manual' | 'embedded' | 'sidecar' | 'provider' | 'demo';
  name?: string;
  recordId?: string;
}
export interface LyricsDocument {
  trackId: string;
  /** Increments for persisted content, offset, classification or lock changes. */
  revision: number;
  kind: LyricsKind;
  lookup: 'idle' | 'searching' | 'notFound' | 'failed';
  lookupError: OperationError | null;
  language: string | null;
  translationLanguage: string | null;
  translationStatus: TranslationStatus;
  source: { original?: LyricsSource; translation?: LyricsSource };
  locked: boolean;
  /** User adjustment only: positive delays, negative advances display. */
  offsetMs: number;
  lines: LyricLine[];
  warnings: string[];
}
export interface LyricsEditorState {
  trackId: string;
  status: 'loading' | 'ready' | 'saving' | 'conflict' | 'failed';
  document: LyricsDocument | null;
  error: OperationError | null;
  pendingImport: LyricsPendingImport | null;
}
export interface LyricsEdit {
  kind: 'synced' | 'plain' | 'missing';
  language: string | null;
  translationLanguage: string | null;
  lines: LyricLine[];
  offsetMs: number;
  locked: boolean;
  // Provider provenance/translation status are derived by the core, not edited.
}

export type LyricsImportContent = 'original' | 'translation' | 'bilingual';
export interface LyricsPendingImport {
  id: string;
  content: LyricsImportContent;
  kind: 'synced' | 'plain';
  lines: LyricLine[];
  language: string | null;
  warnings: string[];
}
export interface LyricsParseOptions {
  language?: string | null;
  translationLanguage?: string | null;
  source?: LyricsSource;
  duplicateTimestampMode?: 'merge' | 'bilingual';
}
export interface LyricsPairingResult { lines: LyricLine[]; warnings: string[] }
export interface LyricsSerializeOptions { includeTranslation?: boolean }
export interface LyricsValidationIssue {
  lineId?: string;
  code: 'kind' | 'lines' | 'lineId' | 'duplicateId' | 'timestamp' | 'order' |
    'duplicateTimestamp' | 'plainTimestamp' | 'text' | 'orphanTranslation' |
    'offset' | 'language' | 'missingNotEmpty';
  message: string;
}

export interface UserSettings {
  lyricsMode: LyricsMode;
  accentColor: string; // #RRGGBB only.
  /** Both are light themes with dark text, as selected by the user. */
  background: 'light' | 'blue';
  fontScale: number;
  lyricsScale: number;
  glassIntensity: number;
  motion: 'system' | 'reduced' | 'full';
  showDiscAnimation: boolean;
  miniAlwaysOnTop: boolean;
  miniShowLyrics: boolean;
  /** Serializable UI preferences; the core merges keys per surface. */
  ui: Record<Surface, JsonObject>;
}
export type SettingsPatch = Partial<Omit<UserSettings, 'ui'>> & {
  ui?: Partial<Record<Surface, JsonObject>>;
};

export interface OperationError {
  code: 'invalidAction' | 'notFound' | 'fileMissing' | 'conflict' | 'locked' |
    'unsupported' | 'network' | 'io' | 'unavailable' | 'unknown';
  message: string;
}
export type ActionResult =
  | { ok: true; status: 'applied' | 'cancelled' }
  | { ok: true; status: 'started'; taskId: string }
  | { ok: false; code: OperationError['code']; message: string };
export interface Notice {
  id: string;
  tone: 'info' | 'warning' | 'error';
  message: string;
  action?: { label: string; action: UIAction };
}
export interface TaskInfo {
  id: string;
  kind: 'import' | 'scan' | 'metadata' | 'lyrics';
  status: 'queued' | 'running' | 'cancelling';
  label: string;
  progress?: number; // 0..1; omitted when indeterminate.
  cancellable: boolean;
  albumId?: string;
  trackId?: string;
}

export interface CoverPreview { thumbUrl: string; width?: number; height?: number }
export type MetadataChange = { id: string; userEdited: boolean } & (
  | { target: 'album'; albumId: string; field: Exclude<AlbumEditableField, 'cover'>; from: JsonValue; to: JsonValue }
  | { target: 'album'; albumId: string; field: 'cover'; from: CoverPreview | null; to: CoverPreview | null }
  | { target: 'track'; trackId: string; field: TrackEditableField; from: JsonValue; to: JsonValue }
);
export interface MetadataCandidate {
  id: string;
  provider: string;
  match: 'discId' | 'toc' | 'catalog' | 'text';
  title: string;
  albumArtistCredit: string;
  releaseYear?: number;
  catalogNumber?: string;
  discCount: number;
  trackCount: number;
  coverThumbUrl?: string;
  notes: string[];
  changes: MetadataChange[];
}
export interface MetadataReview {
  id: string;
  albumId: string;
  /** Prevents applying a preview after its source library data has changed. */
  baseLibraryRevision: number;
  status: 'searching' | 'ready' | 'noResults' | 'failed';
  candidates: MetadataCandidate[];
  error: OperationError | null;
}

export interface LyricsCandidate {
  id: string;
  provider: string;
  recordId: string;
  title: string;
  artistCredit: string;
  albumTitle: string;
  durationMs: number | null;
  /** Candidate duration minus local duration; null means unknown. */
  durationDeltaMs: number | null;
  match: 'close' | 'check';
  warnings: string[];
  /** Parsed preview only. Applying uses the core's private copy, never UI-supplied text. */
  document: LyricsDocument;
}
export interface LyricsReview {
  id: string;
  trackId: string;
  baseRevision: number;
  baseTrackRevision: number;
  baseAlbumRevision: number;
  query: { title: string; artist: string };
  status: 'searching' | 'ready' | 'noResults' | 'failed';
  candidates: LyricsCandidate[];
  error: OperationError | null;
}

export interface UISnapshot {
  contractVersion: typeof CONTRACT_VERSION;
  host: HostInfo;
  library: LibrarySnapshot;
  player: PlayerSnapshot;
  /** Current-track document. null is allowed only when no track or while loading. */
  lyrics: LyricsDocument | null;
  /** Main-window editor; no second editor is opened in the mini surface. */
  lyricsEditor: LyricsEditorState | null;
  metadataReview: MetadataReview | null;
  /** Explicit broad search; results are previews until the user chooses one. */
  lyricsReview: LyricsReview | null;
  settings: UserSettings;
  notices: Notice[];
  tasks: TaskInfo[];
}

export type UIAction =
  | { type: 'playAlbum'; albumId: string; startTrackId?: string; shuffle?: boolean }
  | { type: 'playTracks'; trackIds: string[]; startIndex: number }
  | { type: 'playQueueEntry'; entryId: string }
  | { type: 'enqueue'; trackIds: string[]; position: 'next' | 'end' }
  | { type: 'removeFromQueue'; entryId: string }
  | { type: 'moveQueueEntry'; entryId: string; toIndex: number }
  | { type: 'togglePlayback' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; positionMs: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'setMuted'; muted: boolean }
  | { type: 'setRepeat'; repeat: RepeatMode }
  | { type: 'setShuffle'; shuffle: boolean }
  | { type: 'setWindowMode'; mode: WindowMode }
  | { type: 'beginWindowDrag' }
  | { type: 'hideToTray' }
  | { type: 'reportUnsavedChanges'; surface: Surface; dirty: boolean }
  | { type: 'updateSettings'; patch: SettingsPatch }
  | { type: 'importFolder' }
  | { type: 'rescanLibrary' }
  /** Collection records only. The revision shown at confirmation guards the whole removal. */
  | { type: 'removeAlbum'; albumId: string; baseLibraryRevision: number }
  | { type: 'importLyrics'; trackId: string; content: LyricsImportContent; baseRevision?: number; destination?: 'document' | 'editorDraft' }
  | { type: 'openLyricsEditor'; trackId: string }
  | { type: 'closeLyricsEditor' }
  | { type: 'saveLyrics'; trackId: string; baseRevision: number; patch: LyricsEdit }
  | { type: 'setLyricsOffset'; trackId: string; baseRevision: number; offsetMs: number }
  | { type: 'setNoLyrics'; trackId: string; baseRevision: number; kind: 'instrumental' | 'spoken' | null }
  | { type: 'updateAlbum'; albumId: string; baseRevision: number; patch: Partial<AlbumEditableFields> }
  | { type: 'updateTrack'; trackId: string; baseRevision: number; patch: Partial<TrackEditableFields> }
  | { type: 'pickCoverImage'; albumId: string; baseRevision: number }
  | { type: 'lookupMetadata'; albumId: string }
  | { type: 'lookupLyrics'; trackId: string }
  | { type: 'searchLyricsCandidates'; trackId: string; query?: { title: string; artist: string } }
  | { type: 'applyLyricsCandidate'; trackId: string; reviewId: string; candidateId: string;
      destination?: 'document' | 'editorDraft' }
  | { type: 'closeLyricsReview' }
  | { type: 'applyMetadataCandidate'; albumId: string; reviewId: string; candidateId: string;
      changeIds: string[]; confirmedProtectedChangeIds: string[] }
  | { type: 'closeMetadataReview' }
  | { type: 'cancelTask'; taskId: string }
  | { type: 'dismissNotice'; noticeId: string };

export interface PlayerUIProps {
  snapshot: UISnapshot;
  surface: Surface;
  onAction: (action: UIAction) => Promise<ActionResult>;
}
export interface PlayerBridge {
  /** Cached immutable snapshot; unchanged objects retain their references. */
  getSnapshot(): UISnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(action: UIAction): Promise<ActionResult>;
  /** Disposes this surface connection only; never tears down the native player. */
  destroy(): void;
}

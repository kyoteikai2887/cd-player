import type {
  LibrarySnapshot,
  LyricsDocument,
  UserSettings,
  OperationError,
} from '../contracts/player.ts';

export interface LocalData {
  schemaVersion: 1;
  library: LibrarySnapshot;
  lyricsByTrack: Record<string, LyricsDocument>;
  archivedLyrics: Record<string, LyricsDocument>;
  settings: UserSettings;
  roots: string[];
  files: Record<string, { path: string; size: number; mtimeMs: number }>;
  covers: Record<string, { path: string; mime: string }>;
  /** Removed file identities -> committed library revision. Omitted in pre-v0.3 stores. */
  excludedTrackIds?: Record<string, number>;
  /** Full-file identity and original disc/track slots. Retained for removed files as well. */
  fileIdentities?: Record<string, FileIdentity>;
}
export interface FileIdentity {
  sha256: string;
  size: number;
  albumId: string;
  discNumber: number;
  trackNumber: number;
}
export type LocalView = Pick<
  LocalData,
  'library' | 'lyricsByTrack' | 'settings'
>;
export class LocalError extends Error {
  code: OperationError['code'];
  constructor(code: OperationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}
export const copy = <T>(value: T): T => structuredClone(value);

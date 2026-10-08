import type { LyricsDocument } from '../contracts/player.ts';
import { parseLyrics } from '../core/lyrics.ts';
import { createDemoLibrary } from './fixtures/library.ts';
import { createDemoLyrics } from './fixtures/lyrics.ts';
import { createDemoSettings } from './fixtures/settings.ts';
export { createDemoLibrary, createDemoLyrics, createDemoSettings };

export type DemoScenario = 'default' | 'empty' | 'large' | 'break' | 'locked' | 'unavailable' |
  'spoken' | 'plain' | 'missing' | 'partial' | 'instrumental' | 'disconnected' | 'transparent-mini' | 'opaque-mini';

/** Factories replace mutable singleton exports; the public file path stays unchanged. */
export function createDemoData(scenario: DemoScenario = 'default') {
  const library = createDemoLibrary(), lyricsByTrack = createDemoLyrics(), settings = createDemoSettings();
  if (scenario === 'empty') { library.albums = []; library.tracks = []; }
  if (scenario === 'locked') for (const document of Object.values(lyricsByTrack)) document.locked = true;
  if (scenario === 'unavailable') library.tracks[0].available = false;
  if (scenario === 'break') lyricsByTrack['track-blue'] = parseLyrics(
    '[00:00.000]青い空\n[00:02.000]\n[00:04.000]新しい朝', 'track-blue', { source: { kind: 'demo' }, language: 'ja' });
  if (scenario === 'large') {
    const templateAlbum = library.albums[0], templateTrack = library.tracks[0];
    library.albums = []; library.tracks = [];
    for (let albumIndex = 0; albumIndex < 20; albumIndex++) {
      const id = 'large-album-' + albumIndex;
      const album = { ...templateAlbum, id, title: '架空の音楽集 ' + (albumIndex + 1),
        albumArtists: [...templateAlbum.albumArtists], discs: [{ number: 1 }], userEditedFields: [],
        trackIds: [] as string[], cover: templateAlbum.cover ? { ...templateAlbum.cover } : null };
      for (let n = 0; n < 15; n++) {
        const trackId = id + '-track-' + n;
        album.trackIds.push(trackId);
        library.tracks.push({ ...templateTrack, id: trackId, albumId: id, title: '青い物語 ' + (n + 1),
          trackNumber: n + 1, artists: [...templateTrack.artists], userEditedFields: [] });
        lyricsByTrack[trackId] = parseLyrics('[00:00.000]新しいページ', trackId, { source: { kind: 'demo' } });
      }
      library.albums.push(album);
    }
  }
  for (const track of library.tracks) {
    const document: LyricsDocument | undefined = lyricsByTrack[track.id];
    if (document) track.lyricsSummary = { kind: document.kind, translation: document.translationStatus, revision: document.revision };
  }
  return { library, lyricsByTrack, settings };
}

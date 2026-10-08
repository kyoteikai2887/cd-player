import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseFile } from 'music-metadata';
import { createDemoData } from '../src/mock/fixtures.ts';
import { COVER_KINDS, coverUri } from '../preview/stageCovers.ts';
import { openLocalStore } from '../src/local/store.ts';
import { parseLyrics } from '../src/core/lyrics.ts';

// Manual QA, independent data/profile. All 300 tracks share one explicitly selected synthetic
// audio file. Optional user art is read only, never used as audio or copied into delivery ZIPs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok((args.length === 2 || args.length === 4) && args[0] === '--fixture' && path.isAbsolute(args[1]),
  'Usage: node scripts/ui-r2-2-smoke.mjs --fixture <absolute synthetic FLAC> [--cover-folder <read-only album folder>]');
if (args.length === 4) assert.ok(['--cover-folder', '--public-example'].includes(args[2]) && path.isAbsolute(args[3]));
const input = args[1], info = await stat(input);
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const originalFixtureHash = await digest(input);
let userArt = null, coverSource = null, originalCoverSourceHash = null;
if (args.length === 4 && args[2] === '--cover-folder') {
  const files = (await readdir(args[3])).filter(name => /\.(flac|mp3|wav)$/i.test(name)).sort();
  assert.ok(files.length, 'No audio file for read-only artwork check');
  coverSource = path.join(args[3], files[0]);
  originalCoverSourceHash = await digest(coverSource);
  const metadata = await parseFile(coverSource, { duration: false });
  const picture = metadata.common.picture?.[0];
  assert.ok(picture, 'No embedded cover');
  const uri = `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`;
  userArt = { cover: { thumbUrl: uri, fullUrl: uri }, title: metadata.common.album ?? '只读封面检查',
    artist: metadata.common.albumartist ?? metadata.common.artist ?? '封面检查' };
}
const workspace = path.join(root, '.cache', 'ui-r2-2-' + Date.now());
await mkdir(workspace, { recursive: true });
const directory = path.join(workspace, 'data'), report = path.join(workspace, 'report.json');
const demo = createDemoData('large');
const publicExampleText = args[2] === '--public-example' ? await readFile(args[3], 'utf8') : null;
const store = await openLocalStore(directory);
try {
  await store.transact(data => {
    data.library = demo.library; data.lyricsByTrack = demo.lyricsByTrack;
    data.settings = { ...demo.settings, background: 'blue', accentColor: '#6CACE4',
      glassIntensity: 0.65, motion: 'full' };
    data.library.albums.forEach((album, index) => {
      const kind = COVER_KINDS[index % COVER_KINDS.length];
      const uri = coverUri(kind);
      album.cover = { thumbUrl: uri, fullUrl: uri, width: 600, height: 600 };
      album.title = `磨砂检查 · ${kind} · ${index + 1}`;
      album.addedAt += index;
    });
    if (userArt) {
      const album = data.library.albums[0];
      album.cover = userArt.cover; album.title = userArt.title; album.albumArtistCredit = userArt.artist;
      album.addedAt = Date.now();
    }
    if (args[2] === '--public-example') {
      const example = JSON.parse(publicExampleText);
      assert.equal(example.reference, 'https://musicbrainz.org/doc/Cover_Art_Archive/API');
      data.library = { revision: 0, albums: [{ ...example.album, id: 'public-album', revision: 0, cover: null,
        catalogNumber: null, releaseYear: null, label: null, userEditedFields: [], trackIds: example.tracks.map(t => t.id) }],
        tracks: example.tracks.map(t => ({ ...t, albumId: 'public-album', revision: 0, userEditedFields: [] })) };
      data.lyricsByTrack = Object.fromEntries(data.library.tracks.map(t => [t.id, { ...parseLyrics('', t.id), locked: false }]));
    }
    for (const track of data.library.tracks) {
      if (args[2] !== '--public-example') track.durationMs = 600000;
      data.files[track.id] = { path: input, size: info.size, mtimeMs: info.mtimeMs };
    }
  });
} finally { await store.close(); }
const expectedAlbums = store.view().library.albums.length, expectedTracks = store.view().library.tracks.length;
const child = spawn(path.join(root, 'src-tauri/target/debug/cd-player-desktop.exe'),
  ['--smoke-data', directory, '--smoke-report', report, '--smoke-manual'],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
await writeFile(path.join(workspace, 'session.json'), JSON.stringify({ pid: child.pid, directory, report,
  stop: report.replace(/\.json$/, '.stop'), uiRound: 'R2.2',
  version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  albums: expectedAlbums, tracks: expectedTracks, playbackInitiallyStopped: true, realAudioUsed: false,
  userCoverReadOnly: !!userArt, defaultUserDataModified: false,
  syntheticFileSHA256: originalFixtureHash, userCoverSourceSHA256: originalCoverSourceHash }, null, 2));
console.log(JSON.stringify({ workspace, pid: child.pid, stop: report.replace(/\.json$/, '.stop') }));
const exit = await completed;
assert.equal(exit, 0, 'Native manual QA did not exit successfully');
const result = JSON.parse(await readFile(report, 'utf8'));
assert.equal(result.passed, true);
assert.equal(result.libraryAlbums, expectedAlbums); assert.equal(result.libraryTracks, expectedTracks);
const reopened = await openLocalStore(directory);
try { assert.equal(reopened.view().library.tracks.length, expectedTracks); } finally { await reopened.close(); }
assert.equal(await digest(input), originalFixtureHash);
if (coverSource) assert.equal(await digest(coverSource), originalCoverSourceHash);
await writeFile(path.join(workspace, 'source-preservation.json'), JSON.stringify({
  syntheticFileSHA256: originalFixtureHash, syntheticFileUnchanged: true,
  userCoverSourceSHA256: originalCoverSourceHash, userCoverSourceUnchanged: coverSource ? true : null,
  userCoverReadOnly: !!userArt, realAudioUsed: false, defaultUserDataModified: false }, null, 2));
console.log(JSON.stringify({ report, passed: true, exit, storeReopened: true, sourceHashesUnchanged: true }));
